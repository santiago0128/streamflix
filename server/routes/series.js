const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const { sql, getPool } = require('../db');

const router = express.Router();
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Los CDN de los que salen los episodios importados no mandan CORS, así que el
// video se sirve por este proxy. Para HLS no basta con el playlist: sus
// variantes y segmentos también tienen que pasar por aquí, y se referencian con
// una firma para que el endpoint no quede como proxy abierto a cualquier URL.
const STREAM_PROXY_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

// El Referer entra en la firma porque viaja en la propia URL del sub-recurso:
// si no se firmara, cualquiera podría cambiarlo a voluntad. Va ahí y no se
// recalcula por petición para que los segmentos salgan con el mismo Referer que
// el playlist del que cuelgan; recalcularlo daba a veces el de otro servidor (o
// el de otro idioma), y hay CDN que responden 403 a eso.
function signStreamUrl(url, referer = '') {
  return crypto.createHmac('sha256', STREAM_PROXY_SECRET)
    .update(`${url}\n${referer || ''}`)
    .digest('hex')
    .slice(0, 32);
}

function isValidStreamSignature(url, referer, signature) {
  const expected = Buffer.from(signStreamUrl(url, referer));
  const received = Buffer.from(String(signature || ''));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function buildSubResourceUrl(episodeId, absoluteUrl, referer) {
  const params = new URLSearchParams();
  params.set('u', Buffer.from(absoluteUrl, 'utf8').toString('base64url'));
  if (referer) params.set('r', Buffer.from(referer, 'utf8').toString('base64url'));
  params.set('sig', signStreamUrl(absoluteUrl, referer));
  return `/api/episodes/${episodeId}/stream?${params.toString()}`;
}

// La extensión de la URL no basta: un CDN que responde 403 con una página HTML
// la sirve igual desde una ruta .m3u8, y reescribirla produce un playlist de
// basura que el reproductor no sabe interpretar. Manda el contenido real.
function isPlaylistResponse(contentType, body) {
  if (/mpegurl/i.test(contentType || '')) return true;
  return body.slice(0, 64).toString('utf8').trimStart().startsWith('#EXTM3U');
}

// Algunos CDN entregan los segmentos disfrazados de imagen: mandan una cabecera
// PNG y detrás el MPEG-TS real. hls.js no sabe destaparlo, así que se hace aquí.
function isDisguisedSegment(contentType) {
  return /^image\//i.test(contentType || '');
}

function looksLikeTransportStream(buffer, offset) {
  return (
    buffer.length > offset + 564 &&
    buffer[offset] === 0x47 &&
    buffer[offset + 188] === 0x47 &&
    buffer[offset + 376] === 0x47 &&
    buffer[offset + 564] === 0x47
  );
}

function unwrapSegment(buffer) {
  if (looksLikeTransportStream(buffer, 0)) {
    return buffer;
  }

  // Caso conocido: PNG completo delante del stream, que termina en IEND.
  const iend = buffer.indexOf('IEND');
  if (iend > 0 && looksLikeTransportStream(buffer, iend + 8)) {
    return buffer.subarray(iend + 8);
  }

  // Cualquier otro relleno: se busca el primer punto alineado con el TS.
  for (let offset = 0; offset < Math.min(buffer.length, 8192); offset += 1) {
    if (looksLikeTransportStream(buffer, offset)) {
      return buffer.subarray(offset);
    }
  }

  return buffer;
}

// Caché de playlists ya reescritos. Son pequeños (unas decenas de KB) y no
// cambian mientras el token de la URL siga vivo, así que el TTL corto solo está
// para que la memoria no crezca sin fin, no por miedo a servir algo caducado:
// cuando el token cambia, la URL de origen cambia y con ella la clave.
const PLAYLIST_TTL_MS = 5 * 60 * 1000;
const PLAYLIST_CACHE_MAX = 200;
const playlistCache = new Map();

function leerPlaylist(sourceUrl) {
  const hit = playlistCache.get(sourceUrl);
  if (!hit) return null;
  if (Date.now() > hit.expiraEn) {
    playlistCache.delete(sourceUrl);
    return null;
  }
  return hit;
}

function guardarPlaylist(sourceUrl, body, contentType) {
  // Map conserva el orden de inserción, así que el primero es el más viejo.
  if (playlistCache.size >= PLAYLIST_CACHE_MAX) {
    playlistCache.delete(playlistCache.keys().next().value);
  }
  playlistCache.set(sourceUrl, {
    body,
    contentType: contentType || 'application/vnd.apple.mpegurl',
    expiraEn: Date.now() + PLAYLIST_TTL_MS
  });
}

// Caché de la resolución de la fuente, que es con diferencia lo más caro del
// reproductor: consultar snapshots, sondear cada candidato contra el CDN y, si
// los enlaces guardados caducaron, rascar la página del embed con su
// proof-of-work. Antes se rehacía en cada petición; ahora la ficha, /playback y
// /stream comparten el mismo resultado. El TTL corto va acompasado con el de los
// playlists: los enlaces llevan token y duran horas, no minutos.
const RESOLUTION_TTL_MS = 5 * 60 * 1000;
const RESOLUTION_CACHE_MAX = 200;
const resolutionCache = new Map();

const claveResolucion = (episodeId, audio) => `${episodeId}|${audio || ''}`;

function leerResolucion(episodeId, audio) {
  const clave = claveResolucion(episodeId, audio);
  const hit = resolutionCache.get(clave);
  if (!hit) return null;
  if (Date.now() > hit.expiraEn) {
    resolutionCache.delete(clave);
    return null;
  }
  return hit.fuente;
}

function guardarResolucion(episodeId, audio, fuente) {
  if (!fuente || !fuente.url) return fuente;
  if (resolutionCache.size >= RESOLUTION_CACHE_MAX) {
    resolutionCache.delete(resolutionCache.keys().next().value);
  }
  resolutionCache.set(claveResolucion(episodeId, audio), {
    fuente,
    expiraEn: Date.now() + RESOLUTION_TTL_MS
  });
  return fuente;
}

function olvidarResolucion(episodeId, audio) {
  resolutionCache.delete(claveResolucion(episodeId, audio));
}

// Reescribe el playlist para que todo lo que cuelga de él vuelva por el proxy.
function rewritePlaylist(body, baseUrl, episodeId, referer) {
  const toProxy = (rawUrl) => {
    try {
      return buildSubResourceUrl(episodeId, new URL(rawUrl, baseUrl).toString(), referer);
    } catch {
      return rawUrl;
    }
  };

  return body
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        // Claves, pistas de audio y mapas de inicialización van en URI="...".
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${toProxy(uri)}"`);
      }

      return toProxy(trimmed);
    })
    .join('\n');
}

function getHttpClient(url) {
  return url.startsWith('https:') ? https : http;
}

function normalizeUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

function decodeBase64ToBuffer(value) {
  return Buffer.from(String(value || ''), 'base64');
}

function matchOne(text, pattern) {
  const match = pattern.exec(text || '');
  return match ? String(match[1] || '').trim() : null;
}

function isRedirectStatus(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function normalizeSourceRef(sourceRef) {
  if (!sourceRef) return null;
  return String(sourceRef).replace(/^jkanime:/i, '');
}

function buildPlaybackUrl(_req, episodeId, options = {}) {
  const params = new URLSearchParams();
  if (options.audio) params.set('audio', options.audio);
  const qs = params.toString();
  return `/api/episodes/${episodeId}/stream${qs ? `?${qs}` : ''}`;
}

const UPSTREAM_TIMEOUT_MS = 5000;

function looksLikeDirectVideoUrl(url) {
  return /\.(m3u8|mp4|webm|mov)(?:$|\?)/i.test(String(url || ''));
}

function inferProviderFromVideo(url, contentType, fallback = 'file') {
  if (/mpegurl/i.test(contentType || '') || /\.m3u8(?:$|\?)/i.test(String(url || ''))) {
    return 'hls';
  }

  if (/^video\//i.test(contentType || '') || /\.(mp4|webm|mov)(?:$|\?)/i.test(String(url || ''))) {
    return 'file';
  }

  return fallback;
}

function requestUpstream(url, headers = {}, redirectCount = 0) {
  if (redirectCount > 8) {
    return Promise.reject(new Error(`Demasiadas redirecciones para ${url}`));
  }

  return new Promise((resolve, reject) => {
    const client = getHttpClient(url);
    const upstream = client.request(
      url,
      {
        method: 'GET',
        headers
      },
      (response) => {
        // Las cabeceras ya llegaron: el tiempo de espera era para conectar, no
        // para transmitir. Dejarlo activo durante el cuerpo cortaba el vídeo a
        // media descarga: cuando el navegador llena su buffer deja de leer, la
        // contrapresión llega hasta este socket, se queda quieto y a los 5 s se
        // destruía la conexión. Quien manda a partir de aquí es el cliente, y de
        // que se marche ya se encarga el `req.on('close')` de la ruta.
        upstream.setTimeout(0);
        if (upstream.socket) upstream.socket.setTimeout(0);

        if (response.statusCode && isRedirectStatus(response.statusCode) && response.headers.location) {
          const redirectedUrl = new URL(response.headers.location, url).toString();
          response.resume();
          requestUpstream(redirectedUrl, headers, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        resolve({ response, finalUrl: url });
      }
    );

    upstream.on('error', reject);
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`Timeout consultando ${url}`));
    });
    upstream.end();
  });
}

/** Lee una respuesta entera en memoria. Solo para playlists y segmentos. */
function leerCuerpo(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('error', reject);
    response.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function requestText(url, headers = {}, redirectCount = 0) {
  if (redirectCount > 8) {
    return Promise.reject(new Error(`Demasiadas redirecciones para ${url}`));
  }

  return new Promise((resolve, reject) => {
    const client = getHttpClient(url);
    const upstream = client.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          ...headers
        }
      },
      (response) => {
        if (response.statusCode && isRedirectStatus(response.statusCode) && response.headers.location) {
          const redirectedUrl = normalizeUrl(response.headers.location, url);
          response.resume();

          if (!redirectedUrl) {
            reject(new Error(`No pude resolver la redirección de ${url}`));
            return;
          }

          requestText(redirectedUrl, headers, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({
            url,
            finalUrl: url,
            statusCode: response.statusCode || null,
            headers: response.headers,
            body
          });
        });
      }
    );

    upstream.on('error', reject);
    upstream.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
      upstream.destroy(new Error(`Timeout leyendo ${url}`));
    });
    upstream.end();
  });
}

function isVideoContentType(contentType) {
  if (!contentType) {
    return false;
  }

  return /^video\//i.test(contentType)
    || /^application\/octet-stream/i.test(contentType)
    || /^application\/vnd\.apple\.mpegurl/i.test(contentType)
    || /^application\/x-mpegurl/i.test(contentType);
}

async function probeVideoUrl(url, extraHeaders = {}) {
  if (!url) {
    return null;
  }

  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) {
    return null;
  }

  const probes = [
    { method: 'HEAD', headers: { Accept: '*/*', ...extraHeaders } },
    { method: 'GET', headers: { Accept: '*/*', Range: 'bytes=0-1', ...extraHeaders } }
  ];

  for (const probe of probes) {
    try {
      const client = getHttpClient(normalizedUrl);
      const result = await new Promise((resolve, reject) => {
        const req = client.request(
          normalizedUrl,
          {
            method: probe.method,
            headers: {
              'User-Agent': USER_AGENT,
              ...probe.headers
            }
          },
          (response) => {
            if (response.statusCode && isRedirectStatus(response.statusCode) && response.headers.location) {
              response.resume();
              resolve({ redirect: normalizeUrl(response.headers.location, normalizedUrl) });
              return;
            }

            const contentType = response.headers['content-type'] || '';
            if ((response.statusCode === 200 || response.statusCode === 206) && isVideoContentType(contentType)) {
              resolve({
                ok: true,
                url: normalizedUrl,
                statusCode: response.statusCode,
                contentType
              });
              response.resume();
              return;
            }

            response.resume();
            resolve({ ok: false });
          }
        );

        req.on('error', reject);
        req.setTimeout(UPSTREAM_TIMEOUT_MS, () => {
          req.destroy(new Error(`Timeout validando ${normalizedUrl}`));
        });
        req.end();
      });

      if (result?.redirect) {
        const redirected = await probeVideoUrl(result.redirect, extraHeaders);
        if (redirected) return redirected;
      }

      if (result?.ok) {
        return result;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMediaUrlsFromHtml(html, pageUrl) {
  const candidates = [];
  const seen = new Set();
  const patterns = [
    /player\.src\(\s*\{\s*type:\s*"video\/[^"]+"\s*,\s*src:\s*"([^"]+)"/gi,
    /file:\s*"([^"]+\.(?:mp4|webm|m3u8|mov)(?:\?[^"]*)?)"/gi,
    /sources?\s*:\s*\[\s*\{\s*file:\s*"([^"]+)"/gi,
    /<source[^>]+src="([^"]+)"/gi,
    /https?:\/\/[^"'\\\s]+?\.(?:mp4|webm|m3u8|mov)(?:\?[^"'\\\s]*)?/gi
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const rawValue = match[1] || match[0];
      const candidate = normalizeUrl(decodeHtml(rawValue), pageUrl);
      if (!candidate) continue;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }

  return candidates;
}

function unpackPackedScript(source) {
  const match = source.match(
    /eval\(function\(p,a,c,k,e,[dr]\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/s
  );

  if (!match) {
    return null;
  }

  const payload = match[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  const radix = Number(match[2]);
  const count = Number(match[3]);
  const dictionary = match[4].split('|');

  const encode = (value) =>
    (value < radix ? '' : encode(Math.floor(value / radix))) +
    ((value = value % radix) > 35 ? String.fromCharCode(value + 29) : value.toString(36));

  let unpacked = payload;
  for (let i = count - 1; i >= 0; i -= 1) {
    if (dictionary[i]) {
      unpacked = unpacked.replace(new RegExp(`\\b${encode(i)}\\b`, 'g'), dictionary[i]);
    }
  }

  return unpacked;
}

function extractPlayerMediaUrls(html, pageUrl) {
  const unpacked = unpackPackedScript(html);
  const urls = [];

  if (unpacked) {
    const linksBlock = unpacked.match(/var\s+links\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (linksBlock) {
      try {
        const links = JSON.parse(linksBlock[1]);
        for (const key of ['hls4', 'hls3', 'hls2', 'hls', 'mp4']) {
          if (links[key]) urls.push(links[key]);
        }
      } catch {
        // Si el bloque no es JSON válido, se cae a los patrones de abajo.
      }
    }

    for (const match of unpacked.matchAll(/(?:file|src)\s*:\s*"([^"]+)"/g)) {
      urls.push(match[1]);
    }
    urls.push(...extractMediaUrlsFromHtml(unpacked, pageUrl));
  }

  urls.push(...extractMediaUrlsFromHtml(html, pageUrl));

  const seen = new Set();
  return urls
    .map((url) => normalizeUrl(url, pageUrl))
    .filter((url) => {
      if (!url || !/\.(m3u8|mp4|webm|mov)(?:$|\?)/i.test(url) || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

const POW_MAX_NONCE = 2_000_000;
// Ceder el turno cada pocos miles de intentos cuesta un ~1 % del tiempo total
// del bucle y a cambio deja el servidor respondiendo mientras tanto.
const POW_YIELD_EVERY = 4096;

/**
 * Resuelve el proof-of-work de embed69.
 *
 * Node tiene un solo hilo, así que este bucle no es "lento": es el event loop
 * congelado. Medido, con dificultad 5 son ~700 ms y en el tope del contador
 * ~1,3 s en los que no avanza ningún otro segmento en vuelo, ni el de este
 * usuario ni el de nadie. De ahí que ceda cada POW_YIELD_EVERY intentos.
 */
async function resolveProofOfWork(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);

  for (let nonce = 0; nonce < POW_MAX_NONCE; nonce += 1) {
    if (crypto.createHash('sha256').update(challenge + nonce).digest('hex').startsWith(prefix)) {
      return nonce;
    }
    if (nonce % POW_YIELD_EVERY === POW_YIELD_EVERY - 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return null;
}

async function extractEmbed69Links(html, pageUrl) {
  const dataLinkJson = matchOne(html, /let\s+dataLink\s*=\s*(\[[\s\S]*?\]);/i);
  const challenge = matchOne(html, /const\s+POW_CHALLENGE\s*=\s*'([^']+)'/i);
  const difficulty = Number(matchOne(html, /const\s+POW_DIFFICULTY\s*=\s*(\d+)/i) || 0);
  const salt = matchOne(html, /const\s+POW_SALT\s*=\s*'([^']+)'/i);

  if (!dataLinkJson || !challenge || !difficulty || !salt) {
    return [];
  }

  let dataLink;
  try {
    dataLink = JSON.parse(dataLinkJson);
  } catch {
    return [];
  }

  const nonce = await resolveProofOfWork(challenge, difficulty);
  if (nonce == null) {
    return [];
  }

  const aesKey = crypto.createHash('sha256').update(challenge + nonce + salt).digest().subarray(0, 32);
  const urls = [];
  const seen = new Set();

  const decrypt = (encryptedBase64) => {
    try {
      const raw = decodeBase64ToBuffer(encryptedBase64);
      const iv = raw.subarray(0, 16);
      const ciphertext = raw.subarray(16);
      const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8').trim();
      return normalizeUrl(plaintext, pageUrl);
    } catch {
      return null;
    }
  };

  for (const file of Array.isArray(dataLink) ? dataLink : []) {
    for (const group of [file?.sortedEmbeds, file?.downloadEmbeds]) {
      for (const entry of Array.isArray(group) ? group : []) {
        const decrypted = decrypt(entry?.link);
        if (!decrypted || seen.has(decrypted)) continue;
        seen.add(decrypted);
        urls.push(decrypted);
      }
    }
  }

  return urls;
}

async function fetchPlayerMediaUrls(embedUrl, pageUrl) {
  const attempts = [{ Accept: 'text/html,application/xhtml+xml', Referer: pageUrl }, { Accept: 'text/html,application/xhtml+xml' }];

  for (const headers of attempts) {
    const response = await requestText(embedUrl, headers);
    const embed69Links = await extractEmbed69Links(response.body, embedUrl);
    if (embed69Links.length) return embed69Links;
    const urls = extractPlayerMediaUrls(response.body, embedUrl);
    if (urls.length) return urls;
  }

  return [];
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function asSnapshotList(snapshotOrList) {
  if (Array.isArray(snapshotOrList)) {
    return snapshotOrList.filter(Boolean);
  }
  return snapshotOrList ? [snapshotOrList] : [];
}

function parsePlayerOptions(snapshotOrList) {
  return asSnapshotList(snapshotOrList).flatMap((snapshot) => [
    ...parseJsonArray(snapshot?.PlayerOptionsJson),
    ...parseJsonArray(snapshot?.LocalPlayerOptionsJson)
  ]);
}

function parseServerOptions(snapshotOrList) {
  return asSnapshotList(snapshotOrList).flatMap((snapshot) => parseJsonArray(snapshot?.ServerOptionsJson));
}

function normalizeAudioCode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;

  if (raw === '1') return 'ja';
  if (raw === '3') return 'es-la';

  if (['es-la', 'lat', 'la', 'latin', 'latino', 'dob', 'dub'].includes(raw)) {
    return 'es-la';
  }

  if (['es-es', 'cast', 'castellano'].includes(raw)) {
    return 'es-es';
  }

  if (['es', 'esp', 'spanish'].includes(raw)) {
    return 'es';
  }

  if (['ja', 'jp', 'jpn', 'jap', 'japanese', 'sub', 'subbed', 'vo', 'original'].includes(raw)) {
    return 'ja';
  }

  return raw;
}

function labelForAudio(code) {
  switch (normalizeAudioCode(code)) {
    case 'es-la': return 'Latino';
    case 'es-es': return 'Castellano';
    case 'es': return 'Español';
    case 'ja': return 'Japonés';
    default: return 'Original';
  }
}

function audioPreferenceFromReq(req) {
  return normalizeAudioCode(req?.query?.audio);
}

function collectAudioOptions(snapshot) {
  const seen = new Set();
  return [
    ...parseServerOptions(snapshot).map((option) =>
      normalizeAudioCode(option?.languageCode || option?.lang || option?.language)
    ),
    ...parsePlayerOptions(snapshot).map((option) =>
      normalizeAudioCode(option?.languageCode || option?.lang || option?.language)
    )
  ]
    .filter((code) => {
      if (!code || seen.has(code)) return false;
      seen.add(code);
      return true;
    })
    .map((code) => ({ code, label: labelForAudio(code) }))
    .sort((a, b) => {
      const order = { ja: 0, 'es-la': 1, 'es-es': 2, es: 3 };
      return (order[a.code] ?? 99) - (order[b.code] ?? 99);
    });
}

function serverPriority(option) {
  const name = String(option?.server || '').toLowerCase();
  if (name.includes('vidhide')) return 0;
  if (name.includes('streamwish')) return 1;
  if (name.includes('voe')) return 2;
  if (name.includes('mixdrop')) return 3;
  if (name.includes('mega')) return 4;
  if (name.includes('mediafire')) return 5;
  if (name.includes('mp4upload')) return 6;
  if (name.includes('dood')) return 7;
  if (name.includes('streamtape')) return 8;
  return 50;
}

function serverOptionsForAudio(snapshot, preferredAudio = null) {
  const options = parseServerOptions(snapshot)
    .filter((option) => !preferredAudio ||
      normalizeAudioCode(option?.languageCode || option?.lang || option?.language) === preferredAudio
    )
    .sort((a, b) => serverPriority(a) - serverPriority(b));

  return options;
}

function collectEmbedCandidates(snapshot, episode, preferredAudio = null) {
  const urls = [];

  for (const option of serverOptionsForAudio(snapshot, preferredAudio)) {
    urls.push(option?.generatedEmbedUrl);
  }

  for (const option of parsePlayerOptions(snapshot)) {
    const language = normalizeAudioCode(option?.languageCode || option?.lang || option?.language);
    if (preferredAudio && language && language !== preferredAudio) continue;
    urls.push(option?.embedUrl, option?.url, option?.playerUrl);
  }

  if (!preferredAudio) {
    for (const item of asSnapshotList(snapshot)) {
      urls.push(
        item?.VideoSrcReferer,
        item?.VerifiedVideoReferer,
        item?.PrimaryVideoUrl
      );
    }
    urls.push(
      episode?.VideoUrl
    );
  }

  const seen = new Set();
  return urls
    .map((url) => normalizeUrl(url))
    .filter((url) => {
      if (!url || looksLikeDirectVideoUrl(url) || seen.has(url)) return false;
      seen.add(url);
      return /^https?:/i.test(url);
    });
}

function collectDirectVideoCandidates(snapshot, episode, preferredAudio = null) {
  const candidates = [
    ...serverOptionsForAudio(snapshot, preferredAudio).map((option) => ({
      url: option?.decodedRemoteUrl,
      referer: option?.generatedEmbedUrl
    }))
  ];

  for (const item of asSnapshotList(snapshot)) {
    candidates.push(
      { url: item?.VideoSrcUrl, referer: item?.VideoSrcReferer },
      { url: item?.VerifiedVideoUrl, referer: item?.VerifiedVideoReferer },
      { url: item?.PrimaryVideoUrl, referer: item?.VerifiedVideoReferer || item?.VideoSrcReferer }
    );
  }

  if (!preferredAudio) {
    candidates.push({ url: episode?.VideoUrl, referer: null });
  }

  const seen = new Set();
  return candidates
    .map((candidate) => ({
      url: normalizeUrl(candidate.url),
      referer: normalizeUrl(candidate.referer)
    }))
    .filter((candidate) => {
      if (!candidate.url || candidate.url === 'NO_VIDEO_FOUND') return false;
      if (!looksLikeDirectVideoUrl(candidate.url)) return false;
      const key = `${candidate.url}|${candidate.referer || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function resolveDirectVideoCandidate(snapshot, episode, preferredAudio = null) {
  for (const candidate of collectDirectVideoCandidates(snapshot, episode, preferredAudio)) {
    const verified = await probeVideoUrl(
      candidate.url,
      candidate.referer ? { Referer: candidate.referer } : {}
    );

    if (verified) {
      return {
        url: verified.url,
        referer: candidate.referer,
        contentType: verified.contentType,
        provider: inferProviderFromVideo(verified.url, verified.contentType)
      };
    }
  }

  return null;
}

async function refreshVideoSourceFromSnapshot(snapshot, preferredAudio = null) {
  const embedCandidates = collectEmbedCandidates(snapshot, null, preferredAudio);

  for (const embedUrl of embedCandidates) {
    try {
      const referer = asSnapshotList(snapshot).find((item) =>
        item?.EpisodePageUrl || item?.SeriesUrl
      );
      const resolved = await resolvePlayableUrl(embedUrl, referer?.EpisodePageUrl || referer?.SeriesUrl || embedUrl);
      if (resolved) return resolved;
    } catch {
      continue;
    }
  }

  return null;
}

async function resolvePlayableUrl(candidateUrl, referer, seen = new Set(), depth = 0) {
  const normalizedCandidate = normalizeUrl(candidateUrl, referer);
  if (!normalizedCandidate || seen.has(normalizedCandidate) || depth > 3) {
    return null;
  }
  seen.add(normalizedCandidate);

  const verified = await probeVideoUrl(
    normalizedCandidate,
    referer ? { Referer: referer } : {}
  );
  if (verified) {
    return {
      url: verified.url,
      referer,
      contentType: verified.contentType,
      provider: inferProviderFromVideo(verified.url, verified.contentType)
    };
  }

  const extractedUrls = await fetchPlayerMediaUrls(normalizedCandidate, referer || normalizedCandidate);
  for (const extractedUrl of extractedUrls) {
    const resolved = await resolvePlayableUrl(extractedUrl, normalizedCandidate, seen, depth + 1);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function fallbackEmbedUrl(snapshot, episode, preferredAudio = null) {
  return collectEmbedCandidates(snapshot, episode, preferredAudio)[0] || null;
}

async function resolveEpisodePlayback(req, pool, episode, providedSnapshot = undefined) {
  const snapshot = providedSnapshot === undefined ? await findEpisodeSnapshot(pool, episode) : providedSnapshot;
  const audioOptions = collectAudioOptions(snapshot);
  const requestedAudio = audioPreferenceFromReq(req);
  const selectedAudio = audioOptions.find((option) => option.code === requestedAudio)?.code
    || (audioOptions[0] && audioOptions[0].code)
    || null;
  const comoRespuesta = (fuente, refreshed) => ({
    provider: fuente.provider || 'file',
    url: buildPlaybackUrl(req, episode.Id, { audio: selectedAudio }),
    proxied: true,
    sourceUrl: fuente.url,
    referer: fuente.referer,
    contentType: fuente.contentType,
    refreshed,
    canTrackProgress: true,
    audio: selectedAudio,
    audioOptions
  });

  // Abrir la ficha de un anime ya resuelve la reproducción para saber qué
  // idiomas hay, y al darle a reproducir se resolvía otra vez, y una tercera al
  // pedir el manifiesto. Eran tres scrapings completos antes del primer
  // fotograma; ahora los tres comparten este resultado.
  const cacheada = leerResolucion(episode.Id, selectedAudio);
  if (cacheada) {
    return comoRespuesta(cacheada, false);
  }

  const preferredRefresh = selectedAudio ? await refreshVideoSourceFromSnapshot(snapshot, selectedAudio) : null;
  const direct = preferredRefresh ? null : await resolveDirectVideoCandidate(snapshot, episode, selectedAudio);

  if (preferredRefresh) {
    return comoRespuesta(guardarResolucion(episode.Id, selectedAudio, preferredRefresh), true);
  }

  if (direct) {
    return comoRespuesta(guardarResolucion(episode.Id, selectedAudio, direct), false);
  }

  if (snapshot) {
    const refreshed = await refreshVideoSourceFromSnapshot(snapshot, selectedAudio);
    if (refreshed) {
      return comoRespuesta(guardarResolucion(episode.Id, selectedAudio, refreshed), true);
    }
  }

  const fallbackUrl = fallbackEmbedUrl(snapshot, episode, selectedAudio);
  if (fallbackUrl) {
    return {
      provider: 'embed',
      url: fallbackUrl,
      proxied: false,
      sourceUrl: fallbackUrl,
      referer: null,
      contentType: null,
      refreshed: false,
      canTrackProgress: false,
      audio: selectedAudio,
      audioOptions
    };
  }

  const fallbackProvider = selectedAudio
    ? 'embed'
    : inferProviderFromVideo(
      episode?.VideoUrl,
      null,
      String(episode?.Provider || 'file').toLowerCase()
    );
  const fallbackDirectUrl = selectedAudio ? '' : String(episode?.VideoUrl || '');

  if (fallbackDirectUrl && fallbackProvider !== 'embed') {
    return {
      provider: fallbackProvider,
      url: buildPlaybackUrl(req, episode.Id, { audio: selectedAudio }),
      proxied: true,
      sourceUrl: fallbackDirectUrl,
      referer: null,
      contentType: null,
      refreshed: false,
      canTrackProgress: true,
      audio: selectedAudio,
      audioOptions
    };
  }

  return {
    provider: fallbackProvider,
    url: fallbackDirectUrl,
    proxied: false,
    sourceUrl: fallbackDirectUrl,
    referer: null,
    contentType: null,
    refreshed: false,
    canTrackProgress: fallbackProvider !== 'embed',
    audio: selectedAudio,
    audioOptions
  };
}

// GET /api/genres  -> lista de géneros para el filtro
router.get('/genres', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query('SELECT Id, Name FROM dbo.Genres ORDER BY Name');
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener géneros' });
  }
});

router.get('/content-types', async (_req, res) => {
  res.json([
    { value: 'anime', label: 'Anime' },
    { value: 'series', label: 'Series' },
    { value: 'movie', label: 'Películas' }
  ]);
});

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 24;

const SERIES_COLUMNS = `
  s.Id, s.Title, s.Description, s.PosterUrl, s.BackdropUrl, s.ReleaseYear, s.Rating,
  s.ContentType,
  (SELECT STRING_AGG(g.Name, ', ')
     FROM dbo.SeriesGenres sg JOIN dbo.Genres g ON g.Id = sg.GenreId
    WHERE sg.SeriesId = s.Id) AS Genres`;

const SERIES_WHERE = `
  (@search IS NULL OR s.Title LIKE '%' + @search + '%')
  AND (@type   IS NULL OR s.ContentType = @type)
  AND (@genre  IS NULL OR EXISTS (
        SELECT 1 FROM dbo.SeriesGenres sg JOIN dbo.Genres g ON g.Id = sg.GenreId
         WHERE sg.SeriesId = s.Id AND g.Name = @genre))`;

// GET /api/series?search=&genre=&type=&page=&pageSize=
// Sin `page` devuelve el catálogo entero, como siempre. Con `page` devuelve una
// página y el total, que es lo que piden los carruseles del inicio (10 por tipo)
// y el listado paginado.
router.get('/series', async (req, res) => {
  const search = (req.query.search || '').trim() || null;
  const genre = (req.query.genre || '').trim() || null;
  const type = (req.query.type || '').trim() || null;

  const paginado = req.query.page !== undefined;
  const page = Math.max(1, Math.trunc(Number(req.query.page)) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(req.query.pageSize)) || DEFAULT_PAGE_SIZE));

  try {
    const pool = await getPool();
    const request = pool.request()
      .input('search', sql.NVarChar, search)
      .input('genre', sql.NVarChar, genre)
      .input('type', sql.NVarChar, type);

    if (!paginado) {
      const result = await request.query(
        `SELECT ${SERIES_COLUMNS} FROM dbo.Series s WHERE ${SERIES_WHERE} ORDER BY s.Title`);
      return res.json(result.recordset);
    }

    // El total va en su propia consulta a proposito: con COUNT(*) OVER() una
    // pagina fuera de rango no devuelve filas y el total se perderia con ellas,
    // que es justo cuando el cliente necesita saber a que pagina volver.
    const result = await request
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('pageSize', sql.Int, pageSize)
      .query(`
        SELECT COUNT(*) AS Total FROM dbo.Series s WHERE ${SERIES_WHERE};

        SELECT ${SERIES_COLUMNS}
          FROM dbo.Series s
         WHERE ${SERIES_WHERE}
         ORDER BY s.Title
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;`);

    const total = result.recordsets[0][0].Total;
    res.json({
      items: result.recordsets[1],
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener series' });
  }
});

// GET /api/series/:id  -> serie con géneros, temporadas y episodios anidados
router.get('/series/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });
  try {
    const pool = await getPool();

    const seriesRes = await pool.request().input('id', sql.Int, id)
      .query('SELECT * FROM dbo.Series WHERE Id = @id');
    const series = seriesRes.recordset[0];
    if (!series) return res.status(404).json({ error: 'Serie no encontrada' });

    const genresRes = await pool.request().input('id', sql.Int, id)
      .query(`SELECT g.Id, g.Name FROM dbo.SeriesGenres sg
                JOIN dbo.Genres g ON g.Id = sg.GenreId WHERE sg.SeriesId = @id ORDER BY g.Name`);

    const seasonsRes = await pool.request().input('id', sql.Int, id)
      .query('SELECT Id, SeasonNumber, Title FROM dbo.Seasons WHERE SeriesId = @id ORDER BY SeasonNumber');

    const episodesRes = await pool.request().input('id', sql.Int, id)
      .query(`SELECT e.Id, e.SeasonId, e.EpisodeNumber, e.Title, e.Description, e.VideoUrl,
                     e.Provider, e.ThumbnailUrl, e.DurationSec,
                     e.IntroStartSec, e.IntroEndSec, e.OutroStartSec
                FROM dbo.Episodes e
                JOIN dbo.Seasons s ON s.Id = e.SeasonId
               WHERE s.SeriesId = @id
               ORDER BY s.SeasonNumber, e.EpisodeNumber`);

    const episodesBySeasonId = new Map();
    for (const episode of episodesRes.recordset) {
      const prepared = {
        ...episode,
        SourceVideoUrl: episode.VideoUrl,
        VideoUrl: (() => {
          const provider = String(episode.Provider || 'file').toLowerCase();
          // Sólo los embeds se reproducen contra su origen: el resto pasa por
          // el proxy, que es lo que permite usar el reproductor propio aunque
          // el CDN de origen no mande CORS.
          if (provider === 'embed') {
            return episode.VideoUrl;
          }
          return buildPlaybackUrl(req, episode.Id);
        })()
      };

      const current = episodesBySeasonId.get(episode.SeasonId);
      if (current) current.push(prepared);
      else episodesBySeasonId.set(episode.SeasonId, [prepared]);
    }

    const seasons = seasonsRes.recordset.map((s) => ({
      ...s,
      episodes: episodesBySeasonId.get(s.Id) || [],
    }));

    res.json({ ...series, genres: genresRes.recordset, seasons });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la serie' });
  }
});

// El snapshot guarda el Referer con el que se verificó el video, que algunos
// CDN exigen. Se consulta aparte porque las tablas las crea el importador y
// pueden no existir todavía: si falta, se reproduce igual con la URL guardada.
async function findEpisodeSnapshot(pool, episode) {
  const sourceRef = String(episode.SourceRef || '');
  const normalizedSlug = normalizeSourceRef(sourceRef);
  const snapshots = [];

  try {
    if (sourceRef.toLowerCase().startsWith('jkanime:')) {
      // El slug vive en la serie, pero cada temporada de una franquicia es una
      // ficha distinta del sitio de origen, con su propio slug y su numeración
      // empezando de nuevo en 1. Buscar solo por slug de la serie + número hacía
      // que, por ejemplo, el capítulo 2 de cualquier temporada de Bleach cayera
      // en el snapshot del capítulo 2 de la serie original: las cinco
      // temporadas resolvían al mismo vídeo.
      //
      // El título sí distingue ("Bleach 2" frente a "Bleach: Sennen Kessen-hen -
      // Soukoku-tan 2") y es un enlace exacto, no una heurística: el importador
      // escribe el mismo valor en Episodes.Title y en EpisodeTitle. El slug
      // queda de respaldo para lo importado antes o con el título retocado.
      const jkResult = await pool.request()
        .input('slug', sql.NVarChar(255), normalizedSlug)
        .input('episodeNumber', sql.Int, episode.EpisodeNumber)
        .input('episodeTitle', sql.NVarChar(500), episode.Title || null)
        .query(`
          SELECT TOP 1
            EpisodePageUrl,
            VideoSrcUrl,
            VideoSrcReferer,
            VerifiedVideoUrl,
            VerifiedVideoReferer,
            PrimaryVideoUrl,
            PrimaryVideoSource,
            LocalPlayerOptionsJson,
            ServerOptionsJson,
            DownloadOptionsJson,
            PlayerEmbedsJson,
            NULL AS PlayerOptionsJson
          FROM dbo.JkAnimeEpisodeSnapshots
          WHERE EpisodeNumber = @episodeNumber
            AND (EpisodeTitle = @episodeTitle OR SeriesSlug = @slug)
          ORDER BY
            CASE WHEN EpisodeTitle = @episodeTitle THEN 0 ELSE 1 END,
            UpdatedAt DESC,
            Id DESC
        `);
      snapshots.push(...jkResult.recordset);

      const extraAnime = await pool.request()
        .input('slug', sql.NVarChar(255), normalizedSlug)
        .input('episodeNumber', sql.Int, episode.EpisodeNumber)
        .input('seasonNumber', sql.Int, episode.SeasonNumber)
        .query(`
          SELECT
            EpisodePageUrl,
            VideoSrcUrl,
            VideoSrcReferer,
            VerifiedVideoUrl,
            VerifiedVideoReferer,
            PrimaryVideoUrl,
            PrimaryVideoSource,
            NULL AS LocalPlayerOptionsJson,
            NULL AS ServerOptionsJson,
            NULL AS DownloadOptionsJson,
            NULL AS PlayerEmbedsJson,
            PlayerOptionsJson
          FROM dbo.PelisPlusSnapshots
          WHERE ContentType = 'anime'
            AND SeriesSlug = @slug
            AND EpisodeNumber = @episodeNumber
            AND SeasonNumber = @seasonNumber
          ORDER BY UpdatedAt DESC, Id DESC
        `);
      snapshots.push(...extraAnime.recordset);
      return snapshots;
    }

    const prefixes = ['pelisplushd:', 'pelisflix200:', 'pelismart:', 'pelisplus:', 'cuevana3:', 'henaojara:'];
    const matchedPrefix = prefixes.find((prefix) => sourceRef.toLowerCase().startsWith(prefix));
    if (!matchedPrefix) return [];

    const result = await pool.request()
      .input('slug', sql.NVarChar(255), sourceRef.slice(matchedPrefix.length))
      .input('episodeNumber', sql.Int, episode.EpisodeNumber)
      .input('seasonNumber', sql.Int, episode.SeasonNumber)
      .query(`
        SELECT
          EpisodePageUrl,
          VideoSrcUrl,
          VideoSrcReferer,
          VerifiedVideoUrl,
          VerifiedVideoReferer,
          PrimaryVideoUrl,
          PrimaryVideoSource,
          NULL AS LocalPlayerOptionsJson,
          NULL AS ServerOptionsJson,
          NULL AS DownloadOptionsJson,
          NULL AS PlayerEmbedsJson,
          PlayerOptionsJson
        FROM dbo.PelisPlusSnapshots
        WHERE SeriesSlug = @slug
          AND EpisodeNumber = @episodeNumber
          AND SeasonNumber = @seasonNumber
        ORDER BY UpdatedAt DESC, Id DESC
      `);
    return result.recordset;
  } catch (err) {
    console.error('No pude leer snapshots del episodio:', err.message);
    return [];
  }
}

router.get('/episodes/:id/playback', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT TOP 1
          e.Id,
          e.VideoUrl,
          e.Provider,
          e.EpisodeNumber,
          e.Title,
          se.SeasonNumber,
          sr.SourceRef
        FROM dbo.Episodes e
        JOIN dbo.Seasons se ON se.Id = e.SeasonId
        JOIN dbo.Series sr ON sr.Id = se.SeriesId
        WHERE e.Id = @id
      `);

    const episode = result.recordset[0];
    if (!episode) {
      return res.status(404).json({ error: 'Episodio no encontrado' });
    }

    const playback = await resolveEpisodePlayback(req, pool, episode);
    if (!playback?.url) {
      return res.status(404).json({ error: 'No se encontró una fuente de reproducción válida' });
    }

    res.json(playback);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al resolver la reproducción del episodio' });
  }
});

// ?u= es una variante o un segmento de un playlist que este mismo proxy
// reescribió, y trae dentro su URL y el Referer con el que hay que pedirlo. La
// firma es lo que impide usar el endpoint como proxy abierto a cualquier URL.
function decodificarSubRecurso(req) {
  const decodificar = (valor) => Buffer.from(String(valor), 'base64url').toString('utf8');

  let url;
  let referer = null;
  try {
    url = decodificar(req.query.u);
    if (req.query.r) referer = decodificar(req.query.r);
  } catch {
    return { status: 400, error: 'Sub-recurso inválido' };
  }

  if (!isValidStreamSignature(url, referer, req.query.sig)) {
    return { status: 403, error: 'Firma inválida para este sub-recurso' };
  }

  return { url, referer };
}

/**
 * Entrega lo que haya en `target`, sea un playlist, un segmento o un archivo
 * progresivo. `recargar` solo llega cuando la petición es el manifiesto del
 * episodio: un sub-recurso ya viene firmado y no tiene fuente alternativa que
 * buscar.
 */
async function transmitir(req, res, { episodeId, target, referer, recargar = null }) {
  if (target.startsWith('/media/')) {
    return res.redirect(target);
  }

  // Los playlists ya reescritos se reutilizan un rato: son idénticos para todo
  // el que pida el mismo episodio y traerlos del origen cuesta cerca de un
  // segundo, que es tiempo de espera antes del primer fotograma. Se guardan
  // por URL de origen, así que el token que llevan dentro sigue mandando: en
  // cuanto cambia, la clave es otra.
  const cacheado = leerPlaylist(target);
  if (cacheado) {
    res.status(200);
    res.setHeader('content-type', cacheado.contentType);
    res.setHeader('cache-control', 'no-store');
    return res.send(cacheado.body);
  }

  const forwardedHeaders = {
    'User-Agent': req.get('user-agent') || 'StreamFlix/1.0',
    Accept: req.get('accept') || '*/*'
  };

  // Los sub-recursos de un HLS (variantes y segmentos) se piden completos: el
  // reproductor no busca dentro de ellos, y además aquí se reescribe el
  // contenido, así que un Range del cliente no correspondería con lo enviado.
  // En un archivo progresivo sí hay que reenviarlo para que funcione el seek.
  if (req.headers.range && !req.query.u) forwardedHeaders.Range = req.headers.range;
  if (referer) forwardedHeaders.Referer = referer;

  const pedir = (url, refererDeTurno) => requestUpstream(url, {
    ...forwardedHeaders,
    ...(refererDeTurno ? { Referer: refererDeTurno } : {})
  });

  let { response: upstream, finalUrl } = await pedir(target, referer);

  // Un error del origen se reporta como error. Estos enlaces caducan (llevan
  // token), y antes la página de error acababa reescrita como si fuera un
  // playlist, con lo que el reproductor se quedaba en negro sin explicación.
  if (upstream.statusCode >= 400) {
    upstream.resume();

    // Algunos hosts (como Uqload) firman la URL final del m3u8 y la dejan
    // caducar enseguida. Si el snapshot todavía conserva el embed del que
    // salió, se vuelve a resolver aquí mismo para obtener un enlace fresco.
    const fresca = recargar ? await recargar() : null;
    if (fresca) {
      target = fresca.url;
      referer = fresca.referer;
      ({ response: upstream, finalUrl } = await pedir(target, referer));
    }

    if (upstream.statusCode >= 400) {
      upstream.resume();
      return res.status(502).json({
        error: `El origen del video respondió ${upstream.statusCode}. ` +
          'Es probable que el enlace haya caducado: vuelve a importar el capítulo.',
        upstreamStatus: upstream.statusCode
      });
    }
  }

  // Un playlist se reescribe entero antes de mandarlo: si no, hls.js pediría
  // las variantes y segmentos directo al CDN y volvería el problema de CORS.
  if (/\.m3u8(?:$|\?)/i.test(finalUrl) || /mpegurl/i.test(upstream.headers['content-type'] || '')) {
    let body = await leerCuerpo(upstream);

    // Si pese a todo no es un playlist —una página de error del CDN, que es
    // como se manifiesta un token caducado— se busca una fuente fresca en vez
    // de inventarle segmentos.
    if (!isPlaylistResponse(upstream.headers['content-type'], body)) {
      const fresca = recargar ? await recargar() : null;
      if (fresca) {
        target = fresca.url;
        referer = fresca.referer;
        ({ response: upstream, finalUrl } = await pedir(target, referer));
        body = await leerCuerpo(upstream);
      }

      if (!fresca || !isPlaylistResponse(upstream.headers['content-type'], body)) {
        return res.status(502)
          .json({ error: 'El origen no devolvió un playlist válido; el enlace pudo caducar.' });
      }
    }

    const rewritten = rewritePlaylist(body.toString('utf8'), finalUrl, episodeId, referer);
    guardarPlaylist(target, rewritten, upstream.headers['content-type']);
    // Siempre 200: lo que se manda es el playlist reescrito completo, no el
    // cuerpo original, así que un 206 de arriba dejaría de tener sentido.
    res.status(200);
    res.setHeader('content-type', upstream.headers['content-type'] || 'application/vnd.apple.mpegurl');
    res.setHeader('cache-control', 'no-store');
    return res.send(rewritten);
  }

  if (isDisguisedSegment(upstream.headers['content-type'])) {
    // Igual que con el playlist: se entrega el segmento ya destapado entero.
    const segment = unwrapSegment(await leerCuerpo(upstream));
    res.status(200);
    res.setHeader('content-type', 'video/mp2t');
    res.setHeader('content-length', String(segment.length));
    return res.end(segment);
  }

  const passthroughHeaders = [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'cache-control',
    'last-modified',
    'etag'
  ];

  res.status(upstream.statusCode || 200);
  for (const headerName of passthroughHeaders) {
    const value = upstream.headers[headerName];
    if (value != null) {
      res.setHeader(headerName, value);
    }
  }
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.status(502).json({ error: error.message });
    } else {
      res.destroy(error);
    }
  });

  req.on('close', () => {
    upstream.destroy();
  });

  upstream.pipe(res);
}

// GET /api/episodes/:id/stream  -> proxy de reproducción para archivos remotos
router.get('/episodes/:id/stream', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Id inválido' });

  try {
    // Un sub-recurso se atiende antes de tocar la base de datos, porque no hay
    // nada que resolver: llega firmado con su URL y su Referer.
    //
    // Esta comprobación estaba al final, después de rehacer la resolución
    // completa del episodio. Como un capítulo de 24 min son ~70 segmentos, se
    // pagaban ~70 resoluciones (consultas SQL, un sondeo HEAD+GET contra el CDN
    // por cada candidato y, en cuanto los enlaces guardados caducaban, un
    // scraping entero con su proof-of-work) para acabar usando solo el Referer.
    // Era lo que hacía que el vídeo se parase cada pocos segundos.
    if (req.query.u) {
      const sub = decodificarSubRecurso(req);
      if (sub.error) return res.status(sub.status).json({ error: sub.error });
      return await transmitir(req, res, { episodeId: id, target: sub.url, referer: sub.referer });
    }

    const pool = await getPool();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .query(`
        SELECT TOP 1
          e.Id,
          e.VideoUrl,
          e.Provider,
          e.EpisodeNumber,
          e.Title,
          se.SeasonNumber,
          sr.SourceRef
        FROM dbo.Episodes e
        JOIN dbo.Seasons se ON se.Id = e.SeasonId
        JOIN dbo.Series sr ON sr.Id = se.SeriesId
        WHERE e.Id = @id
      `);

    const episode = result.recordset[0];
    if (!episode) {
      return res.status(404).json({ error: 'Episodio no encontrado' });
    }

    const preferredAudio = audioPreferenceFromReq(req);
    let snapshot = null;
    const cargarSnapshot = async () => {
      if (snapshot === null) snapshot = await findEpisodeSnapshot(pool, episode);
      return snapshot;
    };

    // Descarta lo cacheado y vuelve a resolver: se llama cuando el origen
    // contesta con un error o con algo que no es un playlist.
    const recargar = async () => {
      olvidarResolucion(id, preferredAudio);
      const fresca = await refreshVideoSourceFromSnapshot(await cargarSnapshot(), preferredAudio);
      return fresca ? guardarResolucion(id, preferredAudio, fresca) : null;
    };

    let fuente = leerResolucion(id, preferredAudio);
    if (!fuente) {
      const snap = await cargarSnapshot();
      const direct = await resolveDirectVideoCandidate(snap, episode, preferredAudio);
      const refreshed = direct ? null : await refreshVideoSourceFromSnapshot(snap, preferredAudio);
      const verificada = direct || refreshed;

      fuente = verificada || collectDirectVideoCandidates(snap, episode, preferredAudio)[0] || null;
      if (!fuente) {
        return res.status(404).json({ error: 'No se encontró una fuente de video reproducible' });
      }

      // Solo se guarda lo que se ha comprobado contra el origen: ese último
      // candidato es un intento a ciegas y no trae ni provider ni content-type,
      // que es lo que /playback necesita para elegir reproductor.
      if (verificada) guardarResolucion(id, preferredAudio, verificada);
    }

    return await transmitir(req, res, {
      episodeId: id,
      target: fuente.url,
      referer: fuente.referer || null,
      recargar
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(502).json({ error: 'Error al transmitir el video' });
  }
});

module.exports = router;
