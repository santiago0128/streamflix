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

  let playlist = [];   // episodios de la temporada
  let index = 0;       // episodio actual
  let seriesTitle = '';
  let hideTimer = null;
  let hls = null;      // instancia de hls.js cuando el episodio es HLS

  const providerOf = (ep) => String(ep && ep.Provider || 'file').toLowerCase();

  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    const h = Math.floor(m / 60);
    return h > 0
      ? `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
      : `${m}:${String(sec).padStart(2, '0')}`;
  };

  const current = () => playlist[index];

  function open(list, startIndex, sTitle) {
    playlist = list || [];
    index = startIndex || 0;
    seriesTitle = sTitle || '';
    buildEpSelect();
    overlay.hidden = false;
    load();
  }

  function close() {
    teardownSource();
    overlay.hidden = true;
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
    if (on) {
      skipIntroBtn.hidden = true;
      nextEpBtn.hidden = true;
      stage.classList.remove('hide-ui');
      clearTimeout(hideTimer);
    }
  }

  /** HLS: nativo en Safari, hls.js en el resto. */
  function loadHls(url) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      return;
    }
    if (window.Hls && window.Hls.isSupported()) {
      hls = new window.Hls({ enableWorker: true });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        // Los errores fatales de red/media son recuperables una vez.
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else { hls.destroy(); hls = null; }
      });
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
    if (provider === 'hls') loadHls(ep.VideoUrl);
    else video.src = ep.VideoUrl;
    video.play().catch(() => {});
    updateIntroMarker();
  }

  function goTo(i) {
    if (i < 0 || i >= playlist.length) return;
    index = i;
    load();
  }
  const next = () => goTo(index + 1);
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
    const inIntro = ep.IntroEndSec != null && ep.IntroStartSec != null &&
                    ep.IntroEndSec > ep.IntroStartSec &&
                    t >= (ep.IntroStartSec || 0) && t < ep.IntroEndSec;
    skipIntroBtn.hidden = !inIntro;

    // Botón "Siguiente episodio" al llegar a los créditos
    const hasNext = index < playlist.length - 1;
    const inOutro = ep.OutroStartSec != null && t >= ep.OutroStartSec;
    nextEpBtn.hidden = !(hasNext && inOutro);
  });

  video.addEventListener('progress', () => {
    if (video.buffered.length && video.duration) {
      const end = video.buffered.end(video.buffered.length - 1);
      progressBuffer.style.width = (end / video.duration * 100) + '%';
    }
  });

  video.addEventListener('ended', () => { if (index < playlist.length - 1) next(); });
  video.addEventListener('play', () => { btnPlay.textContent = '❚❚'; });
  video.addEventListener('pause', () => { btnPlay.textContent = '▶'; });

  // ---- Controles ----
  const togglePlay = () => (video.paused ? video.play() : video.pause());
  btnPlay.addEventListener('click', togglePlay);
  video.addEventListener('click', togglePlay);
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
