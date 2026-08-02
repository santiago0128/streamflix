// Reproductor personalizado: cambio de capítulos, saltar intro y auto-avance.
const Player = (() => {
  const overlay = document.getElementById('playerOverlay');
  const stage = document.getElementById('playerStage');
  const video = document.getElementById('video');
  const videoEmbed = document.getElementById('videoEmbed');
  const playerControls = document.getElementById('playerControls');
  const titleEl = document.getElementById('playerTitle');

  const skipIntroBtn = document.getElementById('skipIntroBtn');
  const nextEpBtn = document.getElementById('nextEpBtn');

  const progress = document.getElementById('progress');
  const progressPlayed = document.getElementById('progressPlayed');
  const progressBuffer = document.getElementById('progressBuffer');
  const introMarker = document.getElementById('introMarker');

  const btnPlay = document.getElementById('btnPlay');
  const btnPrev = document.getElementById('btnPrev');
  const btnNext = document.getElementById('btnNext');
  const btnMute = document.getElementById('btnMute');
  const btnFs = document.getElementById('btnFs');
  const timeLabel = document.getElementById('timeLabel');
  const volume = document.getElementById('volume');
  const epQuickSelect = document.getElementById('epQuickSelect');
  const playerClose = document.getElementById('playerClose');
  const playerCenter = document.getElementById('playerCenter');
  const playerSpinner = document.getElementById('playerSpinner');
  const btnPlayBig = document.getElementById('btnPlayBig');
  const btnBack10 = document.getElementById('btnBack10');
  const btnFwd10 = document.getElementById('btnFwd10');
  const iconPlay = btnPlayBig.querySelector('.icon-play');
  const iconPause = btnPlayBig.querySelector('.icon-pause');
  const playerError = document.getElementById('playerError');
  const playerErrorTitle = document.getElementById('playerErrorTitle');
  const playerErrorDesc = document.getElementById('playerErrorDesc');
  const playerErrorRetry = document.getElementById('playerErrorRetry');
  const playerErrorNext = document.getElementById('playerErrorNext');
  const btnSettings = document.getElementById('btnSettings');
  const settingsPanel = document.getElementById('settingsPanel');
  const optAutoSkipIntro = document.getElementById('optAutoSkipIntro');
  const optAutoSkipOutro = document.getElementById('optAutoSkipOutro');
  const optAutoNext = document.getElementById('optAutoNext');

  let playlist = [];   // episodios de la temporada
  let index = 0;       // episodio actual
  let seriesTitle = '';
  let hideTimer = null;
  let hls = null;      // instancia de hls.js cuando el episodio es HLS
  let autoSkippedIntro = false;  // para no volver a saltar si el usuario retrocede
  let advancing = false;         // evita encadenar dos cambios de episodio

  // Preferencias de reproducción, recordadas entre sesiones.
  const SETTINGS_KEY = 'streamflix_player_settings';
  const settings = Object.assign(
    { autoSkipIntro: false, autoSkipOutro: false, autoNext: true },
    (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; } })()
  );
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  // Cuando no hay marca de créditos (series y películas no traen), se considera
  // outro el último tramo del episodio, que es cuando tiene sentido ofrecer el
  // siguiente capítulo.
  const OUTRO_FALLBACK_SEC = 40;

  const providerOf = (ep) => String(ep && ep.Provider || 'file').toLowerCase();
  const hasNext = () => index < playlist.length - 1;

  function durationOf(ep) {
    return isFinite(video.duration) && video.duration > 0 ? video.duration : ep.DurationSec || 0;
  }

  function introWindow(ep) {
    if (ep.IntroStartSec == null || ep.IntroEndSec == null) return null;
    if (ep.IntroEndSec <= ep.IntroStartSec) return null;
    return { start: ep.IntroStartSec, end: ep.IntroEndSec };
  }

  function outroStart(ep) {
    if (ep.OutroStartSec != null) return ep.OutroStartSec;
    const dur = durationOf(ep);
    return dur > 120 ? dur - OUTRO_FALLBACK_SEC : null;
  }

  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    const h = Math.floor(m / 60);
    return h > 0
      ? `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  };

  const current = () => playlist[index];

  // Un teléfono se reconoce por el puntero, no por el ancho: un portátil táctil
  // estrecho no debe acabar con la pantalla bloqueada en horizontal.
  const esMovil = () =>
    window.matchMedia('(pointer: coarse)').matches && window.matchMedia('(max-width: 900px)').matches;

  /**
   * En el móvil, ver una serie en vertical es desperdiciar la pantalla. Al abrir
   * se pide pantalla completa y se gira a horizontal.
   * Bloquear la orientación exige estar en pantalla completa, así que van juntas
   * y en ese orden. iOS no implementa ninguna de las dos sobre un div, de modo
   * que allí esto no hace nada y el reproductor se queda como esté: por eso todo
   * va en try/catch y ningún fallo corta la reproducción.
   */
  async function girarPantalla() {
    if (!esMovil()) return;
    try {
      if (!document.fullscreenElement && overlay.requestFullscreen) {
        await overlay.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch { /* el navegador la negó; seguimos igual */ }
    try {
      if (screen.orientation && screen.orientation.lock) {
        await screen.orientation.lock('landscape');
      }
    } catch { /* iOS y escritorio no lo permiten */ }
  }

  function soltarPantalla() {
    try {
      if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
    } catch { /* daba igual */ }
  }

  function open(list, startIndex, sTitle) {
    playlist = list || [];
    index = startIndex || 0;
    seriesTitle = sTitle || '';
    buildEpSelect();
    overlay.hidden = false;
    // Antes de cargar: se llama desde el gesto del usuario, y tanto la pantalla
    // completa como el giro exigen precisamente eso para que el navegador los
    // conceda. Esperar a que el vídeo esté listo llegaría tarde.
    girarPantalla();
    load();
  }

  function close() {
    teardownSource();
    overlay.hidden = true;
    soltarPantalla();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  /** Suelta la fuente actual, sea archivo, HLS o iframe. */
  function teardownSource() {
    if (hls) { hls.destroy(); hls = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
    videoEmbed.hidden = true;
    videoEmbed.removeAttribute('src');
  }

  /**
   * Con un reproductor de terceros no controlamos la reproducción, así que
   * se ocultan los controles propios en vez de dejar botones inertes.
   */
  function setEmbedMode(on) {
    video.hidden = on;
    videoEmbed.hidden = !on;
    playerControls.hidden = on;
    // El mando central y la señal de carga son nuestros: con un reproductor
    // ajeno no controlamos nada, así que estorban.
    playerCenter.hidden = on;
    if (on) {
      skipIntroBtn.hidden = true;
      nextEpBtn.hidden = true;
      playerSpinner.hidden = true;
      stage.classList.remove('hide-ui');
      clearTimeout(hideTimer);
    }
  }

  /**
   * HLS: hls.js primero, nativo sólo como respaldo.
   * El orden importa: Chrome responde "maybe" a canPlayType('…mpegurl') pero no
   * reproduce el playlist, así que preguntarle antes que a hls.js dejaba el
   * video en negro. Nativo queda para donde no hay MSE, como Safari en iOS.
   */
  function loadHls(url, onReady) {
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({
        enableWorker: true,
        // OJO: aquí estuvo `progressive: true`. Sobre el papel encaja (los
        // fragmentos duran 20 s y así se empieza con lo que va llegando), pero
        // en la práctica dejaba el vídeo cargando indefinidamente. Está marcada
        // como experimental en hls.js y no compensa: no volver a activarla sin
        // probar la reproducción de verdad en un navegador.
        //
        // Pide el primer fragmento mientras todavía se está leyendo el manifiesto
        // en vez de esperar a terminarlo.
        startFragPrefetch: true,
        // Con fragmentos tan largos, el buffer por defecto se traduce en pedir de
        // más al arrancar; 30 s es un fragmento y medio, suficiente.
        maxBufferLength: 30,
        // Y no guardar lo ya visto, que en un móvil es memoria tirada.
        backBufferLength: 30,
        // Sin esto se puede elegir una calidad mayor que la propia pantalla.
        capLevelToPlayerSize: true
      });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => { if (onReady) onReady(); });

      // Los reintentos van contados. Antes, un error de red disparaba
      // startLoad() sin límite: con un enlace caducado (el origen responde 403 y
      // el proxy devuelve 502) eso son reintentos infinitos, y desde fuera se ve
      // como un vídeo que "carga" eternamente. Es el fallo más común del
      // catálogo, porque las URLs importadas llevan token y caducan.
      let reintentos = 0;
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;

        const codigo = data.response && data.response.code;
        // Si el manifiesto no carga, `startLoad()` no sirve de nada: esa llamada
        // reanuda la carga de fragmentos, y sin manifiesto no hay fragmentos que
        // reanudar. El resultado era un único error y el vídeo girando para
        // siempre. Un manifiesto se reintenta volviendo a pedir la fuente.
        if (/manifest/i.test(data.details || '')) {
          // Con una respuesta del servidor (502 por enlace caducado, 404...)
          // reintentar es perder el tiempo: da igual cuántas veces se pida.
          if (!codigo && reintentos < 1) {
            reintentos += 1;
            hls.loadSource(url);
            return;
          }
          return fallo(codigo);
        }

        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR && reintentos < 2) {
          reintentos += 1;
          hls.startLoad();
          return;
        }
        if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && reintentos < 2) {
          reintentos += 1;
          hls.recoverMediaError();
          return;
        }
        fallo(codigo);
      });

      // El proxy traduce a 502 el 403 del origen, que es como se manifiesta un
      // enlace caducado: el caso más común con diferencia.
      function fallo(codigo) {
        const caducado = codigo === 502 || codigo === 403;
        mostrarError(
          caducado ? 'El enlace de este capítulo caducó' : 'No se pudo reproducir este capítulo',
          caducado
            ? 'Las URLs importadas llevan un token que expira. Hay que volver a importar el capítulo para refrescarlo.'
            : 'El origen del vídeo no respondió.'
        );
        if (hls) { hls.destroy(); hls = null; }
      }
      return;
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      if (onReady) onReady();
      return;
    }
    console.error('Este navegador no soporta HLS y hls.js no está disponible.');
  }

  function buildEpSelect() {
    epQuickSelect.innerHTML = '';
    playlist.forEach((ep, i) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `E${ep.EpisodeNumber} · ${ep.Title}`;
      epQuickSelect.appendChild(opt);
    });
  }

  function load() {
    const ep = current();
    if (!ep) return;
    teardownSource();

    titleEl.textContent = `${seriesTitle} — E${ep.EpisodeNumber}: ${ep.Title}`;
    epQuickSelect.value = String(index);
    skipIntroBtn.hidden = true;
    nextEpBtn.hidden = true;
    btnPrev.disabled = index === 0;
    btnNext.disabled = index === playlist.length - 1;

    const provider = providerOf(ep);
    if (provider === 'embed') {
      setEmbedMode(true);
      videoEmbed.src = ep.VideoUrl;
      return; // sin control de reproducción: no hay marcadores ni auto-avance
    }

    setEmbedMode(false);
    ocultarError();
    playerSpinner.hidden = false;  // hasta que llegue el primer fotograma
    if (provider === 'hls') {
      // Con HLS hay que esperar: loadSource/attachMedia son asíncronos y un
      // play() inmediato se rechaza sin que se note, dejando el video parado
      // hasta que el usuario lo arranca a mano.
      loadHls(ep.VideoUrl, startPlayback);
    } else {
      video.src = ep.VideoUrl;
      startPlayback();
    }
    updateIntroMarker();
  }

  function startPlayback() {
    video.play().catch((error) => {
      // Si el navegador bloquea el autoplay con sonido, se reintenta en silencio
      // antes de dejar el video parado.
      if (error && error.name === 'NotAllowedError' && !video.muted) {
        video.muted = true;
        btnMute.textContent = '🔇';
        video.play().catch(() => {});
      }
    });
  }

  function goTo(i) {
    if (i < 0 || i >= playlist.length) return;
    index = i;
    autoSkippedIntro = false;
    load();
  }
  // El auto-avance puede dispararse desde 'timeupdate' y desde 'ended' casi a la
  // vez; el cerrojo evita saltarse un episodio por partida doble.
  function next() {
    if (advancing || !hasNext()) return;
    advancing = true;
    goTo(index + 1);
    setTimeout(() => { advancing = false; }, 1000);
  }
  const prev = () => goTo(index - 1);

  function updateIntroMarker() {
    const ep = current();
    const dur = ep.DurationSec || video.duration;
    if (ep.IntroStartSec != null && ep.IntroEndSec != null && dur) {
      introMarker.hidden = false;
      introMarker.style.left = (ep.IntroStartSec / dur * 100) + '%';
      introMarker.style.width = Math.max(0.5, (ep.IntroEndSec - ep.IntroStartSec) / dur * 100) + '%';
    } else {
      introMarker.hidden = true;
    }
  }

  // ---- Ciclo de reproducción ----
  video.addEventListener('loadedmetadata', updateIntroMarker);

  video.addEventListener('timeupdate', () => {
    const ep = current();
    const dur = video.duration || ep.DurationSec || 0;
    const t = video.currentTime;
    progressPlayed.style.width = dur ? (t / dur * 100) + '%' : '0%';
    timeLabel.textContent = `${fmt(t)} / ${fmt(dur)}`;

    // Botón "Saltar intro" dentro de la ventana de la intro
    const intro = introWindow(ep);
    const inIntro = Boolean(intro) && t >= intro.start && t < intro.end;

    if (inIntro && settings.autoSkipIntro && !autoSkippedIntro) {
      autoSkippedIntro = true;
      skipIntroBtn.hidden = true;
      video.currentTime = intro.end;
      return;
    }

    skipIntroBtn.hidden = !inIntro;

    // Botón "Siguiente episodio" al llegar a los créditos
    const outro = outroStart(ep);
    const inOutro = outro != null && t >= outro;
    nextEpBtn.hidden = !(hasNext() && inOutro);

    if (inOutro && settings.autoSkipOutro && hasNext()) {
      next();
    }
  });

  video.addEventListener('progress', () => {
    if (video.buffered.length && video.duration) {
      const end = video.buffered.end(video.buffered.length - 1);
      progressBuffer.style.width = (end / video.duration * 100) + '%';
    }
  });

  video.addEventListener('ended', () => { if (settings.autoNext) next(); });
  video.addEventListener('play', () => { btnPlay.textContent = '❚❚'; syncPlayIcon(true); });
  video.addEventListener('pause', () => { btnPlay.textContent = '▶'; syncPlayIcon(false); });

  // ---- Señal de carga ----
  // Mientras no haya imagen, algo tiene que moverse en pantalla; si no, en el
  // móvil parece que el reproductor se colgó.
  const mostrarCarga = (on) => { playerSpinner.hidden = !on; };
  video.addEventListener('waiting', () => mostrarCarga(true));
  video.addEventListener('stalled', () => mostrarCarga(true));
  video.addEventListener('seeking', () => mostrarCarga(true));
  ['playing', 'canplay', 'seeked', 'error'].forEach((ev) =>
    video.addEventListener(ev, () => mostrarCarga(false)));

  // Los episodios que no son HLS (Provider 'file') no pasan por hls.js, así que
  // su fallo llega por aquí y hay que contarlo igual.
  video.addEventListener('error', () => {
    if (providerOf(current()) === 'hls') return;  // de eso ya se encarga hls.js
    mostrarError('No se pudo reproducir este capítulo',
      'El origen del vídeo no respondió. Si se importó hace tiempo, es probable que el enlace haya caducado.');
  });

  // ---- Aviso de fallo ----
  function mostrarError(titulo, detalle) {
    playerSpinner.hidden = true;
    playerErrorTitle.textContent = titulo;
    playerErrorDesc.textContent = detalle || '';
    playerErrorNext.hidden = !hasNext();
    playerError.hidden = false;
    stage.classList.remove('hide-ui');
    clearTimeout(hideTimer);
  }
  function ocultarError() { playerError.hidden = true; }

  playerErrorRetry.addEventListener('click', () => { ocultarError(); load(); });
  playerErrorNext.addEventListener('click', () => { ocultarError(); next(); });

  function syncPlayIcon(reproduciendo) {
    iconPlay.hidden = reproduciendo;
    iconPause.hidden = !reproduciendo;
  }

  // ---- Mando central (móvil) ----
  const saltar = (segundos) => {
    if (!isFinite(video.duration)) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + segundos), video.duration);
    showUI();
  };
  btnPlayBig.addEventListener('click', () => { togglePlay(); showUI(); });
  btnBack10.addEventListener('click', () => saltar(-10));
  btnFwd10.addEventListener('click', () => saltar(10));

  // ---- Controles ----
  const togglePlay = () => (video.paused ? video.play() : video.pause());
  btnPlay.addEventListener('click', togglePlay);
  // En el móvil el toque sobre el vídeo saca los controles; pausar es lo que
  // hace el botón central. Si además alternara la reproducción, cada intento de
  // ver los controles pararía la película.
  video.addEventListener('click', () => { if (esMovil()) showUI(); else togglePlay(); });
  btnNext.addEventListener('click', next);
  btnPrev.addEventListener('click', prev);
  epQuickSelect.addEventListener('change', (e) => goTo(Number(e.target.value)));

  skipIntroBtn.addEventListener('click', () => {
    video.currentTime = current().IntroEndSec || video.currentTime;
    skipIntroBtn.hidden = true;
  });
  nextEpBtn.addEventListener('click', next);

  progress.addEventListener('click', (e) => {
    const rect = progress.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    if (video.duration) video.currentTime = ratio * video.duration;
  });

  btnMute.addEventListener('click', () => {
    video.muted = !video.muted;
    btnMute.textContent = video.muted ? '🔇' : '🔊';
    volume.value = video.muted ? 0 : video.volume;
  });
  volume.addEventListener('input', (e) => {
    video.volume = Number(e.target.value);
    video.muted = video.volume === 0;
    btnMute.textContent = video.muted ? '🔇' : '🔊';
  });

  btnFs.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else overlay.requestFullscreen().catch(() => {});
  });

  playerClose.addEventListener('click', close);

  // ---- Opciones de reproducción ----
  function syncSettingsUI() {
    optAutoSkipIntro.checked = settings.autoSkipIntro;
    optAutoSkipOutro.checked = settings.autoSkipOutro;
    optAutoNext.checked = settings.autoNext;
  }

  const bindSetting = (input, key) =>
    input.addEventListener('change', () => {
      settings[key] = input.checked;
      saveSettings();
    });

  bindSetting(optAutoSkipIntro, 'autoSkipIntro');
  bindSetting(optAutoSkipOutro, 'autoSkipOutro');
  bindSetting(optAutoNext, 'autoNext');
  syncSettingsUI();

  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.hidden = !settingsPanel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!settingsPanel.hidden && !settingsPanel.contains(e.target) && e.target !== btnSettings) {
      settingsPanel.hidden = true;
    }
  });

  // ---- Auto-ocultar UI ----
  function showUI() {
    stage.classList.remove('hide-ui');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!video.paused) stage.classList.add('hide-ui'); }, 3000);
  }
  stage.addEventListener('mousemove', showUI);
  stage.addEventListener('touchstart', showUI);

  // ---- Atajos de teclado ----
  document.addEventListener('keydown', (e) => {
    if (overlay.hidden) return;
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); togglePlay(); break;
      case 'ArrowRight': video.currentTime += 10; break;
      case 'ArrowLeft': video.currentTime -= 10; break;
      case 'ArrowUp': video.volume = Math.min(1, video.volume + 0.1); volume.value = video.volume; break;
      case 'ArrowDown': video.volume = Math.max(0, video.volume - 0.1); volume.value = video.volume; break;
      case 'f': btnFs.click(); break;
      case 'n': next(); break;
      case 'p': prev(); break;
      case 'Escape': if (!document.fullscreenElement) close(); break;
    }
    showUI();
  });

  return { open, close };
})();
