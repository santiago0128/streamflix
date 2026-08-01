// Lógica principal de la SPA
(() => {
  // ---------- Estado ----------
  const state = {
    view: 'home',        // 'home' | 'mylist'
    search: '',
    genre: '',
    contentType: '',
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
  const contentTypeMeta = {
    anime: { label: 'Anime', section: 'Animes' },
    series: { label: 'Serie', section: 'Series' },
    movie: { label: 'Película', section: 'Películas' },
    default: { label: 'Contenido', section: 'Contenido' }
  };
  function getContentTypeMeta(type) {
    return contentTypeMeta[type] || contentTypeMeta.default;
  }
  function getSectionTitle() {
    return state.view === 'mylist' ? 'Mi Lista' : getContentTypeMeta(state.contentType).section;
  }

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

  const sectionsEl = $('sections');
  // Orden en el que se muestran las secciones del inicio.
  const SECTION_ORDER = ['anime', 'series', 'movie'];

  async function loadCatalog() {
    try {
      let list;
      if (state.view === 'mylist') {
        list = await API.watchlist();
        state.myListIds = new Set(list.map((s) => s.Id));
        // filtro/búsqueda en cliente sobre la lista propia
        if (state.contentType) list = list.filter((s) => s.ContentType === state.contentType);
        if (state.genre) list = list.filter((s) => (s.Genres || '').includes(state.genre));
        if (state.search) list = list.filter((s) => s.Title.toLowerCase().includes(state.search.toLowerCase()));
      } else {
        list = await API.series(state.search, state.genre, state.contentType);
      }

      // Con un filtro puesto ya se está viendo un solo tipo, así que ahí una
      // rejilla sola es más clara que repetir el encabezado de la sección.
      const agrupar = state.view === 'home' && !state.contentType && !state.search;
      if (agrupar) renderSections(list);
      else renderCards(list);

      renderHero(state.view === 'home' && !state.search && !state.genre ? list[0] : null);
    } catch (err) {
      toast(err.message);
      renderCards([]);
    }
  }

  function buildCard(s) {
    const typeMeta = getContentTypeMeta(s.ContentType);
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <span class="card-type">${typeMeta.label}</span>
      ${s.Rating != null ? `<span class="card-rating">★ ${Number(s.Rating).toFixed(1)}</span>` : ''}
      <img class="card-poster" src="${poster(s.PosterUrl)}" alt="${s.Title}" loading="lazy" />
      <div class="card-body">
        <div class="card-title">${s.Title}</div>
        <div class="card-genres">${s.Genres || ''}</div>
      </div>`;
    card.addEventListener('click', () => openDetail(s.Id));
    return card;
  }

  function renderCards(list) {
    sectionsEl.innerHTML = '';
    sectionsEl.hidden = true;
    grid.hidden = false;
    grid.innerHTML = '';
    emptyState.hidden = list.length > 0;
    list.forEach((s) => grid.appendChild(buildCard(s)));
  }

  // Inicio: una sección por tipo, en vez de todo mezclado en la misma rejilla.
  function renderSections(list) {
    grid.innerHTML = '';
    grid.hidden = true;
    sectionsEl.hidden = false;
    sectionsEl.innerHTML = '';
    emptyState.hidden = list.length > 0;

    SECTION_ORDER.forEach((type) => {
      const items = list.filter((s) => s.ContentType === type);
      if (!items.length) return;

      const section = document.createElement('section');
      section.className = 'type-section';
      const head = document.createElement('div');
      head.className = 'type-section-head';
      head.innerHTML = `
        <h3>${getContentTypeMeta(type).section}</h3>
        <span class="type-count">${items.length}</span>
        <button class="btn btn-ghost type-section-all" type="button">Ver todo</button>`;
      head.querySelector('.type-section-all').addEventListener('click', () => applyContentType(type));

      const sectionGrid = document.createElement('div');
      sectionGrid.className = 'grid';
      items.forEach((s) => sectionGrid.appendChild(buildCard(s)));

      section.appendChild(head);
      section.appendChild(sectionGrid);
      sectionsEl.appendChild(section);
    });
  }

  // Punto único para cambiar de tipo: el select y los enlaces del menú
  // tienen que quedar siempre reflejando lo mismo.
  function applyContentType(type) {
    state.contentType = type || '';
    state.view = 'home';
    $('contentTypeFilter').value = state.contentType;
    syncNav();
    $('sectionTitle').textContent = getSectionTitle();
    loadCatalog();
  }

  function syncNav() {
    document.querySelectorAll('.nav-links a').forEach((link) => {
      const isType = link.dataset.type && link.dataset.type === state.contentType;
      const isHome = link.dataset.view === 'home' && state.view === 'home' && !state.contentType;
      const isList = link.dataset.view === 'mylist' && state.view === 'mylist';
      link.classList.toggle('active', Boolean(isType || isHome || isList));
    });
  }

  // ---------- Hero ----------
  function renderHero(s) {
    const hero = $('hero');
    if (!s) { hero.hidden = true; return; }
    hero.hidden = false;
    $('heroBg').style.backgroundImage = `url('${s.BackdropUrl || s.PosterUrl}')`;
    $('heroTitle').textContent = s.Title;
    $('heroMeta').textContent = [getContentTypeMeta(s.ContentType).label, s.ReleaseYear, s.Genres, s.Rating != null ? '★ ' + Number(s.Rating).toFixed(1) : '']
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
      $('detailMeta').textContent = [getContentTypeMeta(data.ContentType).label, data.ReleaseYear, (data.genres || []).map((g) => g.Name).join(', '),
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
      $('seasonSelectGroup').hidden = data.ContentType === 'movie' || data.seasons.length <= 1;
      seasonSelect.onchange = () => renderEpisodes(data.seasons[Number(seasonSelect.value)]);
      renderEpisodes(data.seasons[0]);

      // Botón reproducir (primer episodio de la temporada seleccionada)
      $('detailPlay').onclick = () => {
        const se = data.seasons[Number(seasonSelect.value)] || data.seasons[0];
        Player.open(se.episodes, 0, data.Title);
      };
      $('detailPlay').textContent = data.ContentType === 'movie' ? '▶ Ver película' : '▶ Reproducir';

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
      else toast('Este contenido aún no tiene reproducción disponible');
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
    // "Inicio" vuelve a la vista sin filtrar, que es donde se ve todo separado.
    if (view === 'home') {
      state.contentType = '';
      $('contentTypeFilter').value = '';
    }
    syncNav();
    $('sectionTitle').textContent = getSectionTitle();
    loadCatalog();
  }
  document.querySelectorAll('[data-view]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); switchView(a.dataset.view); }));
  document.querySelectorAll('[data-type]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); applyContentType(a.dataset.type); }));

  // ---------- Buscador y filtro ----------
  let searchTimer = null;
  $('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCatalog, 300);
  });
  $('contentTypeFilter').addEventListener('change', (e) => applyContentType(e.target.value));
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
