// Lógica principal de la SPA
(() => {
  const state = {
    view: 'home',
    search: '',
    genre: '',
    contentType: '',
    page: 1,
    detail: null,
    myListIds: new Set(),
    continueWatching: [],
    heroSlides: [],
    heroIndex: 0,
  };

  const CAROUSEL_SIZE = 10;
  const CONTINUE_LIMIT = 12;
  const PAGE_SIZE = 24;
  const HERO_ROTATE_MS = 4000;
  const CAROUSEL_AUTOPLAY_MS = 4000;
  const AUDIO_PREF_KEY = 'streamflix_player_audio_preference';

  const $ = (id) => document.getElementById(id);
  const toastEl = $('toast');
  let toastTimer = null;
  let heroTimer = null;
  let lastProgressRefreshAt = 0;
  let carouselAutoplayStops = [];

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
  }

  const poster = (url) => url || 'https://via.placeholder.com/320x460/26163d/c1acef?text=Noxis';
  const contentTypeMeta = {
    anime: { label: 'Anime', section: 'Animes', badge: 'Mundo anime' },
    series: { label: 'Serie', section: 'Series', badge: 'Maratón' },
    movie: { label: 'Película', section: 'Películas', badge: 'Película destacada' },
    default: { label: 'Contenido', section: 'Todo el catálogo', badge: 'Destacado' }
  };

  function getContentTypeMeta(type) {
    return contentTypeMeta[type] || contentTypeMeta.default;
  }

  function getSectionTitle() {
    if (state.view === 'mylist') return 'Mi Lista';
    if (state.search) return `Resultados para "${state.search}"`;
    return getContentTypeMeta(state.contentType).section;
  }

  function createPlayerHooks() {
    return {
      onProgress: async ({ episodeId, positionSec, durationSec }) => {
        if (!API.getToken()) return;
        try {
          await API.saveProgress(episodeId, positionSec, durationSec);
        } catch {
          /* silencioso */
        }
      },
      onClose: () => {
        if (!API.getToken()) return;
        refreshContinueWatching(true).catch(() => {});
      }
    };
  }

  const audioPrefKey = (seriesId) => seriesId ? `${AUDIO_PREF_KEY}:${seriesId}` : AUDIO_PREF_KEY;
  const getSeriesAudioPref = (seriesId) => localStorage.getItem(audioPrefKey(seriesId)) || '';
  const setSeriesAudioPref = (seriesId, audio) => {
    if (!seriesId) return;
    if (audio) localStorage.setItem(audioPrefKey(seriesId), audio);
    else localStorage.removeItem(audioPrefKey(seriesId));
  };

  function firstEpisodeOf(detail, seasonIndex = 0) {
    const season = detail?.seasons?.[seasonIndex];
    return season?.episodes?.[0] || null;
  }

  async function renderDetailAudioOptions(detail, seasonIndex = 0) {
    const group = $('detailAudioGroup');
    const select = $('detailAudioSelect');
    const firstEpisode = firstEpisodeOf(detail, seasonIndex);
    select.innerHTML = '';

    if (!detail || detail.ContentType !== 'anime' || !firstEpisode) {
      group.hidden = true;
      return;
    }

    try {
      const playback = await API.episodePlayback(firstEpisode.Id, {
        audio: getSeriesAudioPref(detail.Id) || undefined
      });
      if (state.detail?.Id !== detail.Id) return;

      const options = Array.isArray(playback?.audioOptions) ? playback.audioOptions : [];
      if (options.length < 2) {
        group.hidden = true;
        return;
      }

      const selected =
        options.find((option) => option.code === getSeriesAudioPref(detail.Id))?.code ||
        playback?.audio ||
        options[0]?.code ||
        '';

      options.forEach((option) => {
        const el = document.createElement('option');
        el.value = option.code;
        el.textContent = option.label;
        el.selected = option.code === selected;
        select.appendChild(el);
      });

      setSeriesAudioPref(detail.Id, selected);
      group.hidden = false;
    } catch {
      if (state.detail?.Id === detail.Id) {
        group.hidden = true;
      }
    }
  }

  async function openPlaybackFromDetail(detail, episodeId = null, startTimeSec = 0) {
    if (!detail || !detail.seasons || !detail.seasons.length) {
      toast('Este contenido aún no tiene reproducción disponible');
      return;
    }

    let selectedSeason = detail.seasons[0];
    let selectedIndex = 0;

    if (episodeId != null) {
      for (const season of detail.seasons) {
        const foundIndex = season.episodes.findIndex((ep) => ep.Id === episodeId);
        if (foundIndex >= 0) {
          selectedSeason = season;
          selectedIndex = foundIndex;
          break;
        }
      }
    }

    if (!selectedSeason.episodes.length) {
      toast('Este contenido aún no tiene reproducción disponible');
      return;
    }

    Player.open(selectedSeason.episodes, selectedIndex, detail.Title, {
      seriesId: detail.Id,
      startTimeSec,
      hooks: createPlayerHooks(),
    });
  }

  async function resumeProgress(item) {
    try {
      const detail = await API.seriesDetail(item.SeriesId);
      await openPlaybackFromDetail(detail, item.EpisodeId, item.PositionSec || 0);
    } catch (err) {
      toast(err.message);
    }
  }

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
        state.continueWatching = [];
        if (state.view === 'mylist') switchView('home');
        refreshAuthUI();
        render();
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
    } catch {
      state.myListIds.clear();
    }
  }

  async function refreshContinueWatching(force = false) {
    if (!API.getToken()) {
      state.continueWatching = [];
      return [];
    }
    if (!force && Date.now() - lastProgressRefreshAt < 4000) {
      return state.continueWatching;
    }
    try {
      const list = await API.continueWatching(CONTINUE_LIMIT);
      state.continueWatching = list;
      lastProgressRefreshAt = Date.now();
      return list;
    } catch {
      state.continueWatching = [];
      return [];
    }
  }

  const grid = $('grid');
  const emptyState = $('emptyState');
  const sectionsEl = $('sections');
  const browseEl = $('browse');
  const paginationEl = $('pagination');
  const heroEl = $('hero');
  const heroBgEl = $('heroBg');
  const heroBadgeEl = $('heroBadge');
  const heroTitleEl = $('heroTitle');
  const heroMetaEl = $('heroMeta');
  const heroDescEl = $('heroDesc');
  const heroDotsEl = $('heroDots');

  const SECTION_ORDER = ['anime', 'series', 'movie'];

  function loadCatalog() {
    return state.view === 'home' ? loadHome() : loadListing();
  }

  async function loadHome() {
    sectionsEl.hidden = false;
    browseEl.hidden = true;
    paginationEl.hidden = true;

    try {
      const [continueWatching, ...responses] = await Promise.all([
        refreshContinueWatching(),
        ...SECTION_ORDER.map((type) => API.series({ type, page: 1, pageSize: CAROUSEL_SIZE }))
      ]);

      const sections = SECTION_ORDER
        .map((type, i) => ({ type, items: responses[i].items, total: responses[i].total }))
        .filter((section) => section.items.length);

      renderSections(sections, continueWatching);
      renderHero(buildHeroSlides(sections));
      emptyState.hidden = sections.length > 0 || continueWatching.length > 0;
    } catch (err) {
      toast(err.message);
      renderSections([], []);
      renderHero([]);
    }
  }

  async function loadListing() {
    sectionsEl.hidden = true;
    browseEl.hidden = false;
    clearCarousels();
    stopHeroRotation();
    heroEl.hidden = true;

    try {
      const { items, total } = state.view === 'mylist' ? await fetchMyListPage() : await fetchSeriesPage();
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
      search: state.search,
      genre: state.genre,
      type: state.contentType,
      page: state.page,
      pageSize: PAGE_SIZE,
    });
    return { items: data.items, total: data.total };
  }

  async function fetchMyListPage() {
    let list = await API.watchlist();
    state.myListIds = new Set(list.map((s) => s.Id));
    if (state.contentType) list = list.filter((s) => s.ContentType === state.contentType);
    if (state.genre) list = list.filter((s) => (s.Genres || '').includes(state.genre));
    if (state.search) list = list.filter((s) => s.Title.toLowerCase().includes(state.search.toLowerCase()));
    const from = (state.page - 1) * PAGE_SIZE;
    return { items: list.slice(from, from + PAGE_SIZE), total: list.length };
  }

  function renderBrowseHead(total) {
    $('sectionTitle').textContent = getSectionTitle();
    $('browseCount').textContent = total === 1 ? '1 título' : `${total} títulos`;
    $('clearFilters').hidden = !(state.search || state.genre || state.contentType);
  }

  function buildCard(series) {
    const typeMeta = getContentTypeMeta(series.ContentType);
    const card = document.createElement('div');
    card.className = 'card reveal-up';
    card.innerHTML = `
      <span class="card-type">${typeMeta.label}</span>
      ${series.Rating != null ? `<span class="card-rating">★ ${Number(series.Rating).toFixed(1)}</span>` : ''}
      <img class="card-poster" src="${poster(series.PosterUrl)}" alt="${series.Title}" loading="lazy" />
      <div class="card-body">
        <div class="card-title">${series.Title}</div>
        <div class="card-genres">${series.Genres || ''}</div>
      </div>`;
    card.addEventListener('click', () => openDetail(series.Id));
    return card;
  }

  function renderCards(list) {
    grid.innerHTML = '';
    emptyState.hidden = list.length > 0;
    list.forEach((series, index) => {
      const card = buildCard(series);
      card.style.setProperty('--delay', `${Math.min(index, 10) * 35}ms`);
      grid.appendChild(card);
    });
  }

  let carouselObservers = [];
  function clearCarousels() {
    carouselObservers.forEach((observer) => observer.disconnect());
    carouselObservers = [];
    carouselAutoplayStops.forEach((stop) => stop());
    carouselAutoplayStops = [];
  }

  function buildCarousel(items, builder = buildCard) {
    const carousel = document.createElement('div');
    carousel.className = 'carousel';

    const track = document.createElement('div');
    track.className = 'carousel-track';
    items.forEach((item, index) => {
      const card = builder(item, index);
      card.style.setProperty('--delay', `${Math.min(index, 8) * 45}ms`);
      track.appendChild(card);
    });

    const prev = buildCarouselArrow('prev', '‹', 'Anterior');
    const next = buildCarouselArrow('next', '›', 'Siguiente');
    carousel.append(prev, track, next);

    function sync() {
      const max = track.scrollWidth - track.clientWidth;
      carousel.classList.toggle('no-scroll', max <= 1);
      prev.disabled = track.scrollLeft <= 1;
      next.disabled = track.scrollLeft >= max - 1;
    }

    const jump = () => Math.max(track.clientWidth * 0.85, 160);
    prev.addEventListener('click', () => track.scrollBy({ left: -jump(), behavior: 'smooth' }));
    next.addEventListener('click', () => track.scrollBy({ left: jump(), behavior: 'smooth' }));
    track.addEventListener('scroll', sync, { passive: true });

    const observer = new ResizeObserver(sync);
    observer.observe(track);
    carouselObservers.push(observer);
    sync();
    carouselAutoplayStops.push(enableCarouselAutoplay(carousel, track, sync, jump));

    return carousel;
  }

  function enableCarouselAutoplay(carousel, track, sync, jump) {
    let timer = null;
    let paused = false;

    const step = () => {
      if (paused) return;
      const max = track.scrollWidth - track.clientWidth;
      if (max <= 1) return;

      const atEnd = track.scrollLeft >= max - 2;
      const target = atEnd ? 0 : Math.min(track.scrollLeft + jump(), max);
      track.scrollTo({ left: target, behavior: 'smooth' });
      sync();
    };

    const start = () => {
      stop();
      if (track.scrollWidth - track.clientWidth <= 1) return;
      timer = setInterval(step, CAROUSEL_AUTOPLAY_MS);
    };

    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    };

    const pause = () => {
      paused = true;
      stop();
    };

    const resume = () => {
      paused = false;
      start();
    };

    carousel.addEventListener('mouseenter', pause);
    carousel.addEventListener('mouseleave', resume);
    carousel.addEventListener('focusin', pause);
    carousel.addEventListener('focusout', resume);
    track.addEventListener('pointerdown', pause);
    track.addEventListener('pointerup', resume);
    track.addEventListener('touchstart', pause, { passive: true });
    track.addEventListener('touchend', resume, { passive: true });

    start();

    return () => {
      stop();
      carousel.removeEventListener('mouseenter', pause);
      carousel.removeEventListener('mouseleave', resume);
      carousel.removeEventListener('focusin', pause);
      carousel.removeEventListener('focusout', resume);
      track.removeEventListener('pointerdown', pause);
      track.removeEventListener('pointerup', resume);
      track.removeEventListener('touchstart', pause);
      track.removeEventListener('touchend', resume);
    };
  }

  function buildCarouselArrow(dir, glyph, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'carousel-nav ' + dir;
    btn.setAttribute('aria-label', label);
    btn.textContent = glyph;
    return btn;
  }

  function buildResumeCard(item) {
    const card = document.createElement('article');
    card.className = 'resume-card reveal-up';
    const progress = item.DurationSec ? Math.max(0, Math.min(100, Math.round((item.PositionSec / item.DurationSec) * 100))) : 0;
    const minutesSeen = Math.max(1, Math.round((item.PositionSec || 0) / 60));
    card.innerHTML = `
      <div class="resume-poster-wrap">
        <img class="resume-poster" src="${poster(item.PosterUrl)}" alt="${item.Title}" loading="lazy" />
        <div class="resume-overlay"></div>
        <span class="resume-type">${getContentTypeMeta(item.ContentType).label}</span>
        <div class="resume-progress"><span style="width:${progress}%"></span></div>
      </div>
      <div class="resume-body">
        <h4>${item.Title}</h4>
        <p>T${item.SeasonNumber} · E${item.EpisodeNumber} · ${item.EpisodeTitle}</p>
        <p class="resume-meta">${minutesSeen} min vistos${item.DurationSec ? ` · ${progress}%` : ''}</p>
        <button type="button" class="btn btn-primary btn-small">Continuar</button>
      </div>`;
    card.addEventListener('click', () => resumeProgress(item));
    card.querySelector('button').addEventListener('click', (event) => {
      event.stopPropagation();
      resumeProgress(item);
    });
    return card;
  }

  function buildSectionShell(title, total, buttonLabel = 'Ver más') {
    const section = document.createElement('section');
    section.className = 'type-section';
    const head = document.createElement('div');
    head.className = 'type-section-head';
    head.innerHTML = `
      <h3>${title}</h3>
      <span class="type-count">${total}</span>
      ${buttonLabel ? `<button class="btn btn-ghost type-section-all" type="button">${buttonLabel}</button>` : ''}`;
    section.appendChild(head);
    return section;
  }

  function buildContinueEmptyState() {
    const empty = document.createElement('div');
    empty.className = 'continue-empty reveal-up';
    empty.innerHTML = `
      <div class="continue-empty-glow"></div>
      <h4>Aún no tienes nada para retomar</h4>
      <p>Cuando dejes una serie o película a medias, Noxis la mostrará aquí con el capítulo y minuto exacto.</p>
    `;
    return empty;
  }

  function renderSections(sections, continueWatching) {
    clearCarousels();
    sectionsEl.innerHTML = '';

    if (API.getToken()) {
      const section = buildSectionShell('Seguir viendo', continueWatching.length, '');
      section.classList.add('continue-section');
      section.appendChild(
        continueWatching.length
          ? buildCarousel(continueWatching, buildResumeCard)
          : buildContinueEmptyState()
      );
      sectionsEl.appendChild(section);
    }

    sections.forEach(({ type, items, total }) => {
      const section = buildSectionShell(getContentTypeMeta(type).section, total);
      const button = section.querySelector('.type-section-all');
      button.addEventListener('click', () => openBrowse(type));
      section.appendChild(buildCarousel(items));
      sectionsEl.appendChild(section);
    });
  }

  function dedupeById(items) {
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.Id)) return false;
      seen.add(item.Id);
      return true;
    });
  }

  function buildHeroSlides(sections) {
    const MAX_HERO_SLIDES = 6;
    const buckets = sections
      .map((section) => dedupeById((section.items || []).filter((item) => item.BackdropUrl || item.PosterUrl)))
      .filter((items) => items.length);

    const slides = [];
    let cursor = 0;

    while (buckets.some((items) => items.length) && slides.length < MAX_HERO_SLIDES) {
      const bucket = buckets[cursor % buckets.length];
      const next = bucket.shift();
      if (next && !slides.some((item) => item.Id === next.Id)) {
        slides.push(next);
      }
      cursor += 1;
    }

    return slides;
  }

  function stopHeroRotation() {
    clearInterval(heroTimer);
    heroTimer = null;
  }

  function startHeroRotation() {
    stopHeroRotation();
    if (state.heroSlides.length <= 1) return;
    heroTimer = setInterval(() => setHeroIndex(state.heroIndex + 1), HERO_ROTATE_MS);
  }

  function setHeroIndex(nextIndex) {
    if (!state.heroSlides.length) return;
    state.heroIndex = (nextIndex + state.heroSlides.length) % state.heroSlides.length;
    paintHero();
  }

  function paintHero() {
    const slide = state.heroSlides[state.heroIndex];
    if (!slide) {
      heroEl.hidden = true;
      heroDotsEl.innerHTML = '';
      return;
    }

    heroEl.hidden = false;
    heroBgEl.style.backgroundImage = `url('${slide.BackdropUrl || slide.PosterUrl}')`;
    heroBadgeEl.textContent = getContentTypeMeta(slide.ContentType).badge;
    heroTitleEl.textContent = slide.Title;
    heroMetaEl.textContent = [
      getContentTypeMeta(slide.ContentType).label,
      slide.ReleaseYear,
      slide.Genres,
      slide.Rating != null ? '★ ' + Number(slide.Rating).toFixed(1) : ''
    ].filter(Boolean).join('  ·  ');
    heroDescEl.textContent = slide.Description || '';
    $('heroPlay').onclick = () => playSeries(slide.Id);
    $('heroInfo').onclick = () => openDetail(slide.Id);

    heroDotsEl.innerHTML = '';
    state.heroSlides.forEach((_item, index) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'hero-dot' + (index === state.heroIndex ? ' active' : '');
      dot.setAttribute('aria-label', `Ir al destacado ${index + 1}`);
      dot.addEventListener('click', () => {
        setHeroIndex(index);
        startHeroRotation();
      });
      heroDotsEl.appendChild(dot);
    });
  }

  function renderHero(slides) {
    state.heroSlides = slides || [];
    state.heroIndex = 0;
    if (!state.heroSlides.length) {
      heroEl.hidden = true;
      stopHeroRotation();
      return;
    }
    paintHero();
    startHeroRotation();
  }

  function pageWindow(current, totalPages) {
    const pages = new Set([1, totalPages]);
    for (let page = current - 1; page <= current + 1; page += 1) {
      if (page >= 1 && page <= totalPages) pages.add(page);
    }
    const ordered = [...pages].sort((a, b) => a - b);
    return ordered.flatMap((page, index) => (index && page - ordered[index - 1] > 1 ? ['…', page] : [page]));
  }

  function renderPagination(total, totalPages) {
    paginationEl.innerHTML = '';
    paginationEl.hidden = totalPages <= 1;
    if (totalPages <= 1) return;

    const goToPage = (page) => {
      state.page = page;
      loadCatalog();
      browseEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const arrow = (label, target, active) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'page-btn page-step';
      btn.textContent = label;
      btn.disabled = !active;
      if (active) btn.addEventListener('click', () => goToPage(target));
      return btn;
    };

    paginationEl.appendChild(arrow('‹ Anterior', state.page - 1, state.page > 1));

    const numbers = document.createElement('div');
    numbers.className = 'page-numbers';
    pageWindow(state.page, totalPages).forEach((page) => {
      if (page === '…') {
        const gap = document.createElement('span');
        gap.className = 'page-gap';
        gap.textContent = '…';
        numbers.appendChild(gap);
        return;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'page-btn' + (page === state.page ? ' active' : '');
      btn.textContent = page;
      if (page === state.page) btn.setAttribute('aria-current', 'page');
      else btn.addEventListener('click', () => goToPage(page));
      numbers.appendChild(btn);
    });
    paginationEl.appendChild(numbers);

    const summary = document.createElement('span');
    summary.className = 'page-summary';
    summary.textContent = `${state.page} / ${totalPages}`;
    paginationEl.appendChild(summary);

    paginationEl.appendChild(arrow('Siguiente ›', state.page + 1, state.page < totalPages));
  }

  function syncFilterInputs() {
    $('contentTypeFilter').value = state.contentType;
    $('browseType').value = state.contentType;
    $('genreFilter').value = state.genre;
    $('browseGenre').value = state.genre;
    if ($('searchInput').value.trim() !== state.search) $('searchInput').value = state.search;
  }

  function render() {
    syncFilterInputs();
    syncNav();
    loadCatalog();
  }

  function openBrowse(type) {
    state.view = 'browse';
    state.contentType = type || '';
    state.page = 1;
    render();
  }

  function applyFilter(field, value) {
    state[field] = value || '';
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

  const detailModal = $('detailModal');

  async function openDetail(id) {
    try {
      const data = await API.seriesDetail(id);
      state.detail = data;
      $('detailBg').style.backgroundImage = `url('${data.BackdropUrl || data.PosterUrl}')`;
      $('detailTitle').textContent = data.Title;
      $('detailMeta').textContent = [
        getContentTypeMeta(data.ContentType).label,
        data.ReleaseYear,
        (data.genres || []).map((genre) => genre.Name).join(', '),
        data.Rating != null ? '★ ' + Number(data.Rating).toFixed(1) : ''
      ].filter(Boolean).join('  ·  ');
      $('detailDesc').textContent = data.Description || '';

      const seasonSelect = $('seasonSelect');
      seasonSelect.innerHTML = '';
      data.seasons.forEach((season, index) => {
        const opt = document.createElement('option');
        opt.value = index;
        opt.textContent = season.Title || `Temporada ${season.SeasonNumber}`;
        seasonSelect.appendChild(opt);
      });

      $('seasonSelectGroup').hidden = data.ContentType === 'movie' || data.seasons.length <= 1;
      $('detailAudioSelect').onchange = (event) => {
        setSeriesAudioPref(data.Id, event.target.value || '');
      };
      seasonSelect.onchange = () => {
        const selectedSeasonIndex = Number(seasonSelect.value);
        renderEpisodes(data.seasons[selectedSeasonIndex]);
        renderDetailAudioOptions(data, selectedSeasonIndex);
      };
      renderEpisodes(data.seasons[0]);
      await renderDetailAudioOptions(data, 0);

      $('detailPlay').onclick = () => openPlaybackFromDetail(
        data,
        (data.seasons[Number(seasonSelect.value)] || data.seasons[0]).episodes[0]?.Id || null,
        0
      );
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
    season.episodes.forEach((episode, index) => {
      const row = document.createElement('div');
      row.className = 'episode-row';
      const mins = episode.DurationSec ? Math.round(episode.DurationSec / 60) + ' min' : '';
      row.innerHTML = `
        <div class="episode-num">${episode.EpisodeNumber}</div>
        <img class="episode-thumb" src="${episode.ThumbnailUrl || poster(null)}" alt="" loading="lazy" />
        <div class="episode-info">
          <h4>${episode.Title}</h4>
          <p>${episode.Description || ''}</p>
        </div>
        <div class="episode-dur">${mins}</div>
        <div class="episode-play">▶</div>`;
      row.addEventListener('click', () => {
        closeModal(detailModal);
        Player.open(season.episodes, index, state.detail.Title, {
          seriesId: state.detail.Id,
          hooks: createPlayerHooks()
        });
      });
      listEl.appendChild(row);
    });
  }

  async function playSeries(id) {
    try {
      const data = await API.seriesDetail(id);
      await openPlaybackFromDetail(data);
    } catch (err) {
      toast(err.message);
    }
  }

  function updateListButton() {
    const btn = $('detailListBtn');
    if (!state.detail) return;
    if (!API.getToken()) {
      btn.textContent = '+ Mi Lista';
      btn.onclick = () => {
        closeModal(detailModal);
        openAuth('login');
        toast('Inicia sesión para guardar series');
      };
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
      } catch (err) {
        toast(err.message);
      }
    };
  }

  function openModal(modal) {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeModal(modal) {
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  document.querySelectorAll('[data-close]').forEach((el) =>
    el.addEventListener('click', () => closeModal(el.closest('.modal'))));

  let authMode = 'login';
  function openAuth(mode) {
    authMode = mode;
    const isLogin = mode === 'login';
    $('authTitle').textContent = isLogin ? 'Iniciar sesión' : 'Crear cuenta';
    $('authSubmit').textContent = isLogin ? 'Entrar' : 'Registrarme';
    $('usernameField').hidden = isLogin;
    $('emailField').hidden = isLogin;
    $('identifierLabel').parentElement.hidden = !isLogin;
    $('authSwitchText').textContent = isLogin ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?';
    $('authSwitchLink').textContent = isLogin ? 'Regístrate' : 'Inicia sesión';
    $('authError').hidden = true;
    openModal($('authModal'));
  }

  $('authSwitchLink').addEventListener('click', (event) => {
    event.preventDefault();
    openAuth(authMode === 'login' ? 'register' : 'login');
  });

  $('authForm').addEventListener('submit', async (event) => {
    event.preventDefault();
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
      await Promise.all([refreshMyListIds(), refreshContinueWatching(true)]);
      refreshAuthUI();
      closeModal($('authModal'));
      toast(`¡Hola, ${resp.user.Username}!`);
      $('authForm').reset();
      if (state.view === 'home') render();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  function switchView(view) {
    if (view === 'mylist' && !API.getToken()) { openAuth('login'); return; }
    state.view = view;
    state.page = 1;
    if (view === 'home') {
      state.contentType = '';
      state.genre = '';
      state.search = '';
    }
    render();
  }

  document.querySelectorAll('[data-view]').forEach((a) =>
    a.addEventListener('click', (event) => { event.preventDefault(); switchView(a.dataset.view); }));
  document.querySelectorAll('[data-type]').forEach((a) =>
    a.addEventListener('click', (event) => { event.preventDefault(); openBrowse(a.dataset.type); }));

  let searchTimer = null;
  $('searchInput').addEventListener('input', (event) => {
    const text = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applyFilter('search', text), 300);
  });
  $('contentTypeFilter').addEventListener('change', (event) => applyFilter('contentType', event.target.value));
  $('browseType').addEventListener('change', (event) => applyFilter('contentType', event.target.value));
  $('genreFilter').addEventListener('change', (event) => applyFilter('genre', event.target.value));
  $('browseGenre').addEventListener('change', (event) => applyFilter('genre', event.target.value));
  $('clearFilters').addEventListener('click', () => {
    state.search = '';
    state.genre = '';
    state.contentType = '';
    state.page = 1;
    if (state.view === 'browse') state.view = 'home';
    render();
  });

  $('heroPrev').addEventListener('click', () => {
    setHeroIndex(state.heroIndex - 1);
    startHeroRotation();
  });
  $('heroNext').addEventListener('click', () => {
    setHeroIndex(state.heroIndex + 1);
    startHeroRotation();
  });
  heroEl.addEventListener('mouseenter', stopHeroRotation);
  heroEl.addEventListener('mouseleave', startHeroRotation);

  async function loadGenres() {
    try {
      const genres = await API.genres();
      const selects = [$('genreFilter'), $('browseGenre')];
      genres.forEach((genre) => {
        selects.forEach((sel) => {
          const opt = document.createElement('option');
          opt.value = genre.Name;
          opt.textContent = genre.Name;
          sel.appendChild(opt);
        });
      });
    } catch {
      /* silencioso */
    }
  }

  async function init() {
    refreshAuthUI();
    await Promise.all([loadGenres(), refreshMyListIds(), refreshContinueWatching(true)]);
    render();
  }

  init();
})();
