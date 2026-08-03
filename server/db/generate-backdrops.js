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
const TMDB_BASE_URL = 'https://www.themoviedb.org';
const animeArtworkCache = new Map();
const tmdbArtworkCache = new Map();

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

function requestText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(
      url,
      {
        headers: {
          'User-Agent': 'NoxisBackdropGenerator/1.0',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 20000
      },
      (res) => {
        const status = res.statusCode || 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          return resolve(requestText(new URL(location, url).toString(), redirects - 1));
        }
        if (status >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${status}`));
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

function scoreTmdbCandidate(candidate, series) {
  const normalizedSeriesTitle = normalizeSearchTitle(series.Title);
  const normalizedCandidateTitle = normalizeSearchTitle(candidate.title);
  let score = 0;

  if (candidate.mediaType === 'tv' && series.ContentType === 'series') score += 40;
  if (candidate.mediaType === 'movie' && series.ContentType === 'movie') score += 40;
  if (normalizedCandidateTitle === normalizedSeriesTitle) score += 50;
  if (normalizedCandidateTitle.includes(normalizedSeriesTitle) || normalizedSeriesTitle.includes(normalizedCandidateTitle)) score += 25;

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

async function fetchTmdbArtwork(series) {
  const cacheKey = `${series.ContentType}|${series.Title}|${series.ReleaseYear || ''}`;
  if (tmdbArtworkCache.has(cacheKey)) return tmdbArtworkCache.get(cacheKey);

  const searchTitle = normalizeSearchTitle(series.Title);
  if (!searchTitle) {
    tmdbArtworkCache.set(cacheKey, null);
    return null;
  }

  try {
    const searchUrl = `${TMDB_BASE_URL}/search?query=${encodeURIComponent(series.Title)}`;
    const searchHtml = await requestText(searchUrl);
    const candidates = parseTmdbSearchResults(searchHtml)
      .map((candidate) => ({
        ...candidate,
        score: scoreTmdbCandidate(candidate, series)
      }))
      .sort((left, right) => right.score - left.score);

    const best = candidates[0];
    if (!best || best.score < 40) {
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
  if (series.ContentType === 'anime') {
    const artwork = await fetchAnimeArtwork(series);
    if (artwork?.backdropUrl) {
      return artwork.backdropUrl;
    }
    if (artwork?.posterUrl) {
      return artwork.posterUrl;
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
