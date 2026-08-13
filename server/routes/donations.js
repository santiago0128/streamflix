const express = require('express');
const https = require('https');

const router = express.Router();

const MP_API = 'https://api.mercadopago.com/checkout/preferences';

/**
 * Dos maneras de recibir donaciones, y el enlace manda.
 *
 * MP_DONATION_LINK es un enlace de pago creado en el panel de Mercado Pago: no
 * necesita credenciales, no puede caducar y sigue funcionando aunque este
 * servidor esté caído. Para una donación es lo que conviene — Checkout Pro solo
 * compensa cuando el pago tiene que atarse a algo de aquí (desbloquear una
 * cuenta, registrar quién pagó), y una donación no ata nada.
 *
 * MP_ACCESS_TOKEN queda para quien quiera lo segundo: importes elegidos dentro
 * de la web y vuelta automática al sitio. Es una credencial que puede cobrar,
 * así que si hay enlace no se usa.
 */
const enlace = () => String(process.env.MP_DONATION_LINK || '').trim();
const modo = () => (enlace() ? 'link' : (process.env.MP_ACCESS_TOKEN ? 'checkout' : null));
const configurado = () => Boolean(modo());

/**
 * Los importes sugeridos y la moneda salen del entorno porque dependen del país
 * de la cuenta: 5000 son unos pocos euros en pesos colombianos y una fortuna en
 * otra moneda. Si no se configuran, la web enseña solo el campo libre en vez de
 * proponer cifras inventadas.
 */
function presets() {
  return String(process.env.MP_DONATION_PRESETS || '')
    .split(',')
    .map((valor) => Number(String(valor).trim()))
    .filter((valor) => Number.isFinite(valor) && valor > 0);
}

const minimo = () => Number(process.env.MP_MIN_AMOUNT) || 1;
const maximo = () => Number(process.env.MP_MAX_AMOUNT) || 1000000;

/**
 * Freno por IP. Crear preferencias no cuesta dinero, pero el endpoint es
 * público y llama a un tercero: sin esto, cualquiera puede usarlo para
 * bombardear la API de Mercado Pago con nuestras credenciales.
 */
const VENTANA_MS = 10 * 60 * 1000;
const MAX_POR_VENTANA = 10;
const visitas = new Map();

function demasiadas(ip) {
  const ahora = Date.now();
  const previas = (visitas.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  previas.push(ahora);
  visitas.set(ip, previas);

  // La tabla se limpia sola: sin esto crece con cada IP que pase por aquí.
  if (visitas.size > 5000) {
    for (const [clave, marcas] of visitas) {
      if (!marcas.some((t) => ahora - t < VENTANA_MS)) visitas.delete(clave);
    }
  }
  return previas.length > MAX_POR_VENTANA;
}

function crearPreferencia(payload) {
  return new Promise((resolve, reject) => {
    const cuerpo = JSON.stringify(payload);
    const req = https.request(
      MP_API,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(cuerpo)
        },
        timeout: 15000
      },
      (res) => {
        let texto = '';
        res.setEncoding('utf8');
        res.on('data', (trozo) => { texto += trozo; });
        res.on('end', () => {
          let datos = {};
          try { datos = JSON.parse(texto); } catch { /* respuesta no-JSON */ }
          if ((res.statusCode || 0) >= 400) {
            const error = new Error(datos.message || `Mercado Pago respondió ${res.statusCode}`);
            error.status = res.statusCode;
            return reject(error);
          }
          resolve(datos);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Mercado Pago tardó demasiado')));
    req.on('error', reject);
    req.end(cuerpo);
  });
}

// GET /api/donations/config -> qué puede enseñar la web
router.get('/config', (req, res) => {
  const actual = modo();
  res.json({
    enabled: Boolean(actual),
    mode: actual,
    // Solo en modo enlace: en Checkout Pro no hay nada público que enseñar.
    link: actual === 'link' ? enlace() : null,
    currency: process.env.MP_CURRENCY || null,
    presets: actual === 'checkout' ? presets() : [],
    min: minimo(),
    max: maximo()
  });
});

// POST /api/donations/preference  { amount }
// Sin sesión a propósito: una donación no debería exigir registrarse.
router.post('/preference', async (req, res) => {
  if (modo() !== 'checkout') {
    // En modo enlace no se crea nada: la web manda directo a Mercado Pago y
    // esta ruta no debería llamarse.
    return res.status(503).json({ error: 'Las donaciones no usan Checkout Pro en este servidor' });
  }
  if (demasiadas(req.ip)) {
    return res.status(429).json({ error: 'Demasiados intentos seguidos. Prueba en un rato.' });
  }

  const amount = Number(req.body && req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Importe inválido' });
  }
  if (amount < minimo() || amount > maximo()) {
    return res.status(400).json({ error: `El importe debe estar entre ${minimo()} y ${maximo()}` });
  }

  // Detrás del proxy inverso, el host que ve Express es el interno; para volver
  // de Mercado Pago hace falta la dirección pública de verdad.
  const base = String(process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

  const preferencia = {
    items: [{
      title: 'Donación a Noxis',
      description: 'Apoyo voluntario al mantenimiento del servidor',
      quantity: 1,
      // Redondeado a dos decimales: Mercado Pago rechaza más precisión.
      unit_price: Math.round(amount * 100) / 100,
      ...(process.env.MP_CURRENCY ? { currency_id: process.env.MP_CURRENCY } : {})
    }],
    back_urls: {
      success: `${base}/?donacion=exito`,
      pending: `${base}/?donacion=pendiente`,
      failure: `${base}/?donacion=fallo`
    },
    statement_descriptor: 'NOXIS'
  };

  // auto_return solo con una dirección pública https: con http o localhost,
  // Mercado Pago rechaza la preferencia entera y no se puede ni donar ni probar.
  if (base.startsWith('https://')) preferencia.auto_return = 'approved';

  try {
    const creada = await crearPreferencia(preferencia);
    const initPoint = creada.init_point || creada.sandbox_init_point;
    if (!initPoint) {
      return res.status(502).json({ error: 'Mercado Pago no devolvió un enlace de pago' });
    }
    res.json({ initPoint, preferenceId: creada.id || null });
  } catch (err) {
    // El token viaja en la cabecera y nunca se registra; el mensaje de Mercado
    // Pago sí, que es lo que explica un rechazo (moneda mal, cuenta sin activar).
    console.error('Mercado Pago:', err.message);
    res.status(502).json({ error: 'No se pudo crear el enlace de pago' });
  }
});

module.exports = router;
