'use strict';

const express = require('express');
const { getPool } = require('../db');
const { releaseStatusFromTracker } = require('../lib/release-status');

const router = express.Router();

// GET /api/calendar -> próximos capítulos de anime y de series convencionales.
//
// Las series estuvieron fuera un tiempo, y merece la pena recordar por qué: sin
// `TMDB_API_KEY` sus filas se quedaban con `Estado` a NULL, el vigilante nunca
// se enteraba de que la temporada había acabado y esta ruta traducía "la
// seguimos mirando" a "En emisión". Así aparecía Loki —terminada en 2023—
// estrenando capítulo cada semana.
//
// Con la clave puesta, TMDB dice el estado de verdad (Loki: "Ended") y vuelven
// a ser publicables. La condición para enseñarlas no es tener fila, es que la
// fila diga algo: se excluyen las terminadas y las canceladas.
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
        -- AniList da hora exacta de estreno, no sólo el día.
        CAST('datetime' AS NVARCHAR(12)) AS DatePrecision
      FROM dbo.AnimeEmision a
      JOIN dbo.Series s ON s.Id = a.SeriesId
      WHERE a.Activo = 1
        -- Una fila viva pero ya terminada es la que el vigilante todavía no ha
        -- apagado. No es un estreno pendiente y no se anuncia como tal.
        AND UPPER(LTRIM(RTRIM(ISNULL(a.Estado, '')))) NOT IN ('FINISHED', 'CANCELLED', 'CANCELED')

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
        -- TMDB da el día de estreno, no la hora.
        CAST('date' AS NVARCHAR(12)) AS DatePrecision
      FROM dbo.SerieEmision v
      JOIN dbo.Series s ON s.Id = v.SeriesId
      WHERE v.Activo = 1
        AND UPPER(LTRIM(RTRIM(ISNULL(v.Estado, '')))) NOT IN ('ENDED', 'CANCELED', 'CANCELLED')
        -- Sin estado no se publica: es el caso en el que no sabemos nada, y
        -- enseñarla sería volver a afirmar emisión por el mero seguimiento.
        AND NULLIF(LTRIM(RTRIM(ISNULL(v.Estado, ''))), '') IS NOT NULL

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
      releaseStatus: releaseStatusFromTracker(
        row.TrackerStatus, Boolean(row.IsActive), Boolean(row.NextAt)
      ),
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
