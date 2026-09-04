const express = require('express');
const { sql, getPool } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired); // lo que vio cada quien es suyo: todo pide sesión

// Marcar un capítulo como visto deja sin sentido su marca de "seguir viendo":
// si no se borrara, el capítulo tachado en la ficha seguiría ofreciéndose en el
// carrusel de la portada como si estuviera a medias.
const BORRAR_PROGRESO_TEMPORADA = `
  DELETE wp
    FROM dbo.WatchProgress wp
    JOIN dbo.Episodes e ON e.Id = wp.EpisodeId
   WHERE wp.UserId = @userId`;

// GET /api/watched/series/:seriesId  -> capítulos vistos de esa serie
router.get('/series/:seriesId', async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  if (!Number.isInteger(seriesId)) return res.status(400).json({ error: 'seriesId inválido' });

  try {
    const pool = await getPool();
    const result = await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('seriesId', sql.Int, seriesId)
      .query(`
        SELECT we.EpisodeId, e.SeasonId, e.EpisodeNumber, we.WatchedAt
          FROM dbo.WatchedEpisodes we
          JOIN dbo.Episodes e ON e.Id = we.EpisodeId
          JOIN dbo.Seasons se ON se.Id = e.SeasonId
         WHERE we.UserId = @userId AND se.SeriesId = @seriesId
         ORDER BY e.SeasonId, e.EpisodeNumber
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener los capítulos vistos' });
  }
});

// PUT /api/watched/season/:seasonId  { watched, upToEpisodeNumber? }
//
// Se declara antes que PUT /:episodeId por claridad; no chocan, porque aquel
// solo casa con una ruta de un tramo. `upToEpisodeNumber` es lo que resuelve el
// caso real de quien llega a la web con media serie ya vista por fuera: marcar
// hasta el capítulo donde se quedó, sin dar doscientos clics.
router.put('/season/:seasonId', async (req, res) => {
  const seasonId = Number(req.params.seasonId);
  if (!Number.isInteger(seasonId)) return res.status(400).json({ error: 'seasonId inválido' });

  const watched = req.body ? req.body.watched !== false : true;
  const upToRaw = req.body && req.body.upToEpisodeNumber;
  const upTo = upToRaw == null || upToRaw === '' ? null : Math.trunc(Number(upToRaw));
  if (upTo != null && !Number.isInteger(upTo)) {
    return res.status(400).json({ error: 'upToEpisodeNumber inválido' });
  }

  try {
    const pool = await getPool();
    const seasonRes = await pool.request()
      .input('seasonId', sql.Int, seasonId)
      .query('SELECT TOP 1 Id FROM dbo.Seasons WHERE Id = @seasonId');
    if (!seasonRes.recordset[0]) return res.status(404).json({ error: 'Temporada no encontrada' });

    const filtroEpisodios = `
      e.SeasonId = @seasonId
      ${upTo != null ? 'AND e.EpisodeNumber <= @upTo' : ''}`;

    const request = pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('seasonId', sql.Int, seasonId);
    if (upTo != null) request.input('upTo', sql.Int, upTo);

    if (!watched) {
      const result = await request.query(`
        DELETE we
          FROM dbo.WatchedEpisodes we
          JOIN dbo.Episodes e ON e.Id = we.EpisodeId
         WHERE we.UserId = @userId AND ${filtroEpisodios}`);
      return res.json({ ok: true, watched: false, affected: result.rowsAffected[0] || 0 });
    }

    const result = await request.query(`
      INSERT INTO dbo.WatchedEpisodes (UserId, EpisodeId)
      SELECT @userId, e.Id
        FROM dbo.Episodes e
       WHERE ${filtroEpisodios}
         AND NOT EXISTS (
             SELECT 1 FROM dbo.WatchedEpisodes we
              WHERE we.UserId = @userId AND we.EpisodeId = e.Id);

      ${BORRAR_PROGRESO_TEMPORADA} AND ${filtroEpisodios};`);

    res.json({ ok: true, watched: true, affected: result.rowsAffected[0] || 0 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al marcar la temporada' });
  }
});

// PUT /api/watched/:episodeId  -> marcar visto
router.put('/:episodeId', async (req, res) => {
  const episodeId = Number(req.params.episodeId);
  if (!Number.isInteger(episodeId)) return res.status(400).json({ error: 'episodeId inválido' });

  try {
    const pool = await getPool();
    const episodeRes = await pool.request()
      .input('episodeId', sql.Int, episodeId)
      .query('SELECT TOP 1 Id FROM dbo.Episodes WHERE Id = @episodeId');
    if (!episodeRes.recordset[0]) return res.status(404).json({ error: 'Episodio no encontrado' });

    await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('episodeId', sql.Int, episodeId)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM dbo.WatchedEpisodes WHERE UserId = @userId AND EpisodeId = @episodeId)
          INSERT INTO dbo.WatchedEpisodes (UserId, EpisodeId) VALUES (@userId, @episodeId);

        DELETE FROM dbo.WatchProgress WHERE UserId = @userId AND EpisodeId = @episodeId;`);

    res.json({ ok: true, watched: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al marcar el capítulo como visto' });
  }
});

// DELETE /api/watched/:episodeId  -> quitar la marca
router.delete('/:episodeId', async (req, res) => {
  const episodeId = Number(req.params.episodeId);
  if (!Number.isInteger(episodeId)) return res.status(400).json({ error: 'episodeId inválido' });

  try {
    const pool = await getPool();
    await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('episodeId', sql.Int, episodeId)
      .query('DELETE FROM dbo.WatchedEpisodes WHERE UserId = @userId AND EpisodeId = @episodeId');
    res.json({ ok: true, watched: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al quitar la marca del capítulo' });
  }
});

module.exports = router;
