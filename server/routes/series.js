const http = require('http');
const https = require('https');
const express = require('express');
const { sql, getPool } = require('../db');

const router = express.Router();

function getHttpClient(url) {
  return url.startsWith('https:') ? https : http;
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

// GET /api/series?search=&genre=   -> catálogo con búsqueda y filtro por género
router.get('/series', async (req, res) => {
  const search = (req.query.search || '').trim() || null;
  const genre = (req.query.genre || '').trim() || null;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('search', sql.NVarChar, search)
      .input('genre', sql.NVarChar, genre)
      .query(`
        SELECT s.Id, s.Title, s.Description, s.PosterUrl, s.BackdropUrl, s.ReleaseYear, s.Rating,
               (SELECT STRING_AGG(g.Name, ', ')
                  FROM dbo.SeriesGenres sg JOIN dbo.Genres g ON g.Id = sg.GenreId
                 WHERE sg.SeriesId = s.Id) AS Genres
          FROM dbo.Series s
         WHERE (@search IS NULL OR s.Title LIKE '%' + @search + '%')
           AND (@genre  IS NULL OR EXISTS (
                 SELECT 1 FROM dbo.SeriesGenres sg JOIN dbo.Genres g ON g.Id = sg.GenreId
                  WHERE sg.SeriesId = s.Id AND g.Name = @genre))
         ORDER BY s.Title`);
    res.json(result.recordset);
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
            if (provider === 'embed' || provider === 'hls') {
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
          sr.SourceRef,
          snap.VideoSrcUrl,
          snap.VideoSrcReferer,
          snap.VerifiedVideoUrl,
          snap.VerifiedVideoReferer
        FROM dbo.Episodes e
        JOIN dbo.Seasons se ON se.Id = e.SeasonId
        JOIN dbo.Series sr ON sr.Id = se.SeriesId
        OUTER APPLY (
          SELECT TOP 1
            js.VideoSrcUrl,
            js.VideoSrcReferer,
            js.VerifiedVideoUrl,
            js.VerifiedVideoReferer
          FROM dbo.JkAnimeEpisodeSnapshots js
          WHERE js.SeriesSlug = REPLACE(sr.SourceRef, 'jkanime:', '')
            AND js.EpisodeNumber = e.EpisodeNumber
          ORDER BY js.UpdatedAt DESC, js.Id DESC
        ) snap
        WHERE e.Id = @id
      `);

    const episode = result.recordset[0];
    if (!episode) {
      return res.status(404).json({ error: 'Episodio no encontrado' });
    }

    const provider = String(episode.Provider || 'file').toLowerCase();
    if (provider === 'embed') {
      return res.status(400).json({ error: 'Este episodio usa un embed externo' });
    }

    const candidates = [
      { url: episode.VideoSrcUrl, referer: episode.VideoSrcReferer },
      { url: episode.VerifiedVideoUrl, referer: episode.VerifiedVideoReferer },
      { url: episode.VideoUrl, referer: null }
    ].filter((item) => item.url && item.url !== 'NO_VIDEO_FOUND');

    if (!candidates.length) {
      return res.status(404).json({ error: 'No se encontró una fuente de video reproducible' });
    }

    const selected = candidates[0];

    if (selected.url.startsWith('/media/')) {
      return res.redirect(selected.url);
    }

    const forwardedHeaders = {
      'User-Agent': req.get('user-agent') || 'StreamFlix/1.0',
      Accept: req.get('accept') || '*/*'
    };

    if (req.headers.range) forwardedHeaders.Range = req.headers.range;
    if (selected.referer) forwardedHeaders.Referer = selected.referer;

    const { response: upstream } = await requestUpstream(selected.url, forwardedHeaders);

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
