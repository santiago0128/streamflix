require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getPool } = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// API
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/series'));
app.use('/api/watchlist', require('./routes/watchlist'));

// Health-check (verifica también la conexión a la base)
app.get('/api/health', async (req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS ok');
    res.json({ status: 'ok', db: 'connected' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'disconnected', error: err.message });
  }
});

// hls.js servido desde node_modules — el frontend no tiene build step, así que
// se monta directo en vez de copiar el bundle al repo.
app.use('/vendor/hls', express.static(path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist')));

// Videos propios: cualquier archivo en ./media queda servido en /media/<archivo>.
// express.static ya responde con 206 a los Range requests, así que el seek del
// reproductor funciona sin configuración extra.
const mediaDir = path.join(__dirname, '..', 'media');
app.use('/media', express.static(mediaDir, { acceptRanges: true }));

// Frontend estático
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎬 StreamFlix corriendo en http://localhost:${PORT}`));
