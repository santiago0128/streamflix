'use strict';

const express = require('express');
const { getPool } = require('../db');

const router = express.Router();

function normalizeReleaseStatus(contentType, trackerStatus, active) {
  const status = String(trackerStatus || '').toUpperCase();

  if (!active || status === 'FINISHED' || status === 'ENDED' || status === 'CANCELED') {
    return 'finished';
  }
  if (status === 'NOT_YET_RELEASED' || status === 'IN PRODUCTION' || status === 'PLANNED') {
    return 'upcoming';
  }
  if (contentType === 'anime' && (status === 'RELEASING' || status === 'JK_ONLY')) {
    return 'airing';
  }

  // Una fila activa existe precisamente porque el vigilante está esperando el
  // siguiente capítulo. Para series sin TMDB el estado textual viene vacío,
  // pero sigue siendo correcto enseñarlas como contenido en seguimiento.
  return active ? 'airing' : 'unknown';
}

// GET /api/calendar -> próximos capítulos de anime y series convencionales.
router.get('/', async (_req, res) => {
  res.setHeader('cache-control', 'no-store');

  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        a.SeriesId, s.Title, s.ContentType, s.PosterUrl, s.BackdropUrl,
        a.SeasonNumber,
        COALESCE(a.ProximoEpisodio, a.UltimoImportado + 1) AS NextEpisode,
        a.ProximoEnUtc AS NextAt,
        a.DiaSemana AS Weekday,
        a.HoraUtc AS TimeUtc,
        a.Estado AS TrackerStatus,
        a.UltimoImportado AS LastImported,
        a.UltimaRevision AS LastCheckedAt,
        a.Activo AS IsActive,
        CAST('datetime' AS NVARCHAR(12)) AS DatePrecision
      FROM dbo.AnimeEmision a
      JOIN dbo.Series s ON s.Id = a.SeriesId
      WHERE a.Activo = 1

      UNION ALL

      SELECT
        v.SeriesId, s.Title, s.ContentType, s.PosterUrl, s.BackdropUrl,
        v.Temporada AS SeasonNumber,
        COALESCE(v.ProximoEpisodio, v.UltimoImportado + 1) AS NextEpisode,
        v.ProximoEnUtc AS NextAt,
        CAST(NULL AS TINYINT) AS Weekday,
        CAST(NULL AS NVARCHAR(5)) AS TimeUtc,
        v.Estado AS TrackerStatus,
        v.UltimoImportado AS LastImported,
        v.UltimaRevision AS LastCheckedAt,
        v.Activo AS IsActive,
        CAST('date' AS NVARCHAR(12)) AS DatePrecision
      FROM dbo.SerieEmision v
      JOIN dbo.Series s ON s.Id = v.SeriesId
      WHERE v.Activo = 1

      ORDER BY NextAt, Title;
    `);

    const items = result.recordset.map((row) => ({
      seriesId: row.SeriesId,
      title: row.Title,
      contentType: row.ContentType,
      posterUrl: row.PosterUrl,
      backdropUrl: row.BackdropUrl,
      seasonNumber: row.SeasonNumber,
      nextEpisode: row.NextEpisode,
      nextAt: row.NextAt,
      weekday: row.Weekday,
      timeUtc: row.TimeUtc,
      lastImported: row.LastImported,
      lastCheckedAt: row.LastCheckedAt,
      datePrecision: row.DatePrecision,
      releaseStatus: normalizeReleaseStatus(row.ContentType, row.TrackerStatus, Boolean(row.IsActive)),
      scheduleStatus: row.NextAt ? 'confirmed' : (row.Weekday != null && row.TimeUtc ? 'recurring' : 'pending')
    }));

    res.json({
      generatedAt: new Date().toISOString(),
      timeZone: 'America/Bogota',
      items
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener el calendario de episodios' });
  }
});

module.exports = router;
