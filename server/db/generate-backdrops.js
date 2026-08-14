#!/usr/bin/env node

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { getPool } = require('../db');
const { TMDB_BASE_URL, findTmdbMatch, normalizeSearchTitle, requestText } = require('./tmdb');
const { fetchAnimeArtwork } = require('./anilist');
const sharp = require('sharp');
const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');
const BACKDROPS_DIR = path.join(MEDIA_DIR, 'backdrops');
// El banner ocupa el ancho entero de la ventana (64vh de alto, `cover`), así que
// en un portátil retina son unos 4000 píxeles de pantalla. Con 1920 se veía
// blando por pura falta de resolución; 2560 llega bien y sigue pesando poco
// porque estas fotos comprimen muy bien.
const TARGET_WIDTH = 2560;
const TARGET_HEIGHT = 1440;
const tmdbArtworkCache = new Map();
const BACKDROP_OVERRIDES = new Map([
  ['el padrino', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/tSPT36ZKlP2WVHJLM4cQPLSzv3b.jpg'],
  ['el padrino 2', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/kGzFbGhp99zva6oZODW5atUtnqi.jpg'],
  ['el padrino 3', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/zNnjHLDtV8Ti3aworltaeaLMov4.jpg'],
  ['matrix', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/tlm8UkiQsitc8rSuIAscQDCnP8d.jpg'],
  ['gladiador', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/jhk6D8pim3yaByu1801kMoxXFaX.jpg'],
  ['el rey leon', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/q00H8EqULYSK74lgevMkhmGGLHn.jpg'],
  ['el gran showman', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/lrNKm3HNvGdZoAfiBKu7b04FLHN.jpg'],
  ['stranger things', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/56v2KjBlU4XaOv9rVYEQypROD7P.jpg'],
  ['the last of us', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/acevLdSl5I2MK5RYAm7gwAndt1w.jpg'],
  ['la casa del dragon', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/577eXC8wFQT0eUrJcgznSiFPRmk.jpg'],
  ['parque jurasico', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/o7LzVmlOSYc3EspyVMC9bsTTARc.jpg'],
  ['el increible hulk', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/jPu8yiadqgzwFPGKJmGo637ASVP.jpg'],
  ['spider-man', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/zQ8AxTPiCiS5nnwXpwTBPBHSaa5.jpg'],
  ['spider-man homecoming', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/fn4n6uOYcB6Uh89nbNPoU2w80RV.jpg'],
  ['spider-man no way home', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/14QbnygCuTO0vl7CAFmPf1fgZfV.jpg'],
  ['the office', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/mLyW3UTgi2lsMdtueYODcfAB9Ku.jpg'],
  ['rick and morty', 'https://media.themoviedb.org/t/p/w1066_and_h600_face/i4PpW1XyRlBuSNSIBRIIwSjEpjl.jpg']
]);

function parseArgs(argv) {
  const args = { apply: false, force: false, ids: null };

  for (const token of argv) {
    if (token === '--apply') args.apply = true;
    else if (token === '--force') args.force = true;
    else if (token.startsWith('--ids=')) {
      args.ids = token
        .slice('--ids='.length)
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
    }
  }

  return args;
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'titulo';
}

function isLocalBackdrop(url) {
  return typeof url === 'string' && url.startsWith('/media/backdrops/');
}

function extractTmdbBackdropUrl(html) {
  const backdropImg = html.match(/<img class="backdrop w-full"[^>]+srcset="([^"]+)"/i);
  if (backdropImg?.[1]) {
    const entries = backdropImg[1]
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
    if (entries.length) return entries[entries.length - 1];
  }

  const ogImages = [...html.matchAll(/<meta property="og:image" content="([^"]+)"/gi)]
    .map((match) => match[1])
    .filter((value) => /\/t\/p\/w(780|1280|1920|original)\//.test(value));
  if (ogImages.length > 1) return ogImages[1];
  if (ogImages.length) return ogImages[0];
  return null;
}

/**
 * Sube una URL de TMDB a su tamaño original.
 *
 * Las que aparecen en la página vienen recortadas para la propia web
 * (`/t/p/w1066_and_h600_face/…`, 1066 px de ancho). Bajar esa y estirarla a
 * 2560 es agrandar un JPEG pequeño: exactamente la pixelación que se veía en el
 * banner. TMDB guarda el mismo fichero en `/t/p/original/`, que suele ser de
 * 1920 o 3840, y de ahí se reduce en vez de ampliar.
 */
function enResolucionOriginal(url) {
  if (!/\/t\/p\/[^/]+\//.test(String(url || ''))) return url;
  return url.replace(/\/t\/p\/[^/]+\//, '/t/p/original/');
}

async function fetchTmdbArtwork(series) {
  const cacheKey = `${series.ContentType}|${series.Title}|${series.ReleaseYear || ''}`;
  if (tmdbArtworkCache.has(cacheKey)) return tmdbArtworkCache.get(cacheKey);

  try {
    const best = await findTmdbMatch(series);
    if (!best) {
      tmdbArtworkCache.set(cacheKey, null);
      return null;
    }

    const detailHtml = await requestText(`${TMDB_BASE_URL}${best.path}`);
    const backdropUrl = extractTmdbBackdropUrl(detailHtml);
    const artwork = backdropUrl ? { backdropUrl } : null;
    tmdbArtworkCache.set(cacheKey, artwork);
    return artwork;
  } catch {
    tmdbArtworkCache.set(cacheKey, null);
    return null;
  }
}

async function chooseSourceUrl(series) {
  const overrideUrl = BACKDROP_OVERRIDES.get(normalizeSearchTitle(series.Title));
  if (overrideUrl) {
    return overrideUrl;
  }

  if (series.ContentType === 'anime') {
    // TMDB primero también en anime, y no por gusto: el banner de AniList mide
    // unos 1900×400, y encajarlo en 16:9 obliga a triplicar su altura. Se veía
    // igual de blando que la miniatura que veníamos arrastrando. El backdrop de
    // TMDB ya viene en 16:9 y se reduce, que es lo que se quiere.
    // AniList se queda de respaldo: si no hay ficha en TMDB, mejor su banner
    // que nada.
    const tmdbArtwork = await fetchTmdbArtwork(series);
    if (tmdbArtwork?.backdropUrl) {
      return tmdbArtwork.backdropUrl;
    }
    const animeArtwork = await fetchAnimeArtwork(series).catch(() => null);
    if (animeArtwork?.backdropUrl) {
      return animeArtwork.backdropUrl;
    }
    if (animeArtwork?.posterUrl) {
      return animeArtwork.posterUrl;
    }
  }

  if (series.ContentType === 'series' || series.ContentType === 'movie') {
    const artwork = await fetchTmdbArtwork(series);
    if (artwork?.backdropUrl) {
      return artwork.backdropUrl;
    }
  }

  if (series.BackdropUrl && !isLocalBackdrop(series.BackdropUrl) && series.BackdropUrl !== series.PosterUrl) {
    return series.BackdropUrl;
  }
  return series.PosterUrl || series.BackdropUrl || null;
}

function fileExtensionFrom(url, contentType) {
  const fromType = (() => {
    if (/png/i.test(contentType || '')) return '.png';
    if (/webp/i.test(contentType || '')) return '.webp';
    if (/gif/i.test(contentType || '')) return '.gif';
    return '.jpg';
  })();

  try {
    const ext = path.extname(new URL(url).pathname);
    return ext && ext.length <= 5 ? ext : fromType;
  } catch {
    return fromType;
  }
}

function requestBuffer(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': 'NoxisBackdropGenerator/1.0',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        },
        timeout: 20000
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          return resolve(requestBuffer(new URL(location, url).toString(), redirects - 1));
        }
        if (status >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
        }

        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            buffer: Buffer.concat(chunks),
            contentType: res.headers['content-type'] || ''
          });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado')));
    req.on('error', reject);
  });
}

async function ensureBackdropFromFile(inputFile, outputFile) {
  await sharp(inputFile)
    .resize(TARGET_WIDTH, TARGET_HEIGHT, {
      fit: 'cover',
      position: 'centre'
    })
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(outputFile);
}

async function createBackdrop(series) {
  const elegida = await chooseSourceUrl(series);
  if (!elegida) {
    return { ok: false, reason: 'sin imagen origen' };
  }
  const sourceUrl = enResolucionOriginal(elegida);

  const fileBase = `${String(series.Id).padStart(4, '0')}-${slugify(series.Title)}`;
  const targetRelativeUrl = `/media/backdrops/${fileBase}.jpg`;
  const outputFile = path.join(BACKDROPS_DIR, `${fileBase}.jpg`);

  await fsp.mkdir(BACKDROPS_DIR, { recursive: true });

  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'noxis-backdrop-'));
  try {
    const downloaded = await requestBuffer(sourceUrl);
    const inputFile = path.join(tmpDir, `source${fileExtensionFrom(sourceUrl, downloaded.contentType)}`);
    await fsp.writeFile(inputFile, downloaded.buffer);
    await ensureBackdropFromFile(inputFile, outputFile);
    return { ok: true, url: targetRelativeUrl, sourceUrl };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = await getPool();

  try {
    const idsFilter = args.ids?.length
      ? `WHERE Id IN (${args.ids.join(',')})`
      : '';

    const result = await pool.request().query(`
      SELECT Id, Title, ContentType, ReleaseYear, PosterUrl, BackdropUrl
      FROM dbo.Series
      ${idsFilter}
      ORDER BY Id
    `);

    const rows = result.recordset.filter((series) => {
      if (args.force) return true;
      return !isLocalBackdrop(series.BackdropUrl);
    });

    if (!rows.length) {
      console.log('No hay títulos pendientes de generar banner local.');
      return;
    }

    console.log(`${rows.length} título(s) ${args.apply ? 'a procesar' : 'detectado(s)'} para banner HD\n`);

    for (const series of rows) {
      try {
        const outcome = await createBackdrop(series);
        if (!outcome.ok) {
          console.log(`#${series.Id} ${series.Title} — omitido: ${outcome.reason}`);
          continue;
        }

        if (args.apply) {
          await pool
            .request()
            .input('id', series.Id)
            .input('backdropUrl', outcome.url)
            .query(`
              UPDATE dbo.Series
              SET BackdropUrl = @backdropUrl
              WHERE Id = @id
            `);
        }

        console.log(`#${series.Id} ${series.Title} — banner listo desde ${outcome.sourceUrl}`);
      } catch (error) {
        console.log(`#${series.Id} ${series.Title} — fallo: ${error.message || error}`);
      }
    }

    console.log(`\n${args.apply ? 'Banners aplicados en la base.' : 'Simulación lista. Repite con --apply para escribir la base.'}`);
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
