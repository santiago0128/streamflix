/**
 * Búsqueda de fichas en themoviedb.org, compartida por los scripts de imágenes.
 *
 * Con `TMDB_API_KEY` pregunta a la API; sin ella raspa la web pública, que es
 * como nació y lo que permite estrenar un servidor sin registrar nada. Los dos
 * caminos aplican los mismos filtros de identidad: cambia la fuente, no el
 * rigor con el que se acepta una ficha.
 *
 * La API vale la pena cuando está disponible porque el buscador público no
 * indexa los títulos de estreno latinoamericanos —"Sueño de fuga" y "Parásitos"
 * devuelven "Sin resultados"— y el catálogo se importa de sitios que titulan
 * justamente así. Además devuelve el título original junto al traducido y la
 * ruta de la portada en la propia búsqueda, con lo que sobra abrir la ficha.
 *
 * Aquí vive solo la parte de "encontrar la ficha correcta". Qué imagen sacar de
 * ella es cosa de cada script: el banner y la portada están en etiquetas
 * distintas de la misma página.
 */

const http = require('http');
const https = require('https');

const TMDB_BASE_URL = 'https://www.themoviedb.org';
const USER_AGENT = 'NoxisArtwork/1.0';
const MIN_REQUEST_GAP_MS = 800;

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

function get(url, redirects = 5, cabeceras = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...cabeceras
        },
        timeout: 20000
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          return resolve(get(new URL(location, url).toString(), redirects - 1, cabeceras));
        }
        if (status >= 400) {
          res.resume();
          const error = new Error(`HTTP ${status}`);
          error.status = status;
          const retryAfter = Number(res.headers['retry-after']);
          error.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 0;
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

async function requestText(url, { headers = {} } = {}) {
  let ultimoError;
  for (let intento = 0; intento < 4; intento += 1) {
    try {
      return await encolar(() => get(url, 5, headers));
    } catch (error) {
      ultimoError = error;
      if (!esPasajero(error)) throw error;
      await sleep(Math.max(error.retryAfterMs || 0, 2000 * 2 ** intento));
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

function isCompatibleMediaType(candidate, series) {
  return (series.ContentType === 'series' && candidate.mediaType === 'tv') ||
    (series.ContentType === 'movie' && candidate.mediaType === 'movie') ||
    // El anime puede aparecer como serie o película; su identidad principal se
    // valida en AniList y TMDB solo es el respaldo gráfico.
    series.ContentType === 'anime';
}

function isStrongTitleMatch(candidate, series, titleVariants) {
  // La API devuelve el título traducido y el original, y la ficha del catálogo
  // puede venir por cualquiera de los dos: "Sueño de fuga" es el traducido de
  // "The Shawshank Redemption". Al raspar sólo hay uno, así que `titles` cae
  // en `title` y el comportamiento no cambia.
  const candidateTitles = (candidate.titles && candidate.titles.length
    ? candidate.titles
    : [candidate.title]
  ).map(normalizeSearchTitle).filter(Boolean);

  const variants = (titleVariants && titleVariants.length
    ? titleVariants
    : getTmdbSearchQueries(series).map(normalizeSearchTitle)
  ).filter(Boolean);

  // El tipo correcto no demuestra identidad. Antes daba 40 puntos, justo el
  // umbral de aceptación, de modo que el primer resultado "movie" podía ganar
  // aunque su título no tuviera una sola palabra en común con lo buscado.
  if (!candidateTitles.some((titulo) => variants.includes(titulo))) return false;

  if (series.ReleaseYear && candidate.year) {
    return Math.abs(series.ReleaseYear - candidate.year) <= 1;
  }
  return true;
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
const TMDB_API_URL = 'https://api.themoviedb.org/3';

const hayClave = () => Boolean(String(process.env.TMDB_API_KEY || '').trim());

/**
 * La API acepta la clave v3 como parámetro y el token v4 (un JWT, empieza por
 * "eyJ") como cabecera Bearer. Mandar el v4 en `api_key` responde "Invalid API
 * key", que se lee como clave equivocada y no como formato equivocado.
 */
async function pedirApi(ruta, parametros = {}) {
  const clave = String(process.env.TMDB_API_KEY || '').trim();
  const esTokenV4 = clave.startsWith('eyJ');
  const url = new URL(`${TMDB_API_URL}${ruta}`);
  url.searchParams.set('language', 'es-MX');
  for (const [k, v] of Object.entries(parametros)) if (v) url.searchParams.set(k, String(v));
  if (!esTokenV4) url.searchParams.set('api_key', clave);

  const texto = await requestText(url.toString(), {
    headers: esTokenV4 ? { Authorization: `Bearer ${clave}` } : {}
  });
  return JSON.parse(texto);
}

/**
 * Candidatos vía API. Es mejor que raspar la web por una razón concreta: el
 * buscador público no encuentra los títulos de estreno latinoamericanos —
 * "Sueño de fuga" y "Parásitos" devuelven "Sin resultados"— y el catálogo se
 * importa de sitios que titulan justamente así. La API sí los indexa, y además
 * devuelve el título original junto al traducido, que es lo que permite casar
 * la ficha venga con el nombre que venga.
 */
async function buscarPorApi(series, consulta) {
  const tipos = series.ContentType === 'series' ? ['tv'] : ['movie'];
  // El anime puede estar catalogado como película o como serie.
  if (series.ContentType === 'anime') tipos.push('tv');

  const candidatos = [];
  for (const tipo of tipos) {
    const datos = await pedirApi(`/search/${tipo}`, {
      query: consulta,
      year: tipo === 'movie' ? series.ReleaseYear || undefined : undefined,
      first_air_date_year: tipo === 'tv' ? series.ReleaseYear || undefined : undefined
    });
    for (const r of (datos.results || []).slice(0, 8)) {
      const fecha = r.release_date || r.first_air_date || '';
      candidatos.push({
        mediaType: tipo,
        path: `/${tipo}/${r.id}`,
        title: r.title || r.name || '',
        titles: [r.title, r.name, r.original_title, r.original_name].filter(Boolean),
        year: fecha ? Number(String(fecha).slice(0, 4)) : null,
        // Viene en la respuesta, así que no hace falta abrir la ficha después.
        posterPath: r.poster_path || null,
        backdropPath: r.backdrop_path || null
      });
    }
  }
  return candidatos;
}

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

  // Con clave se pregunta a la API, que encuentra los títulos de estreno
  // latinoamericanos; sin ella se raspa la web pública, que es como funcionaba
  // antes y sigue funcionando en un servidor sin registrar. Los filtros de
  // identidad son los mismos en los dos caminos: la fuente cambia, el rigor no.
  const porApi = hayClave();

  for (let index = 0; index < queries.length; index += 1) {
    // El título original acierta más que la traducción, pero solo cuando el
    // alias existe: por eso la ventaja baja con cada intento posterior.
    const queryBonus = index === 0 ? 0 : Math.max(20 - index * 5, 5);

    let encontrados;
    if (porApi) {
      encontrados = await buscarPorApi(series, queries[index]);
    } else {
      const searchUrl = `${TMDB_BASE_URL}/search?query=${encodeURIComponent(queries[index])}`;
      encontrados = parseTmdbSearchResults(await requestText(searchUrl));
    }

    candidates.push(...encontrados
      .filter((candidate) =>
        isCompatibleMediaType(candidate, series) && isStrongTitleMatch(candidate, series, variants))
      .map((candidate) => ({
        ...candidate,
        score: scoreTmdbCandidate(candidate, series, variants) + queryBonus
      }))
    );
  }

  const unique = [...new Map(candidates.map((candidate) => [candidate.path, candidate])).values()];
  unique.sort((left, right) => right.score - left.score);

  // Sin año guardado no hay con qué desambiguar, y varias películas distintas
  // pueden declarar exactamente el mismo título: hay una "Pantera Negra" de 1993
  // y otra de 1968, y ninguna es la de 2018. isStrongTitleMatch deja pasar a
  // todas cuando falta el año, así que elegir la de más puntos es adivinar.
  // Devolver null mantiene la promesa de la cabecera: antes ninguna que dudosa.
  if (!series.ReleaseYear && unique.length > 1) {
    matchCache.set(cacheKey, null);
    return null;
  }

  const best = unique[0];
  const match = best || null;
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
  scoreTmdbCandidate,
  isCompatibleMediaType,
  isStrongTitleMatch
};
