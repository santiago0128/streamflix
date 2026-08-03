const express = require('express');
const { sql, getPool } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 24;

function completionThreshold(durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (durationSec <= 180) return Math.max(30, Math.floor(durationSec * 0.9));
  return Math.max(durationSec - 60, Math.floor(durationSec * 0.92));
}

router.get('/continue-watching', async (req, res) => {
  const requested = Math.trunc(Number(req.query.limit));
  const limit = Math.min(MAX_LIMIT, Math.max(1, requested || DEFAULT_LIMIT));

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('limit', sql.Int, limit)
      .query(`
        WITH RankedProgress AS (
          SELECT
            wp.PositionSec,
            wp.UpdatedAt,
            e.Id AS EpisodeId,
            e.Title AS EpisodeTitle,
            e.EpisodeNumber,
            e.DurationSec,
            se.Id AS SeasonId,
            se.SeasonNumber,
            s.Id AS SeriesId,
            s.Title,
            s.Description,
            s.PosterUrl,
            s.BackdropUrl,
            s.ReleaseYear,
            s.Rating,
            s.ContentType,
            ROW_NUMBER() OVER (PARTITION BY s.Id ORDER BY wp.UpdatedAt DESC, e.Id DESC) AS rn
          FROM dbo.WatchProgress wp
          JOIN dbo.Episodes e ON e.Id = wp.EpisodeId
          JOIN dbo.Seasons se ON se.Id = e.SeasonId
          JOIN dbo.Series s ON s.Id = se.SeriesId
          WHERE wp.UserId = @userId
        )
        SELECT TOP (@limit)
          rp.SeriesId,
          rp.Title,
          rp.Description,
          rp.PosterUrl,
          rp.BackdropUrl,
          rp.ReleaseYear,
          rp.Rating,
          rp.ContentType,
          rp.SeasonId,
          rp.SeasonNumber,
          rp.EpisodeId,
          rp.EpisodeTitle,
          rp.EpisodeNumber,
          rp.PositionSec,
          rp.DurationSec,
          rp.UpdatedAt,
          (SELECT STRING_AGG(g.Name, ', ')
             FROM dbo.SeriesGenres sg
             JOIN dbo.Genres g ON g.Id = sg.GenreId
            WHERE sg.SeriesId = rp.SeriesId) AS Genres
        FROM RankedProgress rp
        WHERE rp.rn = 1
          AND (
            rp.DurationSec IS NULL
            OR rp.PositionSec < CASE
              WHEN rp.DurationSec <= 180 THEN
                CASE
                  WHEN CAST(rp.DurationSec * 0.9 AS INT) > 30 THEN CAST(rp.DurationSec * 0.9 AS INT)
                  ELSE 30
                END
              WHEN rp.DurationSec - 60 > CAST(rp.DurationSec * 0.92 AS INT) THEN rp.DurationSec - 60
              ELSE CAST(rp.DurationSec * 0.92 AS INT)
            END
          )
        ORDER BY rp.UpdatedAt DESC;
      `);

    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el progreso de reproducción' });
  }
});

router.put('/:episodeId', async (req, res) => {
  const episodeId = Number(req.params.episodeId);
  const positionSec = Math.max(0, Math.trunc(Number(req.body && req.body.positionSec)));
  const durationFromBody = Math.trunc(Number(req.body && req.body.durationSec));

  if (!Number.isInteger(episodeId)) {
    return res.status(400).json({ error: 'episodeId inválido' });
  }
  if (!Number.isFinite(positionSec)) {
    return res.status(400).json({ error: 'positionSec inválido' });
  }

  try {
    const pool = await getPool();
    const episodeResult = await pool.request()
      .input('episodeId', sql.Int, episodeId)
      .query(`
        SELECT TOP 1 Id, DurationSec
        FROM dbo.Episodes
        WHERE Id = @episodeId
      `);

    const episode = episodeResult.recordset[0];
    if (!episode) {
      return res.status(404).json({ error: 'Episodio no encontrado' });
    }

    const durationSec = Number.isFinite(durationFromBody) && durationFromBody > 0
      ? durationFromBody
      : episode.DurationSec;
    const endThreshold = completionThreshold(durationSec);
    const shouldDelete = positionSec <= 0 || (endThreshold != null && positionSec >= endThreshold);

    if (shouldDelete) {
      await pool.request()
        .input('userId', sql.Int, req.user.id)
        .input('episodeId', sql.Int, episodeId)
        .query(`
          DELETE FROM dbo.WatchProgress
          WHERE UserId = @userId AND EpisodeId = @episodeId
        `);
      return res.json({ ok: true, cleared: true });
    }

    await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('episodeId', sql.Int, episodeId)
      .input('positionSec', sql.Int, positionSec)
      .query(`
        MERGE dbo.WatchProgress AS target
        USING (SELECT @userId AS UserId, @episodeId AS EpisodeId) AS source
        ON target.UserId = source.UserId AND target.EpisodeId = source.EpisodeId
        WHEN MATCHED THEN
          UPDATE SET PositionSec = @positionSec, UpdatedAt = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (UserId, EpisodeId, PositionSec, UpdatedAt)
          VALUES (@userId, @episodeId, @positionSec, SYSUTCDATETIME());
      `);

    res.json({ ok: true, cleared: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al guardar el progreso de reproducción' });
  }
});

module.exports = router;
