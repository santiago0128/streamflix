'use strict';

const express = require('express');
const { getPool } = require('../db');
const { releaseStatusFromTracker } = require('../lib/release-status');

const router = express.Router();

// GET /api/calendar -> próximos capítulos de anime.
//
// Sólo anime, a propósito. Las series convencionales se siguen vigilando en
// dbo.SerieEmision, pero su estado real sale de TMDB y sin `TMDB_API_KEY` esas
// filas se quedan con `Estado` a NULL: el vigilante nunca se entera de que la
// temporada acabó, sondea a ciegas para siempre y la fila no se apaga nunca.
// Publicarlas aquí convertía "la seguimos mirando" en "En emisión", que es como
// Loki —terminada en 2023— aparecía estrenando capítulo. El anime no tiene ese
// problema: AniList no pide clave y da el estado y la fecha del siguiente.
//
// Para devolverlas al calendario hace falta la clave de TMDB en el entorno del
// vigilante; con ella `SerieEmision.Estado` se llena y vuelve a ser publicable.
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
        a.Activo AS IsActive
      FROM dbo.AnimeEmision a
      JOIN dbo.Series s ON s.Id = a.SeriesId
      WHERE a.Activo = 1
        -- Una fila viva pero ya terminada es la que el vigilante todavía no ha
        -- apagado. No es un estreno pendiente y no se anuncia como tal.
        AND UPPER(LTRIM(RTRIM(ISNULL(a.Estado, '')))) NOT IN ('FINISHED', 'CANCELLED', 'CANCELED')
      ORDER BY a.ProximoEnUtc, s.Title;
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
      // AniList da hora exacta de estreno, no sólo el día.
      datePrecision: 'datetime',
      releaseStatus: releaseStatusFromTracker(row.TrackerStatus, Boolean(row.IsActive)),
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
