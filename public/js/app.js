// Lógica principal de la SPA
(() => {
  // ---------- Estado ----------
  const state = {
    view: 'home',        // 'home' | 'mylist'
    search: '',
    genre: '',
    detail: null,        // serie abierta en el modal
    myListIds: new Set(),
  };

  // ---------- Utilidades ----------
  const $ = (id) => document.getElementById(id);
  const toastEl = $('toast');
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
  }
  const poster = (url) => url || 'https://via.placeholder.com/320x460/1c1c26/9a9aa5?text=Sin+imagen';

  // ---------- Auth UI ----------
  function refreshAuthUI() {
    const user = API.getUser();
    const area = $('authArea');
    document.querySelectorAll('[data-auth-only]').forEach((el) => (el.style.display = user ? '' : 'none'));
    if (user) {
      area.innerHTML = `
        <div class="user-menu">
          <div class="user-avatar">${(user.Username || '?')[0].toUpperCase()}</div>
          <span class="user-name">${user.Username}</span>
          <button class="btn btn-ghost" id="logoutBtn">Salir</button>
        </div>`;
      $('logoutBtn').addEventListener('click', () => {
        API.clearSession();
        state.myListIds.clear();
        if (state.view === 'mylist') switchView('home');
        refreshAuthUI();
        toast('Sesión cerrada');
      });
    } else {
      area.innerHTML = `<button class="btn btn-ghost" id="loginBtn">Iniciar sesión</button>`;
      $('loginBtn').addEventListener('click', () => openAuth('login'));
    }
  }

  async function refreshMyListIds() {
    if (!API.getToken()) { state.myListIds.clear(); return; }
    try {
      const list = await API.watchlist();
      state.myListIds = new Set(list.map((s) => s.Id));
    } catch { /* token vencido, etc. */ }
  }

  // ---------- Catálogo ----------
  const grid = $('grid');
  const emptyState = $('emptyState');

  async function loadCatalog() {
    try {
      let list;
      if (state.view === 'mylist') {
        list = await API.watchlist();
        state.myListIds = new Set(list.map((s) => s.Id));
        // filtro/búsqueda en cliente sobre la lista propia
        if (state.genre) list = list.filter((s) => (s.Genres || '').includes(state.genre));
        if (state.search) list = list.filter((s) => s.Title.toLowerCase().includes(state.search.toLowerCase()));
      } else {
        list = await API.series(state.search, state.genre);
      }
      renderCards(list);
      renderHero(state.view === 'home' && !state.search && !state.genre ? list[0] : null);
    } catch (err) {
      toast(err.message);
      renderCards([]);
    }
  }

  function renderCards(list) {
    grid.innerHTML = '';
    emptyState.hidden = list.length > 0;
    list.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        ${s.Rating != null ? `<span class="card-rating">★ ${Number(s.Rating).toFixed(1)}</span>` : ''}
        <img class="card-poster" src="${poster(s.PosterUrl)}" alt="${s.Title}" loading="lazy" />
        <div class="card-body">
          <div class="card-title">${s.Title}</div>
          <div class="card-genres">${s.Genres || ''}</div>
        </div>`;
      card.addEventListener('click', () => openDetail(s.Id));
      grid.appendChild(card);
    });
  }

  // ---------- Hero ----------
  function renderHero(s) {
    const hero = $('hero');
    if (!s) { hero.hidden = true; return; }
    hero.hidden = false;
    $('heroBg').style.backgroundImage = `url('${s.BackdropUrl || s.PosterUrl}')`;
    $('heroTitle').textContent = s.Title;
    $('heroMeta').textContent = [s.ReleaseYear, s.Genres, s.Rating != null ? '★ ' + Number(s.Rating).toFixed(1) : '']
      .filter(Boolean).join('  ·  ');
    $('heroDesc').textContent = s.Description || '';
    $('heroPlay').onclick = () => playSeries(s.Id);
    $('heroInfo').onclick = () => openDetail(s.Id);
  }

  // ---------- Detalle ----------
  const detailModal = $('detailModal');

  async function openDetail(id) {
    try {
      const data = await API.seriesDetail(id);
      state.detail = data;
      $('detailBg').style.backgroundImage = `url('${data.BackdropUrl || data.PosterUrl}')`;
      $('detailTitle').textContent = data.Title;
      $('detailMeta').textContent = [data.ReleaseYear, (data.genres || []).map((g) => g.Name).join(', '),
        data.Rating != null ? '★ ' + Number(data.Rating).toFixed(1) : ''].filter(Boolean).join('  ·  ');
      $('detailDesc').textContent = data.Description || '';

      // Temporadas
      const seasonSelect = $('seasonSelect');
      seasonSelect.innerHTML = '';
      data.seasons.forEach((se, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = se.Title || `Temporada ${se.SeasonNumber}`;
        seasonSelect.appendChild(opt);
      });
      seasonSelect.onchange = () => renderEpisodes(data.seasons[Number(seasonSelect.value)]);
      renderEpisodes(data.seasons[0]);

      // Botón reproducir (primer episodio de la temporada seleccionada)
      $('detailPlay').onclick = () => {
        const se = data.seasons[Number(seasonSelect.value)] || data.seasons[0];
        Player.open(se.episodes, 0, data.Title);
      };

      updateListButton();
      openModal(detailModal);
    } catch (err) {
      toast(err.message);
    }
  }

  function renderEpisodes(season) {
    const listEl = $('episodeList');
    listEl.innerHTML = '';
    if (!season) return;
    season.episodes.forEach((ep, i) => {
      const row = document.createElement('div');
      row.className = 'episode-row';
      const mins = ep.DurationSec ? Math.round(ep.DurationSec / 60) + ' min' : '';
      row.innerHTML = `
        <div class="episode-num">${ep.EpisodeNumber}</div>
        <img class="episode-thumb" src="${ep.ThumbnailUrl || poster(null)}" alt="" loading="lazy" />
        <div class="episode-info">
          <h4>${ep.Title}</h4>
          <p>${ep.Description || ''}</p>
        </div>
        <div class="episode-dur">${mins}</div>
        <div class="episode-play">▶</div>`;
      row.addEventListener('click', () => {
        closeModal(detailModal);
        Player.open(season.episodes, i, state.detail.Title);
      });
      listEl.appendChild(row);
    });
  }

  async function playSeries(id) {
    try {
      const data = await API.seriesDetail(id);
      const se = data.seasons[0];
      if (se && se.episodes.length) Player.open(se.episodes, 0, data.Title);
      else toast('Esta serie aún no tiene episodios');
    } catch (err) { toast(err.message); }
  }

  // ---------- Mi Lista (botón en detalle) ----------
  function updateListButton() {
    const btn = $('detailListBtn');
    if (!state.detail) return;
    if (!API.getToken()) {
      btn.textContent = '+ Mi Lista';
      btn.onclick = () => { closeModal(detailModal); openAuth('login'); toast('Inicia sesión para guardar series'); };
      return;
    }
    const inList = state.myListIds.has(state.detail.Id);
    btn.textContent = inList ? '✓ En Mi Lista' : '+ Mi Lista';
    btn.onclick = async () => {
      try {
        if (state.myListIds.has(state.detail.Id)) {
          await API.removeFromList(state.detail.Id);
          state.myListIds.delete(state.detail.Id);
          toast('Quitada de Mi Lista');
        } else {
          await API.addToList(state.detail.Id);
          state.myListIds.add(state.detail.Id);
          toast('Agregada a Mi Lista');
        }
        updateListButton();
        if (state.view === 'mylist') loadCatalog();
      } catch (err) { toast(err.message); }
    };
  }

  // ---------- Modales ----------
  function openModal(m) { m.hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal(m) { m.hidden = true; document.body.style.overflow = ''; }
  document.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', () => closeModal(el.closest('.modal'))));

  // ---------- Auth modal ----------
  let authMode = 'login';
  function openAuth(mode) {
    authMode = mode;
    const isLogin = mode === 'login';
    $('authTitle').textContent = isLogin ? 'Iniciar sesión' : 'Crear cuenta';
    $('authSubmit').textContent = isLogin ? 'Entrar' : 'Registrarme';
    $('usernameField').hidden = isLogin;
    $('emailField').hidden = isLogin;
    $('identifierLabel').parentElement.hidden = !isLogin; // el campo "identifier" sólo en login
    $('authSwitchText').textContent = isLogin ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?';
    $('authSwitchLink').textContent = isLogin ? 'Regístrate' : 'Inicia sesión';
    $('authError').hidden = true;
    openModal($('authModal'));
  }
  $('authSwitchLink').addEventListener('click', (e) => { e.preventDefault(); openAuth(authMode === 'login' ? 'register' : 'login'); });

  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('authError');
    errEl.hidden = true;
    try {
      let resp;
      if (authMode === 'login') {
        resp = await API.login($('authIdentifier').value.trim(), $('authPassword').value);
      } else {
        resp = await API.register($('authUsername').value.trim(), $('authEmail').value.trim(), $('authPassword').value);
      }
      API.setSession(resp.token, resp.user);
      await refreshMyListIds();
      refreshAuthUI();
      closeModal($('authModal'));
      toast(`¡Hola, ${resp.user.Username}!`);
      $('authForm').reset();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // ---------- Navegación / vistas ----------
  function switchView(view) {
    if (view === 'mylist' && !API.getToken()) { openAuth('login'); return; }
    state.view = view;
    document.querySelectorAll('.nav-links a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    $('sectionTitle').textContent = view === 'mylist' ? 'Mi Lista' : 'Series';
    loadCatalog();
  }
  document.querySelectorAll('[data-view]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); switchView(a.dataset.view); }));

  // ---------- Buscador y filtro ----------
  let searchTimer = null;
  $('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCatalog, 300);
  });
  $('genreFilter').addEventListener('change', (e) => { state.genre = e.target.value; loadCatalog(); });

  async function loadGenres() {
    try {
      const genres = await API.genres();
      const sel = $('genreFilter');
      genres.forEach((g) => {
        const opt = document.createElement('option');
        opt.value = g.Name;
        opt.textContent = g.Name;
        sel.appendChild(opt);
      });
    } catch { /* silencioso */ }
  }

  // ---------- Init ----------
  async function init() {
    refreshAuthUI();
    await Promise.all([loadGenres(), refreshMyListIds()]);
    loadCatalog();
  }
  init();
})();
