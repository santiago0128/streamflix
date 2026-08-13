/**
 * Comprobar que una imagen existe de verdad antes de guardarla o de darla por
 * muerta.
 *
 * Con reintentos a propósito. Una pasada de un solo intento sobre el catálogo
 * entero devolvía fallos de conexión en imágenes que, pedidas de una en una,
 * respondían 200 las tres veces: el CDN corta cuando se le piden decenas de
 * URLs seguidas. Sin reintentar, esos falsos positivos se convierten en
 * portadas buenas reemplazadas por otras, que es peor que el problema.
 */

const http = require('http');
const https = require('https');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pedir(url, metodo) {
  return new Promise((resolve) => {
    let cliente;
    try {
      cliente = String(url).startsWith('http:') ? http : https;
      new URL(url);
    } catch {
      return resolve({ ok: false, status: 0, bytes: 0, motivo: 'URL inválida' });
    }

    const req = cliente.request(url, { method: metodo, timeout: 15000 }, (res) => {
      const status = res.statusCode || 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        try {
          return resolve(pedir(new URL(location, url).toString(), metodo));
        } catch {
          return resolve({ ok: false, status, bytes: 0, motivo: 'redirección inválida' });
        }
      }
      const tipo = String(res.headers['content-type'] || '');
      const bytes = Number(res.headers['content-length']) || 0;
      res.resume();
      resolve({
        ok: status === 200 && tipo.startsWith('image/'),
        status,
        bytes,
        tipo
      });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, bytes: 0, motivo: 'tiempo agotado' }); });
    req.on('error', (error) => resolve({ ok: false, status: 0, bytes: 0, motivo: error.code || 'error de red' }));
    req.end();
  });
}

/**
 * ¿Responde esta imagen?
 *
 * Solo se da por muerta si falla todos los intentos. Un 404 o un 410 no se
 * reintentan: eso es una respuesta clara del servidor y repetirla no la cambia.
 */
async function imagenViva(url, { intentos = 3, esperaMs = 600 } = {}) {
  if (!url) return { ok: false, status: 0, bytes: 0, motivo: 'sin URL' };

  let ultimo = { ok: false, status: 0, bytes: 0 };
  for (let intento = 0; intento < intentos; intento += 1) {
    ultimo = await pedir(url, 'HEAD');

    // Algunos CDN no implementan HEAD y contestan 405 o 403 a secas; con GET
    // sí responden. Sin esto, esas imágenes se darían por muertas estando bien.
    if (!ultimo.ok && (ultimo.status === 405 || ultimo.status === 403)) {
      ultimo = await pedir(url, 'GET');
    }

    if (ultimo.ok) return ultimo;
    if (ultimo.status === 404 || ultimo.status === 410) return ultimo;
    if (intento < intentos - 1) await sleep(esperaMs * (intento + 1));
  }
  return ultimo;
}

module.exports = { imagenViva };
