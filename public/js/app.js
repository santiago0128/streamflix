// Lógica principal de la SPA
(() => {
  // ---------- Estado ----------
  const state = {
    view: 'home',        // 'home' | 'browse' | 'mylist'
    search: '',
    genre: '',
    contentType: '',
    page: 1,             // sólo aplica al listado ('browse' y 'mylist')
    detail: null,        // serie abierta en el modal
    myListIds: new Set(),
  };

  // Cuántas fichas trae cada carrusel del inicio y cada página del listado.
  const CAROUSEL_SIZE = 10;
  const PAGE_SIZE = 24;

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
    default: { label: 'Contenido', section: 'Todo el catálogo' }
  };
  function getContentTypeMeta(type) {
    return contentTypeMeta[type] || contentTypeMeta.default;
  }
  function getSectionTitle() {
    if (state.view === 'mylist') return 'Mi Lista';
    if (state.search) return `Resultados para "${state.search}"`;
    return getContentTypeMeta(state.contentType).section;
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
  const browseEl = $('browse');
  const paginationEl = $('pagination');

  // Orden en el que se muestran las secciones del inicio.
  const SECTION_ORDER = ['anime', 'series', 'movie'];

  function loadCatalog() {
    return state.view === 'home' ? loadHome() : loadListing();
  }

  // ---------- Inicio: un carrusel por tipo ----------
  async function loadHome() {
    sectionsEl.hidden = false;
    browseEl.hidden = true;
    paginationEl.hidden = true;
    try {
      const respuestas = await Promise.all(SECTION_ORDER.map((type) =>
        API.series({ type, page: 1, pageSize: CAROUSEL_SIZE })));

      const secciones = SECTION_ORDER
        .map((type, i) => ({ type, items: respuestas[i].items, total: respuestas[i].total }))
        .filter((s) => s.items.length);

      renderSections(secciones);
      emptyState.hidden = secciones.length > 0;
      // El destacado sale del primer carrusel con contenido.
      renderHero(secciones.length ? secciones[0].items[0] : null);
    } catch (err) {
      toast(err.message);
      renderSections([]);
      renderHero(null);
    }
  }

  // ---------- Listado completo, paginado y con filtros ----------
  async function loadListing() {
    sectionsEl.hidden = true;
    browseEl.hidden = false;
    clearCarousels();
    renderHero(null);
    try {
      const { items, total } = state.view === 'mylist' ? await fetchMyListPage() : await fetchSeriesPage();

      // Al estrechar el resultado (otro filtro, otra búsqueda) la página actual
      // puede quedar más allá del final: se vuelve a la última que sí existe.
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (state.page > totalPages) { state.page = totalPages; return loadListing(); }

      renderCards(items);
      renderPagination(total, totalPages);
      renderBrowseHead(total);
    } catch (err) {
      toast(err.message);
      renderCards([]);
      renderPagination(0, 1);
      renderBrowseHead(0);
    }
  }

  async function fetchSeriesPage() {
    const data = await API.series({
      search: state.search, genre: state.genre, type: state.contentType,
      page: state.page, pageSize: PAGE_SIZE,
    });
    return { items: data.items, total: data.total };
  }

  // Mi Lista es corta y ya viene entera en una llamada, así que el filtrado y el
  // troceado se hacen aquí en vez de pedirle páginas al servidor.
  async function fetchMyListPage() {
    let list = await API.watchlist();
    state.myListIds = new Set(list.map((s) => s.Id));
    if (state.contentType) list = list.filter((s) => s.ContentType === state.contentType);
    if (state.genre) list = list.filter((s) => (s.Genres || '').includes(state.genre));
    if (state.search) list = list.filter((s) => s.Title.toLowerCase().includes(state.search.toLowerCase()));
    const desde = (state.page - 1) * PAGE_SIZE;
    return { items: list.slice(desde, desde + PAGE_SIZE), total: list.length };
  }

  function renderBrowseHead(total) {
    $('sectionTitle').textContent = getSectionTitle();
    $('browseCount').textContent = total === 1 ? '1 título' : `${total} títulos`;
    $('clearFilters').hidden = !(state.search || state.genre || state.contentType);
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
    grid.innerHTML = '';
    emptyState.hidden = list.length > 0;
    list.forEach((s) => grid.appendChild(buildCard(s)));
  }

  // ---------- Carruseles del inicio ----------
  // Cada carrusel observa su propio ancho para saber si las flechas hacen falta;
  // al re-dibujar el inicio hay que soltar los observadores anteriores.
  let carouselObservers = [];
  function clearCarousels() {
    carouselObservers.forEach((o) => o.disconnect());
    carouselObservers = [];
  }

  function buildCarousel(items) {
    const carousel = document.createElement('div');
    carousel.className = 'carousel';

    const track = document.createElement('div');
    track.className = 'carousel-track';
    items.forEach((s) => track.appendChild(buildCard(s)));

    const prev = buildCarouselArrow('prev', '‹', 'Anterior');
    const next = buildCarouselArrow('next', '›', 'Siguiente');
    carousel.append(prev, track, next);

    // Las flechas se apagan en los extremos, y el carrusel entero las esconde
    // cuando no hay nada que desplazar.
    function sync() {
      const max = track.scrollWidth - track.clientWidth;
      carousel.classList.toggle('no-scroll', max <= 1);
      prev.disabled = track.scrollLeft <= 1;
      next.disabled = track.scrollLeft >= max - 1;
    }
    const salto = () => Math.max(track.clientWidth * 0.85, 160);
    prev.addEventListener('click', () => track.scrollBy({ left: -salto(), behavior: 'smooth' }));
    next.addEventListener('click', () => track.scrollBy({ left: salto(), behavior: 'smooth' }));
    track.addEventListener('scroll', sync, { passive: true });

    // El ancho real no se conoce hasta que el carrusel está en el documento.
    const observer = new ResizeObserver(sync);
    observer.observe(track);
    carouselObservers.push(observer);
    sync();

    return carousel;
  }

  function buildCarouselArrow(dir, glifo, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'carousel-nav ' + dir;
    btn.setAttribute('aria-label', label);
    btn.textContent = glifo;
    return btn;
  }

  // Inicio: una sección por tipo, cada una con su carrusel y su "Ver más".
  function renderSections(secciones) {
    clearCarousels();
    sectionsEl.innerHTML = '';

    secciones.forEach(({ type, items, total }) => {
      const section = document.createElement('section');
      section.className = 'type-section';

      const head = document.createElement('div');
      head.className = 'type-section-head';
      head.innerHTML = `
        <h3>${getContentTypeMeta(type).section}</h3>
        <span class="type-count">${total}</span>
        <button class="btn btn-ghost type-section-all" type="button">Ver más</button>`;
      head.querySelector('.type-section-all').addEventListener('click', () => openBrowse(type));

      section.appendChild(head);
      section.appendChild(buildCarousel(items));
      sectionsEl.appendChild(section);
    });
  }

  // ---------- Paginación ----------
  // Ventana de páginas alrededor de la actual, siempre con la primera y la
  // última, para que la barra no crezca con el catálogo.
  function pageWindow(current, totalPages) {
    const paginas = new Set([1, totalPages]);
    for (let p = current - 1; p <= current + 1; p += 1) {
      if (p >= 1 && p <= totalPages) paginas.add(p);
    }
    const orden = [...paginas].sort((a, b) => a - b);
    return orden.flatMap((p, i) => (i && p - orden[i - 1] > 1 ? ['…', p] : [p]));
  }

  function renderPagination(total, totalPages) {
    paginationEl.innerHTML = '';
    paginationEl.hidden = totalPages <= 1;
    if (totalPages <= 1) return;

    const irA = (p) => {
      state.page = p;
      loadCatalog();
      browseEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const flecha = (label, destino, activa) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'page-btn page-step';
      btn.textContent = label;
      btn.disabled = !activa;
      if (activa) btn.addEventListener('click', () => irA(destino));
      return btn;
    };

    paginationEl.appendChild(flecha('‹ Anterior', state.page - 1, state.page > 1));

    const numeros = document.createElement('div');
    numeros.className = 'page-numbers';
    pageWindow(state.page, totalPages).forEach((p) => {
      if (p === '…') {
        const hueco = document.createElement('span');
        hueco.className = 'page-gap';
        hueco.textContent = '…';
        numeros.appendChild(hueco);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'page-btn' + (p === state.page ? ' active' : '');
      btn.textContent = p;
      if (p === state.page) btn.setAttribute('aria-current', 'page');
      else btn.addEventListener('click', () => irA(p));
      numeros.appendChild(btn);
    });
    paginationEl.appendChild(numeros);

    // En pantalla estrecha los números se ocultan y queda este contador.
    const resumen = document.createElement('span');
    resumen.className = 'page-summary';
    resumen.textContent = `${state.page} / ${totalPages}`;
    paginationEl.appendChild(resumen);

    paginationEl.appendChild(flecha('Siguiente ›', state.page + 1, state.page < totalPages));
  }

  // ---------- Cambios de filtro / vista ----------
  // Los selectores viven en dos sitios (barra superior y listado): el estado es
  // el único origen de verdad y de aquí salen los dos.
  function syncFilterInputs() {
    $('contentTypeFilter').value = state.contentType;
    $('browseType').value = state.contentType;
    $('genreFilter').value = state.genre;
    $('browseGenre').value = state.genre;
    // Sólo se toca el buscador si de verdad quedó desfasado: reescribirlo
    // mientras se teclea mueve el cursor al final.
    if ($('searchInput').value.trim() !== state.search) $('searchInput').value = state.search;
  }

  function render() {
    syncFilterInputs();
    syncNav();
    loadCatalog();
  }

  // "Ver más" y los enlaces de tipo del menú: abren el listado completo.
  function openBrowse(type) {
    state.view = 'browse';
    state.contentType = type || '';
    state.page = 1;
    render();
  }

  // Un filtro desde el inicio manda al listado; dentro de Mi Lista se queda ahí.
  function applyFilter(campo, valor) {
    state[campo] = valor || '';
    state.page = 1;
    if (state.view === 'home') state.view = 'browse';
    else if (state.view === 'browse' && !state.search && !state.genre && !state.contentType) state.view = 'home';
    render();
  }

  function syncNav() {
    document.querySelectorAll('.nav-links a').forEach((link) => {
      const isType = link.dataset.type && state.view === 'browse' && link.dataset.type === state.contentType;
      const isHome = link.dataset.view === 'home' && state.view === 'home';
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
    state.page = 1;
    // "Inicio" vuelve a la portada limpia, que es donde están los carruseles.
    if (view === 'home') {
      state.contentType = '';
      state.genre = '';
      state.search = '';
    }
    render();
  }
  document.querySelectorAll('[data-view]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); switchView(a.dataset.view); }));
  document.querySelectorAll('[data-type]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); openBrowse(a.dataset.type); }));

  // ---------- Buscador y filtros ----------
  let searchTimer = null;
  $('searchInput').addEventListener('input', (e) => {
    const texto = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applyFilter('search', texto), 300);
  });
  $('contentTypeFilter').addEventListener('change', (e) => applyFilter('contentType', e.target.value));
  $('browseType').addEventListener('change', (e) => applyFilter('contentType', e.target.value));
  $('genreFilter').addEventListener('change', (e) => applyFilter('genre', e.target.value));
  $('browseGenre').addEventListener('change', (e) => applyFilter('genre', e.target.value));
  $('clearFilters').addEventListener('click', () => {
    state.search = '';
    state.genre = '';
    state.contentType = '';
    state.page = 1;
    if (state.view === 'browse') state.view = 'home';
    render();
  });

  async function loadGenres() {
    try {
      const genres = await API.genres();
      const selects = [$('genreFilter'), $('browseGenre')];
      genres.forEach((g) => {
        selects.forEach((sel) => {
          const opt = document.createElement('option');
          opt.value = g.Name;
          opt.textContent = g.Name;
          sel.appendChild(opt);
        });
      });
    } catch { /* silencioso */ }
  }

  // ---------- Init ----------
  async function init() {
    refreshAuthUI();
    await Promise.all([loadGenres(), refreshMyListIds()]);
    render();
  }
  init();
})();
