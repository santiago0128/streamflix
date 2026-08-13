/**
 * Aviso por Telegram al chat que administra el catálogo.
 *
 * Es siempre accesorio: avisa de algo que ya está guardado en la base. Por eso
 * ninguna de sus rutas lanza — si el bot no está configurado, o Telegram no
 * contesta, la solicitud del usuario ya se guardó y no puede fallar por esto.
 */

const https = require('https');

const configurado = () =>
  Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

/** Escapa lo que entra el usuario: sin esto, un `<` suyo rompe el mensaje entero. */
function escaparHtml(valor) {
  return String(valor == null ? '' : valor)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function enviar(texto) {
  return new Promise((resolve) => {
    if (!configurado()) return resolve({ enviado: false, motivo: 'sin configurar' });

    const cuerpo = JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: texto,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    const req = https.request(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(cuerpo) },
        timeout: 8000
      },
      (res) => {
        res.resume();
        resolve({ enviado: res.statusCode === 200, estado: res.statusCode });
      }
    );

    // El token va en la URL: si esto se registrara tal cual, el secreto acabaría
    // en los logs del servidor.
    req.on('timeout', () => { req.destroy(); resolve({ enviado: false, motivo: 'tiempo agotado' }); });
    req.on('error', (error) => resolve({ enviado: false, motivo: error.code || 'error de red' }));
    req.end(cuerpo);
  });
}

/** Avisa de una solicitud nueva. Devuelve siempre, nunca lanza. */
async function avisarSolicitud({ id, title, contentType, notes, usuario }) {
  const lineas = [
    '🎬 <b>Solicitud nueva</b>',
    `<b>${escaparHtml(title)}</b> · ${escaparHtml(contentType)}`,
    `Pedida por ${escaparHtml(usuario)} · #${id}`
  ];
  if (notes) lineas.push(`\n<i>${escaparHtml(notes)}</i>`);
  return enviar(lineas.join('\n'));
}

module.exports = { avisarSolicitud, configurado, escaparHtml };
