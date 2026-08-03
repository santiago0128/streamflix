#!/usr/bin/env node

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { getPool } = require('../db');
const sharp = require('sharp');
const MEDIA_DIR = path.join(__dirname, '..', '..', 'media');
const BACKDROPS_DIR = path.join(MEDIA_DIR, 'backdrops');
const TARGET_WIDTH = 1920;
const TARGET_HEIGHT = 1080;
const ANILIST_API = 'https://graphql.anilist.co';
const animeArtworkCache = new Map();

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

function normalizeAnimeSearchTitle(title) {
  return String(title || '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\b(original|tv|sub español|latino)\b/gi, '')
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
          'User-Agent': 'NoxisBackdropGenerator/1.0'
        },
        timeout: 20000
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            return reject(new Error(`AniList HTTP ${res.statusCode}`));
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

async function fetchAnimeArtwork(series) {
  const cacheKey = `${series.SourceRef || ''}|${series.Title}`;
  if (animeArtworkCache.has(cacheKey)) return animeArtworkCache.get(cacheKey);

  const search = normalizeAnimeSearchTitle(series.Title);
  if (!search) {
    animeArtworkCache.set(cacheKey, null);
    return null;
  }

  try {
    const response = await postJson(ANILIST_API, {
      query: `
        query ($search: String) {
          Media(search: $search, type: ANIME) {
            bannerImage
            coverImage { extraLarge large }
          }
        }
      `,
      variables: { search }
    });

    const media = response?.data?.Media || null;
    const artwork = media
      ? {
          backdropUrl: media.bannerImage || media.coverImage?.extraLarge || media.coverImage?.large || null,
          posterUrl: media.coverImage?.extraLarge || media.coverImage?.large || null
        }
      : null;
    animeArtworkCache.set(cacheKey, artwork);
    return artwork;
  } catch {
    animeArtworkCache.set(cacheKey, null);
    return null;
  }
}

async function chooseSourceUrl(series) {
  if (series.ContentType === 'anime') {
    const artwork = await fetchAnimeArtwork(series);
    if (artwork?.backdropUrl) {
      return artwork.backdropUrl;
    }
    if (artwork?.posterUrl) {
      return artwork.posterUrl;
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
  const sourceUrl = await chooseSourceUrl(series);
  if (!sourceUrl) {
    return { ok: false, reason: 'sin imagen origen' };
  }

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
      SELECT Id, Title, ContentType, PosterUrl, BackdropUrl
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
