/**
 * Carátulas y banners de anime desde AniList, compartido por los scripts de
 * imágenes. La API es pública y sin clave.
 *
 * Para anime manda AniList por encima de TMDB: guarda el título en romaji, en
 * inglés y en japonés, que es justo por donde vienen los títulos del catálogo
 * ("Shingeki no Kyojin Temporada 1"), y su carátula es la oficial del anime y no
 * el cartel de una edición concreta.
 */

const https = require('https');
const { normalizeSearchTitle } = require('./tmdb');

const ANILIST_API = 'https://graphql.anilist.co';
const USER_AGENT = 'NoxisArtwork/1.0';
// El límite público de AniList puede bajar temporalmente (en producción se ha
// observado a 30/min). Dos segundos largos funcionan tanto con ese límite como
// con el normal y evitan que media revisión se interprete como "sin ficha".
const MIN_REQUEST_GAP_MS = 2200;
const MAX_RETRIES = 4;

const artworkCache = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cola = Promise.resolve();
let ultimaPeticion = 0;

function encolar(tarea) {
  const turno = cola.then(async () => {
    const espera = MIN_REQUEST_GAP_MS - (Date.now() - ultimaPeticion);
    if (espera > 0) await sleep(espera);
    try {
      return await tarea();
    } finally {
      ultimaPeticion = Date.now();
    }
  });
  cola = turno.catch(() => {});
  return turno;
}

/**
 * Limpia el título antes de buscarlo.
 *
 * Los títulos importados arrastran la coletilla de la página de origen ("Ver …
 * Español Latino HD - … Online Descargar Anime"), y con eso AniList no encuentra
 * nada. Quitarla deja el nombre del anime, que es lo que sí indexa.
 */
function normalizeAnimeSearchTitle(title) {
  return String(title || '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/^\s*ver\s+/i, '')
    .replace(/\b(online|descargar|gratis|completa|capitulos|capítulos)\b/gi, ' ')
    .replace(/\b(sub\s+espa[nñ]ol|espa[nñ]ol|latino|castellano|subtitulado|original|tv|hd|fhd|1080p|720p)\b/gi, ' ')
    .replace(/\s*[-|–]\s*[^-|–]*$/, '')   // "… - HenaoJara Anime" y similares
    .replace(/\s+/g, ' ')
    .trim();
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
          'User-Agent': USER_AGENT
        },
        timeout: 20000
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          const status = res.statusCode || 0;
          // Un 404 de AniList es "no hay ese anime", no un fallo: se resuelve
          // vacío para que el llamante lo trate como "sin ficha".
          if (status === 404) return resolve(null);
          if (status >= 400) {
            const error = new Error(`AniList HTTP ${status}`);
            error.status = status;
            const retryAfter = Number(res.headers['retry-after']);
            error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 0;
            return reject(error);
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('Respuesta inválida de AniList'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('AniList tardó demasiado')));
    req.on('error', reject);
    req.end(body);
  });
}

async function requestAniList(payload) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await encolar(() => postJson(ANILIST_API, payload));
    } catch (error) {
      lastError = error;
      const transient = !error.status || error.status === 429 || error.status >= 500;
      if (!transient || attempt === MAX_RETRIES - 1) throw error;
      const backoff = 3000 * 2 ** attempt;
      await sleep(Math.max(error.retryAfterMs || 0, backoff));
    }
  }
  throw lastError;
}

const CONSULTA = `
  query ($search: String) {
    Media(search: $search, type: ANIME) {
      siteUrl
      bannerImage
      coverImage { extraLarge large }
      startDate { year }
      title { romaji english native }
    }
  }
`;

/**
 * Comprueba que lo que devolvió AniList es de verdad este anime.
 *
 * La búsqueda es difusa y siempre contesta algo: sin este filtro, un título que
 * no está en AniList se lleva la carátula del anime más parecido que haya. Vale
 * con que cualquiera de sus tres títulos encaje con el del catálogo.
 */
function esElMismo(media, series) {
  const variantes = [series.Title, normalizeAnimeSearchTitle(series.Title)]
    .map(normalizeSearchTitle)
    .filter(Boolean);
  const candidatos = [media.title?.romaji, media.title?.english, media.title?.native]
    .map(normalizeSearchTitle)
    .filter(Boolean);

  // "Bleach" está contenido en los títulos de todas sus secuelas, pero no son
  // la misma ficha ni usan la misma portada. La contención servía como atajo y
  // era precisamente lo que mezclaba temporadas/franquicias; solo se acepta un
  // nombre oficial completo.
  return candidatos.some((candidato) => variantes.includes(candidato));
}

/**
 * Carátula y banner de un anime, o null si no hay ninguno que case con
 * seguridad. Los fallos de red suben tal cual: "no encontrado" y "no se pudo
 * preguntar" son cosas distintas y el informe las distingue.
 */
async function fetchAnimeArtwork(series) {
  const cacheKey = `${series.SourceRef || ''}|${series.Title}`;
  if (artworkCache.has(cacheKey)) return artworkCache.get(cacheKey);

  const search = normalizeAnimeSearchTitle(series.Title);
  if (!search) {
    artworkCache.set(cacheKey, null);
    return null;
  }

  const response = await requestAniList({ query: CONSULTA, variables: { search } });
  const media = response?.data?.Media || null;
  if (!media || !esElMismo(media, series)) {
    artworkCache.set(cacheKey, null);
    return null;
  }

  const artwork = {
    backdropUrl: media.bannerImage || media.coverImage?.extraLarge || media.coverImage?.large || null,
    posterUrl: media.coverImage?.extraLarge || media.coverImage?.large || null,
    title: media.title?.romaji || media.title?.english || media.title?.native || series.Title,
    year: media.startDate?.year || null,
    siteUrl: media.siteUrl || null
  };
  artworkCache.set(cacheKey, artwork);
  return artwork;
}

module.exports = { esElMismo, fetchAnimeArtwork, normalizeAnimeSearchTitle };
