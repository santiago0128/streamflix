// Enviar lo que se está viendo a un televisor.
//
// Dos tecnologías porque no hay una sola que valga en todas partes:
//
//   Google Cast  Chromecast y televisores con Android TV/Google TV. Va en
//                Chrome y derivados, y es el caso mayoritario.
//   AirPlay      Apple TV y televisores compatibles. Sólo en Safari, pero ahí
//                sale gratis: lo implementa el propio <video>.
//
// La diferencia que manda en el diseño: en AirPlay sigue reproduciendo esta
// página y sólo se desvía la salida, mientras que en Cast **es el televisor
// quien descarga el vídeo**. Por eso Cast exige que la URL sea absoluta,
// pública y sin sesión: el Chromecast no comparte cookies con el navegador ni
// puede pedir nada a `localhost`.
//
// Eso ya se cumple: /api/episodes/:id/stream no pide autenticación, responde
// con `Access-Control-Allow-Origin: *` y el proxy sirve el HLS ya reescrito,
// así que el televisor recibe un playlist que sabe leer.

const Casting = (() => {
  const SDK = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js';
  const RECEPTOR_POR_DEFECTO = 'CC1AD845'; // Default Media Receiver de Google

  let boton = null;
  let aviso = null;
  let ganchos = { obtenerMedia: null, alEmpezar: null, alTerminar: null };

  let castListo = false;
  let sdkCargado = false;
  let sesionCast = null;
  let airplayDisponible = false;
  let video = null;
  let avisoTimer = null;

  const hayCast = () => castListo && window.cast?.framework;
  const transmitiendo = () => Boolean(sesionCast) || Boolean(video?.webkitCurrentPlaybackTargetIsWireless);

  // ------------------------------------------------------------- interfaz

  // El boton se muestra siempre que el reproductor este abierto, aunque no haya
  // a donde transmitir. Ocultarlo parecia mas limpio, pero para quien lo mira
  // "no disponible" y "roto" se ven igual: un hueco. Es mejor enseñarlo apagado
  // y explicar el motivo al pulsarlo, que es informacion que solo tenemos aqui.
  function pintarBoton() {
    if (!boton) return;
    boton.hidden = false;
    boton.classList.toggle('is-casting', transmitiendo());
    boton.classList.toggle('is-unavailable', !hayCast() && !airplayDisponible);
    boton.title = transmitiendo()
      ? 'Dejar de transmitir'
      : (hayCast() || airplayDisponible ? 'Transmitir a un televisor' : 'Transmitir (no disponible aquí)');
    boton.setAttribute('aria-label', boton.title);
  }

  /** Por que no se puede transmitir, en una frase que se pueda leer. */
  function motivoNoDisponible() {
    if (!window.chrome || !navigator.userAgent.includes('Chrome')) {
      return 'Transmitir a Chromecast necesita Chrome. En Safari puedes usar AirPlay.';
    }
    if (!sdkCargado) {
      return 'No se pudo cargar el servicio de Google Cast. Puede que lo bloquee una extensión.';
    }
    return 'No encontré ningún televisor. Comprueba que esté encendido y en la misma red.';
  }

  function mostrarAviso(dispositivo) {
    if (!aviso) return;
    // El nombre del aparato importa: en una casa con varias teles, "se está
    // viendo en algún sitio" no sirve de nada.
    aviso.querySelector('.cast-notice-device').textContent = dispositivo || 'el televisor';
    aviso.hidden = false;
  }

  const ocultarAviso = () => { if (aviso) aviso.hidden = true; };

  // ------------------------------------------------------------- Google Cast

  function cargarSdk() {
    // El SDK avisa por este global en cuanto está listo; hay que declararlo
    // antes de pedir el script o el aviso se pierde.
    window.__onGCastApiAvailable = (disponible) => {
      if (!disponible) return;
      const contexto = cast.framework.CastContext.getInstance();
      contexto.setOptions({
        receiverApplicationId: RECEPTOR_POR_DEFECTO,
        // ORIGIN_SCOPED: si esta misma web ya tenía una sesión abierta, se
        // reengancha sola al recargar en vez de pedir el aparato otra vez.
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
      });

      contexto.addEventListener(
        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        (evento) => manejarSesion(evento.sessionState)
      );

      castListo = true;
      pintarBoton();
    };

    const script = document.createElement('script');
    script.src = SDK;
    script.async = true;
    // Si no carga (sin red, o un bloqueador), no pasa nada: queda AirPlay y,
    // si tampoco, el botón sigue oculto. Transmitir es un extra, no un
    // requisito para ver el vídeo.
    script.onload = () => { sdkCargado = true; };
    script.onerror = () => { sdkCargado = false; castListo = false; pintarBoton(); };
    document.head.appendChild(script);
  }

  function manejarSesion(estado) {
    const E = cast.framework.SessionState;
    if (estado === E.SESSION_STARTED || estado === E.SESSION_RESUMED) {
      sesionCast = cast.framework.CastContext.getInstance().getCurrentSession();
      const nombre = sesionCast?.getCastDevice?.()?.friendlyName;
      mostrarAviso(nombre);
      if (ganchos.alEmpezar) ganchos.alEmpezar(nombre);
      if (estado === E.SESSION_STARTED) enviarMedia();
    } else if (estado === E.SESSION_ENDED) {
      // Se devuelve la posición del televisor para seguir aquí justo donde se
      // dejó allí, que es lo que uno espera al cortar la transmisión.
      const posicion = sesionCast?.getMediaSession?.()?.getEstimatedTime?.() || 0;
      sesionCast = null;
      ocultarAviso();
      if (ganchos.alTerminar) ganchos.alTerminar(posicion);
    }
    pintarBoton();
  }

  async function enviarMedia() {
    const media = ganchos.obtenerMedia && ganchos.obtenerMedia();
    if (!media || !media.url || !sesionCast) return;

    const info = new chrome.cast.media.MediaInfo(media.url, media.contentType || 'application/vnd.apple.mpegurl');
    info.streamType = chrome.cast.media.StreamType.BUFFERED;

    const meta = new chrome.cast.media.GenericMediaMetadata();
    meta.title = media.titulo || '';
    meta.subtitle = media.subtitulo || '';
    if (media.poster) meta.images = [new chrome.cast.Image(media.poster)];
    info.metadata = meta;

    const peticion = new chrome.cast.media.LoadRequest(info);
    peticion.currentTime = Math.max(0, Math.floor(media.posicion || 0));
    peticion.autoplay = true;

    try {
      await sesionCast.loadMedia(peticion);
    } catch (error) {
      // Un fallo aquí casi siempre es que el televisor no pudo descargar la
      // URL. Se corta la sesión para no dejar la tele en negro con la web
      // creyendo que está transmitiendo.
      console.error('No se pudo enviar el vídeo al televisor:', error);
      try { sesionCast.endSession(true); } catch { /* ya estaba cerrada */ }
    }
  }

  // ------------------------------------------------------------- AirPlay

  function prepararAirPlay() {
    if (!video || !window.WebKitPlaybackTargetAvailabilityEvent) return;

    video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
      airplayDisponible = e.availability === 'available';
      pintarBoton();
    });

    // Aquí no hay que enviar nada ni recolocar la posición: AirPlay desvía la
    // salida de este mismo <video>, así que sigue sonando por donde iba.
    video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => {
      if (video.webkitCurrentPlaybackTargetIsWireless) {
        mostrarAviso('AirPlay');
        if (ganchos.alEmpezar) ganchos.alEmpezar('AirPlay', { mantenerLocal: true });
      } else {
        ocultarAviso();
        if (ganchos.alTerminar) ganchos.alTerminar(video.currentTime, { mantenerLocal: true });
      }
      pintarBoton();
    });
  }

  // ------------------------------------------------------------- público

  async function alternar() {
    if (transmitiendo()) return detener();

    if (airplayDisponible && video?.webkitShowPlaybackTargetPicker) {
      video.webkitShowPlaybackTargetPicker();
      return;
    }
    if (!hayCast()) {
      const t = document.getElementById('toast');
      if (t) {
        t.textContent = motivoNoDisponible();
        t.hidden = false;
        clearTimeout(avisoTimer);
        avisoTimer = setTimeout(() => { t.hidden = true; }, 5000);
      }
      return;
    }

    try {
      // Abre el selector de aparatos del navegador. Si el usuario lo cierra sin
      // elegir, se resuelve con "cancel" y no hay nada que hacer.
      await cast.framework.CastContext.getInstance().requestSession();
    } catch (error) {
      if (error !== 'cancel') console.error('No se pudo abrir la transmisión:', error);
    }
  }

  function detener() {
    if (sesionCast) {
      try { sesionCast.endSession(true); } catch { /* ya estaba cerrada */ }
      return;
    }
    // En AirPlay se vuelve por el mismo selector: no hay forma de desviar la
    // salida de vuelta mediante código.
    if (video?.webkitShowPlaybackTargetPicker) video.webkitShowPlaybackTargetPicker();
  }

  /** Vuelve a mandar el vídeo al televisor: al cambiar de capítulo. */
  function refrescar() {
    if (sesionCast) enviarMedia();
  }

  function init(opciones = {}) {
    video = opciones.video || document.getElementById('video');
    boton = opciones.boton || document.getElementById('btnCast');
    aviso = opciones.aviso || document.getElementById('castNotice');
    ganchos = {
      obtenerMedia: opciones.obtenerMedia || null,
      alEmpezar: opciones.alEmpezar || null,
      alTerminar: opciones.alTerminar || null
    };

    if (boton) boton.addEventListener('click', alternar);
    prepararAirPlay();
    cargarSdk();
    pintarBoton();
  }

  return { init, alternar, detener, refrescar, transmitiendo };
})();

// Explicito y no por efecto de la declaracion: una `const` de nivel superior
// vive en el ambito lexico global, que NO es `window`. Sin esta linea,
// `typeof Casting` es "object" pero `window.Casting` es undefined, y las
// guardas `if (window.Casting)` de player.js daban siempre falso: el modulo
// se cargaba entero y no se inicializaba nunca, asi que el boton no aparecia.
window.Casting = Casting;
