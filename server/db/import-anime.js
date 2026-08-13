/**
 * =====================================================================
 *  StreamFlix — Importador de anime
 *
 *  Trae metadatos reales desde la API pública de Kitsu (sin API key) y
 *  los inserta en la base: serie, géneros, temporada y episodios.
 *
 *  Uso:
 *    npm run db:anime -- "one punch"        -> busca, muestra qué encontró y pide confirmación
 *    npm run db:anime -- 7442               -> por id de Kitsu
 *    npm run db:anime -- 3936 --dry-run     -> sólo muestra, no escribe nada
 *    npm run db:anime -- 3936 --force       -> borra y vuelve a importar
 *    npm run db:anime -- 3936 --yes         -> sin confirmación interactiva
 *
 *  ORIGEN DEL VIDEO (obligatorio elegir uno):
 *    --media-dir <ruta>     usa tus propios archivos de video locales
 *    --placeholder-video    rellena con películas libres (Creative Commons)
 *
 *  Los episodios reales de un anime son contenido con licencia y no se pueden
 *  distribuir, así que este script NO puede traer el video real. Con
 *  `--placeholder-video` cada episodio apunta a una película de la Blender
 *  Foundation: sirve para probar el reproductor, pero NO es la serie. La
 *  verificación (`npm run db:verify`) lo marcará como error a propósito.
 * =====================================================================
 */
require('dotenv').config();
const https = require('https');
const { sql, getPool } = require('../db');
const { imagenViva } = require('../lib/imagen');

/**
 * Primera de las URLs que responda de verdad, o null si ninguna.
 *
 * Kitsu publica varios tamaños de cada imagen y no todos existen en todas las
 * fichas: guardar el primero de la lista sin mirar es cómo entran las portadas
 * que dan 404, y eso no se descubre hasta que alguien abre la ficha en la web.
 */
async function primeraImagenViva(candidatas, etiqueta) {
  const urls = candidatas.filter(Boolean);
  for (const url of urls) {
    const estado = await imagenViva(url);
    if (estado.ok) return url;
    console.log(`  ⚠ ${etiqueta} descartada (${estado.status || estado.motivo}): ${url}`);
  }
  if (urls.length) console.log(`  ⚠ ninguna ${etiqueta} de Kitsu responde; se queda sin ella`);
  return null;
}

const DEFAULT_ANIME = '3936'; // Fullmetal Alchemist: Brotherhood

// ---------------------------------------------------------------------
// Videos de reproducción — películas libres (CC-BY, Blender Foundation).
// Se reparten en orden entre los episodios.
// ---------------------------------------------------------------------
const VIDEO_POOL = [
  { url: 'https://archive.org/download/big-buck-bunny-512kb_202603/BigBuckBunny_512kb.mp4', durationSec: 596 },
  { url: 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4', durationSec: 653 },
  { url: 'https://archive.org/download/tears-of-steel_202504/Tears%20of%20Steel.mp4', durationSec: 735 },
  { url: 'https://archive.org/download/Sintel/sintel-2048-stereo_512kb.mp4', durationSec: 888 },
  { url: 'https://archive.org/download/cosmos-laundromat/Cosmos%20Laundromat.mp4', durationSec: 730 },
];

const INTRO_END_SEC = 90; // duración típica de un opening
const OUTRO_LEAD_SEC = 60; // cuánto antes del final arranca el ending

// Géneros de Kitsu (inglés) -> nombres en español de la tabla Genres
const GENRE_MAP = {
  Action: 'Acción', Adventure: 'Aventura', Comedy: 'Comedia', Drama: 'Drama',
  Fantasy: 'Fantasía', Magic: 'Magia', Military: 'Militar', Mystery: 'Misterio',
  Romance: 'Romance', Horror: 'Terror', Thriller: 'Suspenso', Psychological: 'Psicológico',
  Supernatural: 'Sobrenatural', Sports: 'Deportes', Music: 'Musical', Mecha: 'Mecha',
  Historical: 'Histórico', School: 'Escolar', Space: 'Espacial', Demons: 'Demonios',
  Documentary: 'Documental', Police: 'Policial', Samurai: 'Samurái', Vampire: 'Vampiros',
  'Science Fiction': 'Ciencia Ficción', 'Sci-Fi': 'Ciencia Ficción',
  'Slice of Life': 'Recuentos de la vida', 'Super Power': 'Superpoderes',
  'Martial Arts': 'Artes Marciales', 'Mahou Shoujo': 'Chicas Mágicas',
};

// Géneros que se añaden siempre a lo importado, para poder filtrar el catálogo
const ALWAYS_GENRES = ['Anime', 'Animación'];

// Descripciones en español escritas a mano (Kitsu las entrega en inglés)
const DESCRIPTION_OVERRIDES = {
  3936:
    'Tras intentar la transmutación humana —el único acto prohibido de la alquimia— para revivir a su madre, ' +
    'los hermanos Edward y Alphonse Elric pagan un precio terrible: Edward pierde una pierna y Alphonse el cuerpo entero. ' +
    'Al sacrificar también su brazo, Edward logra atar el alma de su hermano a una armadura. Años después, convertido en ' +
    'Alquimista Federal y apodado el Alquimista de Acero, Edward recorre el país junto a Alphonse buscando la Piedra Filosofal, ' +
    'lo único capaz de devolverles lo que perdieron. La búsqueda los arrastra a una conspiración militar mucho más oscura de lo que imaginaban.',
};

// ---------------------------------------------------------------------
// Utilidades HTTP
// ---------------------------------------------------------------------
function getJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Demasiadas redirecciones'));
    const req = https.get(
      url,
      { headers: { Accept: 'application/vnd.api+json', 'User-Agent': 'StreamFlix/0.1' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(getJson(new URL(res.headers.location, url).toString(), redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} en ${url}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error(`Respuesta no es JSON: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('Timeout consultando Kitsu')));
  });
}

/** Quita etiquetas HTML y decodifica las entidades más comunes. */
function stripHtml(text) {
  if (!text) return null;
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Escanea una carpeta de videos locales y los asocia a números de episodio.
 * Reconoce patrones tipo "E01", "- 01 -", "cap1", "1x05" o simplemente un
 * número en el nombre. Los archivos se sirven desde /media (ver server/index.js).
 */
function scanMediaDir(dir) {
  const fs = require('fs');
  const path = require('path');
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`La carpeta ${abs} no existe`);

  // Los archivos se sirven desde <proyecto>/media, así que la carpeta tiene que
  // estar dentro. Guardamos la ruta relativa para no perder el subdirectorio.
  const mediaRoot = path.join(__dirname, '..', '..', 'media');
  const rel = path.relative(mediaRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `La carpeta debe estar dentro de ${mediaRoot}\n` +
      `   (es la que el servidor publica en /media). Mueve los videos ahí.`
    );
  }
  const urlPrefix = rel ? `${rel.split(path.sep).map(encodeURIComponent).join('/')}/` : '';

  const exts = new Set(['.mp4', '.m4v', '.webm', '.mkv', '.m3u8']);
  const files = fs.readdirSync(abs)
    .filter((f) => exts.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const byNumber = new Map();
  for (const f of files) {
    const base = path.basename(f, path.extname(f));
    const m = base.match(/(?:^|[^\d])(?:e|ep|cap(?:itulo)?|\d+x)?\s*0*(\d{1,3})(?:[^\d]|$)/i);
    if (m) {
      const n = Number(m[1]);
      if (!byNumber.has(n)) byNumber.set(n, f);
    }
  }
  return { dir: abs, files, byNumber, urlPrefix };
}

/** Ficha de lo que se va a importar, para revisar antes de escribir en la base. */
function printCandidate(anime, at, episodes, genreNames, videoMode, portadaElegida) {
  const t = at.titles || {};
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  console.log(`  ${t.en || at.canonicalTitle}`);
  if (t.en_jp) console.log(`  ${t.en_jp}`);
  if (t.ja_jp) console.log(`  ${t.ja_jp}`);
  console.log(line);
  console.log(`  Kitsu id .......... ${anime.id}`);
  console.log(`  Tipo / estado ..... ${at.subtype || '?'} · ${at.status || '?'}`);
  console.log(`  Emisión ........... ${at.startDate || '?'} → ${at.endDate || 'en curso'}`);
  console.log(`  Episodios ......... ${episodes.length} descargados / ${at.episodeCount ?? '?'} según la fuente`);
  console.log(`  Duración por ep ... ${at.episodeLength ? at.episodeLength + ' min' : '?'}`);
  console.log(`  Puntuación ........ ${at.averageRating || '?'} / 100`);
  console.log(`  Géneros ........... ${genreNames.join(', ') || '(ninguno)'}`);
  // La que se va a guardar, que no siempre es el "original" de Kitsu: si ese no
  // responde se cae al siguiente tamaño, y la ficha debe enseñar lo que de
  // verdad se escribe.
  console.log(`  Portada ........... ${portadaElegida || '(sin portada)'}`);
  console.log(line);
  if (videoMode.kind === 'placeholder') {
    console.log(`  ⚠️  VIDEO DE RELLENO — no es la serie`);
    console.log(`      Los ${episodes.length} episodios apuntarán a películas libres de la`);
    console.log(`      Blender Foundation (10-15 min), no a episodios de este anime.`);
    console.log(`      Sirve para probar el reproductor. 'npm run db:verify' lo marcará`);
    console.log(`      como error a propósito.`);
  } else {
    console.log(`  Video ............. archivos locales de ${videoMode.dir}`);
    console.log(`                      ${videoMode.files.length} archivo(s) encontrado(s)`);
  }
  console.log(`${line}\n`);
}

/** Pregunta S/N por consola. Si no hay TTY, no pregunta. */
function confirm(question) {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [s/N] `, (a) => {
      rl.close();
      resolve(/^s(i|í)?$/i.test(a.trim()));
    });
  });
}

// ---------------------------------------------------------------------
// Consultas a Kitsu
// ---------------------------------------------------------------------
const KITSU = 'https://kitsu.io/api/edge';

async function resolveAnime(arg) {
  if (/^\d+$/.test(arg)) {
    const res = await getJson(`${KITSU}/anime/${arg}`);
    return res.data;
  }
  const res = await getJson(`${KITSU}/anime?filter[text]=${encodeURIComponent(arg)}&page[limit]=1`);
  if (!res.data || !res.data.length) throw new Error(`Sin resultados en Kitsu para "${arg}"`);
  return res.data[0];
}

async function fetchGenres(animeId) {
  const res = await getJson(`${KITSU}/anime/${animeId}/genres?page[limit]=20`);
  return (res.data || []).map((g) => g.attributes.name);
}

async function fetchEpisodes(animeId) {
  const all = [];
  const limit = 20;
  for (let offset = 0; ; offset += limit) {
    const res = await getJson(
      `${KITSU}/anime/${animeId}/episodes?page[limit]=${limit}&page[offset]=${offset}&sort=number`
    );
    const batch = res.data || [];
    all.push(...batch);
    const total = (res.meta && res.meta.count) || all.length;
    if (all.length >= total || batch.length === 0) break;
  }
  return all
    .map((e) => e.attributes)
    .filter((a) => a && a.number != null)
    .sort((a, b) => a.number - b.number);
}

// ---------------------------------------------------------------------
// Inserción en base de datos
// ---------------------------------------------------------------------

/** Inserta los géneros que falten y devuelve un mapa nombre -> Id. */
async function ensureGenres(pool, names) {
  const ids = {};
  for (const name of names) {
    const found = await pool.request()
      .input('name', sql.NVarChar(50), name)
      .query('SELECT Id FROM dbo.Genres WHERE Name = @name');
    if (found.recordset.length) {
      ids[name] = found.recordset[0].Id;
    } else {
      const ins = await pool.request()
        .input('name', sql.NVarChar(50), name)
        .query('INSERT INTO dbo.Genres (Name) OUTPUT INSERTED.Id VALUES (@name)');
      ids[name] = ins.recordset[0].Id;
      console.log(`   + género nuevo: ${name}`);
    }
  }
  return ids;
}

async function importAnime(arg, opts) {
  const force = opts.force;
  console.log(`→ Buscando "${arg}" en Kitsu…`);
  const anime = await resolveAnime(arg);
  const at = anime.attributes;

  const title = at.titles.en || at.canonicalTitle || at.titles.en_jp;
  const description =
    DESCRIPTION_OVERRIDES[anime.id] || stripHtml(at.description || at.synopsis);
  // Kitsu ofrece varios tamaños de cada imagen y no todos existen siempre: hay
  // fichas cuyo "original" da 404 aunque el "large" esté bien. Se elige el
  // primero que responda de verdad, en vez de dar por buena la primera URL que
  // aparezca — una portada rota no se nota hasta que alguien abre la ficha.
  const poster = await primeraImagenViva(
    [at.posterImage && at.posterImage.original, at.posterImage && at.posterImage.large,
     at.posterImage && at.posterImage.medium],
    'portada'
  );
  const backdrop = await primeraImagenViva(
    [at.coverImage && at.coverImage.large, at.coverImage && at.coverImage.original],
    'banner'
  );
  const year = at.startDate ? Number(at.startDate.slice(0, 4)) : null;
  // Kitsu puntúa sobre 100; la tabla guarda sobre 10.
  const rating = at.averageRating ? Math.round(Number(at.averageRating)) / 10 : null;

  console.log(`→ Encontrado: ${title} (${year}) — Kitsu id ${anime.id}`);

  const [genreNames, episodes] = await Promise.all([
    fetchGenres(anime.id),
    fetchEpisodes(anime.id),
  ]);
  console.log(`→ ${episodes.length} episodios y ${genreNames.length} géneros descargados`);
  if (!episodes.length) throw new Error('Kitsu no devolvió episodios para esta serie');

  // ---- Capa de verificación: mostrar qué se encontró y confirmar ----
  printCandidate(anime, at, episodes, genreNames, opts.videoMode, poster);

  if (opts.dryRun) {
    console.log('🔎 --dry-run: no se escribió nada en la base.');
    return;
  }
  if (!opts.yes && !(await confirm('¿Es ésta la serie que quieres importar?'))) {
    console.log('Cancelado.');
    return;
  }

  const pool = await getPool();

  // ¿Ya existe?
  const existing = await pool.request()
    .input('title', sql.NVarChar(200), title)
    .query('SELECT Id FROM dbo.Series WHERE Title = @title');
  if (existing.recordset.length) {
    if (!force) {
      console.log(`⚠️  "${title}" ya está en la base (Id ${existing.recordset[0].Id}). Usa --force para reimportar.`);
      return;
    }
    await pool.request()
      .input('id', sql.Int, existing.recordset[0].Id)
      .query('DELETE FROM dbo.Series WHERE Id = @id');
    console.log(`→ Serie anterior borrada (--force)`);
  }

  // Géneros: los mapeados + los fijos, sin repetir
  const mapped = genreNames.map((g) => GENRE_MAP[g]).filter(Boolean);
  const allGenres = [...new Set([...ALWAYS_GENRES, ...mapped])];
  const genreIds = await ensureGenres(pool, allGenres);

  // Serie
  const seriesIns = await pool.request()
    .input('title', sql.NVarChar(200), title)
    .input('description', sql.NVarChar(sql.MAX), description)
    .input('poster', sql.NVarChar(500), poster)
    .input('backdrop', sql.NVarChar(500), backdrop)
    .input('year', sql.Int, year)
    .input('rating', sql.Decimal(3, 1), rating)
    .input('contentType', sql.NVarChar(20), 'anime')
    .input('sourceRef', sql.NVarChar(100), `kitsu:${anime.id}`)
    .query(`INSERT INTO dbo.Series (Title, Description, PosterUrl, BackdropUrl, ReleaseYear, Rating, ContentType, SourceRef)
            OUTPUT INSERTED.Id
            VALUES (@title, @description, @poster, @backdrop, @year, @rating, @contentType, @sourceRef)`);
  const seriesId = seriesIns.recordset[0].Id;
  console.log(`→ Serie insertada (Id ${seriesId})`);

  for (const name of allGenres) {
    await pool.request()
      .input('s', sql.Int, seriesId)
      .input('g', sql.Int, genreIds[name])
      .query('INSERT INTO dbo.SeriesGenres (SeriesId, GenreId) VALUES (@s, @g)');
  }

  // Temporada única — la serie se emitió como un solo bloque continuo
  const seasonIns = await pool.request()
    .input('s', sql.Int, seriesId)
    .input('n', sql.Int, 1)
    .input('t', sql.NVarChar(200), 'Temporada 1')
    .query(`INSERT INTO dbo.Seasons (SeriesId, SeasonNumber, Title)
            OUTPUT INSERTED.Id VALUES (@s, @n, @t)`);
  const seasonId = seasonIns.recordset[0].Id;

  // Episodios
  const nominalSec = at.episodeLength ? at.episodeLength * 60 : null;
  let n = 0;
  let sinVideo = 0;
  for (const ep of episodes) {
    // Origen del video según el modo elegido
    let video;
    if (opts.videoMode.kind === 'media-dir') {
      const file = opts.videoMode.byNumber.get(ep.number);
      if (!file) { sinVideo++; n++; continue; }
      // Duración nominal del episodio: `db:verify` comprueba luego la real.
      video = {
        url: `/media/${opts.videoMode.urlPrefix}${encodeURIComponent(file)}`,
        durationSec: nominalSec || 1440,
        provider: /\.m3u8$/i.test(file) ? 'hls' : 'file',
      };
    } else {
      video = VIDEO_POOL[n % VIDEO_POOL.length];
    }

    const epTitle = ep.canonicalTitle || (ep.titles && ep.titles.en) || `Episodio ${ep.number}`;
    const thumb = (ep.thumbnail && (ep.thumbnail.original || ep.thumbnail.large)) || poster;

    await pool.request()
      .input('season', sql.Int, seasonId)
      .input('num', sql.Int, ep.number)
      .input('title', sql.NVarChar(200), epTitle)
      .input('desc', sql.NVarChar(sql.MAX), stripHtml(ep.synopsis || ep.description))
      .input('video', sql.NVarChar(1000), video.url)
      .input('thumb', sql.NVarChar(500), thumb)
      .input('dur', sql.Int, video.durationSec)
      .input('introStart', sql.Int, 0)
      .input('introEnd', sql.Int, INTRO_END_SEC)
      .input('outroStart', sql.Int, Math.max(0, video.durationSec - OUTRO_LEAD_SEC))
      .input('provider', sql.NVarChar(20), video.provider || 'file')
      .query(`INSERT INTO dbo.Episodes
                (SeasonId, EpisodeNumber, Title, Description, VideoUrl, Provider, ThumbnailUrl,
                 DurationSec, IntroStartSec, IntroEndSec, OutroStartSec)
              VALUES (@season, @num, @title, @desc, @video, @provider, @thumb,
                      @dur, @introStart, @introEnd, @outroStart)`);
    n++;
  }

  const insertados = n - sinVideo;
  console.log(`✅ "${title}" importada: ${insertados} episodios, géneros: ${allGenres.join(', ')}`);
  if (sinVideo) {
    console.log(`⚠️  ${sinVideo} episodio(s) omitidos: no había archivo de video para su número.`);
  }
  if (opts.videoMode.kind === 'placeholder') {
    console.log(`\n⚠️  Recuerda: el video NO es de esta serie, es relleno libre.`);
  }
  console.log(`\n   Verifica el resultado con:  npm run db:verify -- ${seriesId}`);
}

// ---------------------------------------------------------------------
const args = process.argv.slice(2);

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const opts = {
  force: args.includes('--force'),
  dryRun: args.includes('--dry-run'),
  yes: args.includes('--yes'),
};

const mediaDir = flagValue('--media-dir');
const usePlaceholder = args.includes('--placeholder-video');

if (mediaDir && usePlaceholder) {
  console.error('❌ Elige sólo uno: --media-dir o --placeholder-video.');
  process.exit(1);
}
if (!mediaDir && !usePlaceholder) {
  console.error(`❌ Falta indicar de dónde sale el video.

   Este script trae metadatos reales (portada, sinopsis, episodios), pero NO
   puede traer el video: los episodios de un anime son contenido con licencia.

   Elige uno:

     --media-dir <ruta>    usa tus propios archivos de video de esa carpeta.
                           Se emparejan por número de episodio en el nombre
                           (E01, cap01, 1x05, …) y se sirven desde /media.

     --placeholder-video   rellena con películas libres de la Blender Foundation.
                           Sirve para probar el reproductor, pero NO es la serie
                           y 'npm run db:verify' lo marcará como error.

   Ejemplo:
     npm run db:anime -- 3936 --media-dir ./media/fmab
`);
  process.exit(1);
}

let videoMode;
try {
  videoMode = mediaDir
    ? { kind: 'media-dir', ...scanMediaDir(mediaDir) }
    : { kind: 'placeholder' };
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}
opts.videoMode = videoMode;

// El target es el primer argumento que no sea una bandera ni el valor de una
const flagsWithValue = ['--media-dir'];
const target = args.filter((a, i) => {
  if (a.startsWith('--')) return false;
  if (i > 0 && flagsWithValue.includes(args[i - 1])) return false;
  return true;
})[0] || DEFAULT_ANIME;

importAnime(target, opts)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error importando:', err.message);
    process.exit(1);
  });
