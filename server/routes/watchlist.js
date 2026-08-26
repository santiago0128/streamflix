const express = require('express');
const { sql, getPool } = require('../db');
const { authRequired } = require('../middleware/auth');
const { releaseStatusSql } = require('../lib/release-status');

const router = express.Router();
router.use(authRequired); // todo lo de aquí requiere sesión

// GET /api/watchlist  -> series guardadas por el usuario
router.get('/', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().input('userId', sql.Int, req.user.id)
      .query(`SELECT s.Id, s.Title, s.PosterUrl, s.BackdropUrl, s.ReleaseYear, s.Rating,
                     s.ContentType, ${releaseStatusSql('s')} AS ReleaseStatus,
                     (SELECT STRING_AGG(g.Name, ', ')
                        FROM dbo.SeriesGenres sg JOIN dbo.Genres g ON g.Id = sg.GenreId
                       WHERE sg.SeriesId = s.Id) AS Genres,
                     w.AddedAt
                FROM dbo.Watchlist w
                JOIN dbo.Series s ON s.Id = w.SeriesId
               WHERE w.UserId = @userId
               ORDER BY w.AddedAt DESC`);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener la lista' });
  }
});

// POST /api/watchlist  { seriesId }
router.post('/', async (req, res) => {
  const seriesId = Number(req.body && req.body.seriesId);
  if (!Number.isInteger(seriesId)) return res.status(400).json({ error: 'seriesId inválido' });
  try {
    const pool = await getPool();
    await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('seriesId', sql.Int, seriesId)
      .query(`IF NOT EXISTS (SELECT 1 FROM dbo.Watchlist WHERE UserId=@userId AND SeriesId=@seriesId)
                INSERT INTO dbo.Watchlist (UserId, SeriesId) VALUES (@userId, @seriesId)`);
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al agregar a la lista' });
  }
});

// DELETE /api/watchlist/:seriesId
router.delete('/:seriesId', async (req, res) => {
  const seriesId = Number(req.params.seriesId);
  if (!Number.isInteger(seriesId)) return res.status(400).json({ error: 'seriesId inválido' });
  try {
    const pool = await getPool();
    await pool.request()
      .input('userId', sql.Int, req.user.id)
      .input('seriesId', sql.Int, seriesId)
      .query('DELETE FROM dbo.Watchlist WHERE UserId=@userId AND SeriesId=@seriesId');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al quitar de la lista' });
  }
});

module.exports = router;
