require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { getPool } = require('./db');

const app = express();
// Detrás del proxy inverso (ver deploy/README). Sin esto req.ip es siempre la
// del proxy —y el freno por IP de las donaciones cuenta a todo el mundo junto—
// y req.protocol dice http, que rompe las URLs de vuelta de Mercado Pago.
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// API
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/series'));
app.use('/api/watchlist', require('./routes/watchlist'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/donations', require('./routes/donations'));

// Marca de qué versión está corriendo. Permite confirmar desde fuera que un
// despliegue llegó de verdad, sin tener que entrar al servidor.
const VERSION_DESPLEGADA = require('../package.json').version;
const ARRANCADO_EN = new Date().toISOString();

// Health-check (verifica también la conexión a la base)
app.get('/api/health', async (req, res) => {
  const version = { version: VERSION_DESPLEGADA, startedAt: ARRANCADO_EN };
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS ok');
    res.json({ status: 'ok', db: 'connected', ...version });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'disconnected', error: err.message, ...version });
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
app.listen(PORT, () => console.log(`🎬 Noxis corriendo en http://localhost:${PORT}`));
