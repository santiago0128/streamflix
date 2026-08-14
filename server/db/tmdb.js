/**
 * Búsqueda de fichas en themoviedb.org, compartida por los scripts de imágenes.
 *
 * No usa la API con clave a propósito: la portada y el banner son lo único que
 * se necesita y salen de la web pública, así que el script funciona en un
 * servidor recién montado sin registrar nada. TMDB_API_KEY sigue siendo cosa
 * del bot importador, que sí pide títulos y sinopsis.
 *
 * Aquí vive solo la parte de "encontrar la ficha correcta". Qué imagen sacar de
 * ella es cosa de cada script: el banner y la portada están en etiquetas
 * distintas de la misma página.
 */

const http = require('http');
const https = require('https');

const TMDB_BASE_URL = 'https://www.themoviedb.org';
const USER_AGENT = 'NoxisArtwork/1.0';
const MIN_REQUEST_GAP_MS = 400;

// El catálogo está en español y TMDB busca mejor por el título original. Sin
// esto, "El padrino" devuelve documentales y "Matrix" devuelve cualquier cosa.
const TMDB_TITLE_ALIASES = new Map([
  ['interestelar', ['Interstellar']],
  ['el padrino', ['The Godfather']],
  ['el padrino 2', ['The Godfather Part II']],
  ['el padrino 3', ['The Godfather Part III']],
  ['matrix', ['The Matrix']],
  ['gladiador', ['Gladiator']],
  ['el rey leon', ['The Lion King']],
  ['volver al futuro', ['Back to the Future']],
  ['parque jurasico', ['Jurassic Park']],
  ['la casa del dragon', ['House of the Dragon']],
  ['el increible hulk', ['The Incredible Hulk']],
  ['rick and morty', ['Rick and Morty']],
  ['the office', ['The Office']],
  ['stranger things', ['Stranger Things']],
  ['chernobyl', ['Chernobyl']],
  ['batman el caballero de la noche', ['The Dark Knight']],
  ['el club de la pelea', ['Fight Club']],
  ['buscando a nemo', ['Finding Nemo']],
  ['los increibles', ['The Incredibles']],
  ['intensa mente', ['Inside Out']],
  ['parasitos', ['Parasite']],
  ['duna', ['Dune']],
  ['el gran showman', ['The Greatest Showman']],
  ['guardianes de la galaxia', ['Guardians of the Galaxy']],
  ['piratas del caribe la maldicion de la perla negra', ['Pirates of the Caribbean: The Curse of the Black Pearl']],
  ['harry potter y la piedra filosofal', ["Harry Potter and the Philosopher's Stone"]],
  ['avatar el camino del agua', ['Avatar: The Way of Water']],
  // Un título corto y común es el peor caso del buscador: «Origen» a secas
  // ganaba «Fallas de Origen», que es otra película del mismo año, y la ficha se
  // habría quedado con esa carátula sin que nada lo delatara.
  ['origen', ['Inception']],
  ['top gun maverick', ['Top Gun: Maverick']]
]);

const matchCache = new Map();

function normalizeSearchTitle(title) {
  return String(title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(original|tv|sub espanol|sub español|latino)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getTmdbSearchQueries(series) {
  const title = String(series.Title || '').trim();
  const normalized = normalizeSearchTitle(title);
  const queries = [title];
  const aliases = TMDB_TITLE_ALIASES.get(normalized) || [];
  for (const alias of aliases) {
    if (!queries.includes(alias)) queries.push(alias);
  }
  if (normalized && !queries.includes(normalized) && normalized !== title.toLowerCase()) {
    queries.push(normalized);
  }
  return queries;
}

function get(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 20000
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          return resolve(get(new URL(location, url).toString(), redirects - 1));
        }
        if (status >= 400) {
          res.resume();
          const error = new Error(`HTTP ${status}`);
          error.status = status;
          return reject(error);
        }

        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve(text));
      }
    );

    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Las peticiones van de una en una y espaciadas.
 *
 * En ráfaga TMDB deja de responder a media tanda: recorriendo el catálogo
 * entero fallaban diecisiete títulos seguidos que, pedidos de uno en uno,
 * salían a la primera. No es un límite documentado, así que el remedio es no
 * apretar en vez de afinar un número exacto.
 */
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
  cola = turno.catch(() => {});   // un fallo no puede atascar la cola
  return turno;
}

// Un 404 es una ficha que no existe: reintentarlo es perder el tiempo. Lo demás
// (429, 5xx, timeouts, cortes de red) es pasajero y sí merece otra oportunidad.
const esPasajero = (error) => !error.status || error.status === 429 || error.status >= 500;

async function requestText(url) {
  let ultimoError;
  for (let intento = 0; intento < 3; intento += 1) {
    try {
      return await encolar(() => get(url));
    } catch (error) {
      ultimoError = error;
      if (!esPasajero(error)) throw error;
      await sleep(700 * 2 ** intento);
    }
  }
  throw ultimoError;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseReleaseYear(value) {
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

/**
 * El título se compara contra todas las variantes conocidas, no solo contra el
 * del catálogo. El alias existe justo porque el título en español es ambiguo, y
 * puntuar solo contra él dejaba empates que resolvía el azar del orden: "Matrix"
 * (1999) casaba antes con una película de 1998 titulada exactamente "Matrix"
 * que con "The Matrix", porque el exacto ganaba 50 y el alias solo 25.
 */
function scoreTmdbCandidate(candidate, series, titleVariants) {
  const variants = (titleVariants && titleVariants.length
    ? titleVariants
    : getTmdbSearchQueries(series).map(normalizeSearchTitle)
  ).filter(Boolean);
  const normalizedCandidateTitle = normalizeSearchTitle(candidate.title);
  let score = 0;

  if (candidate.mediaType === 'tv' && series.ContentType === 'series') score += 40;
  if (candidate.mediaType === 'movie' && series.ContentType === 'movie') score += 40;

  if (variants.includes(normalizedCandidateTitle)) score += 50;
  else if (variants.some((variant) =>
    normalizedCandidateTitle.includes(variant) || variant.includes(normalizedCandidateTitle))) score += 25;

  if (series.ReleaseYear && candidate.year) {
    const delta = Math.abs(series.ReleaseYear - candidate.year);
    if (delta === 0) score += 25;
    else if (delta === 1) score += 15;
    else if (delta <= 3) score += 5;
    else score -= Math.min(delta, 20);
  }

  return score;
}

function parseTmdbSearchResults(html) {
  const candidates = [];
  const pattern = /data-media-type="(tv|movie)"[\s\S]*?href="\/(tv|movie)\/([^"]+)"[\s\S]*?<h2[^>]*><span>([^<]+)<\/span><\/h2>[\s\S]*?<span class="release_date w-full font-light">([^<]*)<\/span>/g;
  let match;
  while ((match = pattern.exec(html))) {
    const mediaType = match[1];
    const hrefType = match[2];
    if (mediaType !== hrefType) continue;
    candidates.push({
      mediaType,
      path: `/${hrefType}/${match[3]}`,
      title: decodeHtml(match[4]),
      year: parseReleaseYear(match[5])
    });
  }
  return candidates;
}

/**
 * Busca la ficha de TMDB que mejor explique un título del catálogo.
 *
 * Devuelve null antes que devolver una ficha dudosa: una portada equivocada es
 * peor que la que ya había, porque nadie la revisa después. Pero null significa
 * solo eso, "no hay ficha que case": si la petición se cae, el error sube tal
 * cual. Antes se tragaba, y un corte de red se leía en el informe como que la
 * película no está en TMDB, que es justo lo contrario de lo que pasaba.
 */
async function findTmdbMatch(series) {
  const cacheKey = `${series.ContentType}|${series.Title}|${series.ReleaseYear || ''}`;
  if (matchCache.has(cacheKey)) return matchCache.get(cacheKey);

  if (!normalizeSearchTitle(series.Title)) {
    matchCache.set(cacheKey, null);
    return null;
  }

  const queries = getTmdbSearchQueries(series);
  const variants = queries.map(normalizeSearchTitle).filter(Boolean);
  const candidates = [];

  for (let index = 0; index < queries.length; index += 1) {
    const searchUrl = `${TMDB_BASE_URL}/search?query=${encodeURIComponent(queries[index])}`;
    const searchHtml = await requestText(searchUrl);
    // El título original acierta más que la traducción, pero solo cuando el
    // alias existe: por eso la ventaja baja con cada intento posterior.
    const queryBonus = index === 0 ? 0 : Math.max(20 - index * 5, 5);
    candidates.push(
      ...parseTmdbSearchResults(searchHtml).map((candidate) => ({
        ...candidate,
        score: scoreTmdbCandidate(candidate, series, variants) + queryBonus
      }))
    );
  }

  candidates.sort((left, right) => right.score - left.score);

  const best = candidates[0];
  const match = !best || best.score < 40 ? null : best;
  matchCache.set(cacheKey, match);
  return match;
}

module.exports = {
  TMDB_BASE_URL,
  TMDB_TITLE_ALIASES,
  decodeHtml,
  findTmdbMatch,
  getTmdbSearchQueries,
  normalizeSearchTitle,
  parseReleaseYear,
  parseTmdbSearchResults,
  requestText,
  scoreTmdbCandidate
};
