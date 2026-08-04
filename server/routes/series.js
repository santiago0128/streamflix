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

function signStreamUrl(url) {
  return crypto.createHmac('sha256', STREAM_PROXY_SECRET).update(url).digest('hex').slice(0, 32);
}

function isValidStreamSignature(url, signature) {
  const expected = Buffer.from(signStreamUrl(url));
  const received = Buffer.from(String(signature || ''));
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

function buildSubResourceUrl(episodeId, absoluteUrl) {
  const encoded = Buffer.from(absoluteUrl, 'utf8').toString('base64url');
  return `/api/episodes/${episodeId}/stream?u=${encoded}&sig=${signStreamUrl(absoluteUrl)}`;
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

// Reescribe el playlist para que todo lo que cuelga de él vuelva por el proxy.
function rewritePlaylist(body, baseUrl, episodeId) {
  const toProxy = (rawUrl) => {
    try {
      return buildSubResourceUrl(episodeId, new URL(rawUrl, baseUrl).toString());
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

function buildPlaybackUrl(req, episodeId) {
  return `/api/episodes/${episodeId}/stream`;
}

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
    upstream.end();
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

function extractEmbed69Links(html, pageUrl) {
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

  const prefix = '0'.repeat(difficulty);
  let nonce = 0;
  while (nonce < 2_000_000) {
    const hash = crypto.createHash('sha256').update(challenge + nonce).digest('hex');
    if (hash.startsWith(prefix)) {
      break;
    }
    nonce += 1;
  }

  if (nonce >= 2_000_000) {
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
    const embed69Links = extractEmbed69Links(response.body, embedUrl);
    if (embed69Links.length) return embed69Links;
    const urls = extractPlayerMediaUrls(response.body, embedUrl);
    if (urls.length) return urls;
  }

  return [];
}

function parsePlayerOptions(snapshot) {
  if (!snapshot?.PlayerOptionsJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(snapshot.PlayerOptionsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function collectEmbedCandidates(snapshot, episode) {
  const urls = [
    snapshot?.VideoSrcReferer,
    snapshot?.VerifiedVideoReferer,
    snapshot?.PrimaryVideoUrl,
    episode?.VideoUrl
  ];

  for (const option of parsePlayerOptions(snapshot)) {
    urls.push(option?.embedUrl, option?.url, option?.playerUrl);
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

function collectDirectVideoCandidates(snapshot, episode) {
  const candidates = [
    { url: snapshot?.VideoSrcUrl, referer: snapshot?.VideoSrcReferer },
    { url: snapshot?.VerifiedVideoUrl, referer: snapshot?.VerifiedVideoReferer },
    { url: snapshot?.PrimaryVideoUrl, referer: snapshot?.VerifiedVideoReferer || snapshot?.VideoSrcReferer },
    { url: episode?.VideoUrl, referer: null }
  ];

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

async function resolveDirectVideoCandidate(snapshot, episode) {
  for (const candidate of collectDirectVideoCandidates(snapshot, episode)) {
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

async function refreshVideoSourceFromSnapshot(snapshot) {
  const embedCandidates = collectEmbedCandidates(snapshot, null);

  for (const embedUrl of embedCandidates) {
    try {
      const resolved = await resolvePlayableUrl(embedUrl, snapshot?.EpisodePageUrl || embedUrl);
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

function fallbackEmbedUrl(snapshot, episode) {
  return collectEmbedCandidates(snapshot, episode)[0] || null;
}

async function resolveEpisodePlayback(req, pool, episode, providedSnapshot = undefined) {
  const snapshot = providedSnapshot === undefined ? await findEpisodeSnapshot(pool, episode) : providedSnapshot;
  const direct = await resolveDirectVideoCandidate(snapshot, episode);

  if (direct) {
    return {
      provider: direct.provider,
      url: buildPlaybackUrl(req, episode.Id),
      proxied: true,
      sourceUrl: direct.url,
      referer: direct.referer,
      contentType: direct.contentType,
      refreshed: false,
      canTrackProgress: true
    };
  }

  if (snapshot) {
    const refreshed = await refreshVideoSourceFromSnapshot(snapshot);
    if (refreshed) {
      return {
        provider: refreshed.provider || 'file',
        url: buildPlaybackUrl(req, episode.Id),
        proxied: true,
        sourceUrl: refreshed.url,
        referer: refreshed.referer,
        contentType: refreshed.contentType,
        refreshed: true,
        canTrackProgress: true
      };
    }
  }

  const fallbackUrl = fallbackEmbedUrl(snapshot, episode);
  if (fallbackUrl) {
    return {
      provider: 'embed',
      url: fallbackUrl,
      proxied: false,
      sourceUrl: fallbackUrl,
      referer: null,
      contentType: null,
      refreshed: false,
      canTrackProgress: false
    };
  }

  const fallbackProvider = inferProviderFromVideo(
    episode?.VideoUrl,
    null,
    String(episode?.Provider || 'file').toLowerCase()
  );
  const fallbackDirectUrl = String(episode?.VideoUrl || '');

  if (fallbackDirectUrl && fallbackProvider !== 'embed') {
    return {
      provider: fallbackProvider,
      url: buildPlaybackUrl(req, episode.Id),
      proxied: true,
      sourceUrl: fallbackDirectUrl,
      referer: null,
      contentType: null,
      refreshed: false,
      canTrackProgress: true
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
    canTrackProgress: fallbackProvider !== 'embed'
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

    const seasons = seasonsRes.recordset.map((s) => ({
      ...s,
      episodes: episodesRes.recordset
        .filter((e) => e.SeasonId === s.Id)
        .map((e) => ({
          ...e,
          SourceVideoUrl: e.VideoUrl,
          VideoUrl: (() => {
            const provider = String(e.Provider || 'file').toLowerCase();
            // Sólo los embeds se reproducen contra su origen: el resto pasa por
            // el proxy, que es lo que permite usar el reproductor propio aunque
            // el CDN de origen no mande CORS.
            if (provider === 'embed') {
              return e.VideoUrl;
            }
            return buildPlaybackUrl(req, e.Id);
          })()
        })),
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
  const sources = [
    {
      table: 'dbo.JkAnimeEpisodeSnapshots',
      prefixes: ['jkanime:'],
      matchSeason: false
    },
    {
      table: 'dbo.PelisPlusSnapshots',
      prefixes: ['pelisplushd:', 'pelisflix200:', 'pelismart:', 'pelisplus:', 'cuevana3:'],
      matchSeason: true
    }
  ];

  const sourceRef = String(episode.SourceRef || '');

  for (const source of sources) {
    const matchedPrefix = (source.prefixes || []).find((prefix) =>
      sourceRef.toLowerCase().startsWith(prefix)
    );
    if (!matchedPrefix) continue;

    try {
      const result = await pool.request()
        .input('slug', sql.NVarChar(255), sourceRef.slice(matchedPrefix.length))
        .input('episodeNumber', sql.Int, episode.EpisodeNumber)
        .input('seasonNumber', sql.Int, episode.SeasonNumber)
        .query(`
          SELECT TOP 1
            EpisodePageUrl,
            VideoSrcUrl,
            VideoSrcReferer,
            VerifiedVideoUrl,
            VerifiedVideoReferer,
            PrimaryVideoUrl,
            PrimaryVideoSource,
            PlayerOptionsJson
            FROM ${source.table}
           WHERE SeriesSlug = @slug
             AND EpisodeNumber = @episodeNumber
             ${source.matchSeason ? 'AND SeasonNumber = @seasonNumber' : ''}
           ORDER BY UpdatedAt DESC, Id DESC
        `);

      return result.recordset[0] || null;
    } catch (err) {
      console.error(`No pude leer ${source.table}:`, err.message);
      return null;
    }
  }

  return null;
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

// GET /api/episodes/:id/stream  -> proxy de reproducción para archivos remotos
router.get('/episodes/:id/stream', async (req, res) => {
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

    const snapshot = await findEpisodeSnapshot(pool, episode);
    const direct = await resolveDirectVideoCandidate(snapshot, episode);
    const refreshed = direct ? null : await refreshVideoSourceFromSnapshot(snapshot);

    const candidates = [
      direct && { url: direct.url, referer: direct.referer },
      refreshed && { url: refreshed.url, referer: refreshed.referer },
      ...collectDirectVideoCandidates(snapshot, episode)
    ].filter(Boolean);

    if (!candidates.length) {
      return res.status(404).json({ error: 'No se encontró una fuente de video reproducible' });
    }

    let selected = candidates[0];

    // ?u= es una variante o un segmento de un playlist que este mismo proxy
    // reescribió; la firma es lo que impide pedirle cualquier URL de internet.
    let target = selected.url;
    if (req.query.u) {
      let requested;
      try {
        requested = Buffer.from(String(req.query.u), 'base64url').toString('utf8');
      } catch {
        return res.status(400).json({ error: 'Sub-recurso inválido' });
      }

      if (!isValidStreamSignature(requested, req.query.sig)) {
        return res.status(403).json({ error: 'Firma inválida para este sub-recurso' });
      }

      target = requested;
    }

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
    if (selected.referer) forwardedHeaders.Referer = selected.referer;

    let { response: upstream, finalUrl } = await requestUpstream(target, forwardedHeaders);

    // Un error del origen se reporta como error. Estos enlaces caducan (llevan
    // token), y antes la página de error acababa reescrita como si fuera un
    // playlist, con lo que el reproductor se quedaba en negro sin explicación.
    if (upstream.statusCode >= 400) {
      upstream.resume();

      // Algunos hosts (como Uqload) firman la URL final del m3u8 y la dejan
      // caducar enseguida. Si el snapshot todavía conserva el embed del que
      // salió, se vuelve a resolver aquí mismo para obtener un enlace fresco.
      if (!req.query.u && snapshot) {
        const refreshed = await refreshVideoSourceFromSnapshot(snapshot);
        if (refreshed) {
          selected = { url: refreshed.url, referer: refreshed.referer };
          target = selected.url;
          const retryHeaders = {
            ...forwardedHeaders,
            Referer: selected.referer
          };
          ({ response: upstream, finalUrl } = await requestUpstream(target, retryHeaders));
        }
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
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('error', (error) => {
        if (!res.headersSent) res.status(502).json({ error: error.message });
      });

      return upstream.on('end', () => {
        const body = Buffer.concat(chunks);

        // Si pese a todo no es un playlist, se manda tal cual en vez de
        // inventarle segmentos.
        if (!isPlaylistResponse(upstream.headers['content-type'], body)) {
          if (!req.query.u && snapshot) {
            refreshVideoSourceFromSnapshot(snapshot)
              .then(async (refreshed) => {
                if (!refreshed) {
                  res.status(502);
                  return res.json({ error: 'El origen no devolvió un playlist válido; el enlace pudo caducar.' });
                }

                const retryHeaders = {
                  ...forwardedHeaders,
                  Referer: refreshed.referer
                };
                const retry = await requestUpstream(refreshed.url, retryHeaders);
                const retryChunks = [];
                retry.response.on('data', (chunk) => retryChunks.push(chunk));
                retry.response.on('error', (error) => {
                  if (!res.headersSent) res.status(502).json({ error: error.message });
                });
                retry.response.on('end', () => {
                  const retryBody = Buffer.concat(retryChunks);
                  if (!isPlaylistResponse(retry.response.headers['content-type'], retryBody)) {
                    res.status(502);
                    return res.json({ error: 'El origen no devolvió un playlist válido; el enlace pudo caducar.' });
                  }

                  const rewrittenRetry = rewritePlaylist(retryBody.toString('utf8'), retry.finalUrl, id);
                  guardarPlaylist(refreshed.url, rewrittenRetry, retry.response.headers['content-type']);
                  res.status(200);
                  res.setHeader('content-type', retry.response.headers['content-type'] || 'application/vnd.apple.mpegurl');
                  res.setHeader('cache-control', 'no-store');
                  res.send(rewrittenRetry);
                });
              })
              .catch((error) => {
                if (!res.headersSent) {
                  res.status(502).json({ error: error.message });
                }
              });
            return;
          }

          res.status(502);
          return res.json({ error: 'El origen no devolvió un playlist válido; el enlace pudo caducar.' });
        }

        const rewritten = rewritePlaylist(body.toString('utf8'), finalUrl, id);
        guardarPlaylist(target, rewritten, upstream.headers['content-type']);
        // Siempre 200: lo que se manda es el playlist reescrito completo, no el
        // cuerpo original, así que un 206 de arriba dejaría de tener sentido.
        res.status(200);
        res.setHeader('content-type', upstream.headers['content-type'] || 'application/vnd.apple.mpegurl');
        res.setHeader('cache-control', 'no-store');
        res.send(rewritten);
      });
    }

    if (isDisguisedSegment(upstream.headers['content-type'])) {
      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('error', (error) => {
        if (!res.headersSent) res.status(502).json({ error: error.message });
      });

      return upstream.on('end', () => {
        const segment = unwrapSegment(Buffer.concat(chunks));
        // Igual que con el playlist: se entrega el segmento ya destapado entero.
        res.status(200);
        res.setHeader('content-type', 'video/mp2t');
        res.setHeader('content-length', String(segment.length));
        res.end(segment);
      });
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
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Error al transmitir el video' });
  }
});

module.exports = router;
