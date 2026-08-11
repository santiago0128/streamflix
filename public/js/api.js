// Cliente de la API + manejo de sesión (token en localStorage)
const API = (() => {
  const TOKEN_KEY = 'streamflix_token';
  const USER_KEY = 'streamflix_user';

  const getToken = () => localStorage.getItem(TOKEN_KEY);
  const getUser = () => { try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; } };
  const setSession = (token, user) => {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  };
  const clearSession = () => { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); };

  async function req(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const token = getToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch('/api' + path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) clearSession();
      throw new Error(data.error || ('Error ' + res.status));
    }
    return data;
  }

  return {
    getToken, getUser, setSession, clearSession,
    genres: () => req('/genres'),
    contentTypes: () => req('/content-types'),
    // Sin `page` responde un array con todo; con `page`, un objeto
    // { items, total, page, pageSize, totalPages }.
    series: ({ search, genre, type, page, pageSize } = {}) => {
      const qs = new URLSearchParams();
      if (search) qs.set('search', search);
      if (genre) qs.set('genre', genre);
      if (type) qs.set('type', type);
      if (page) { qs.set('page', page); qs.set('pageSize', pageSize || 24); }
      return req('/series' + (qs.toString() ? '?' + qs : ''));
    },
    seriesDetail: (id) => req('/series/' + id),
    episodePlayback: (id, { audio } = {}) => {
      const qs = new URLSearchParams();
      if (audio) qs.set('audio', audio);
      return req('/episodes/' + id + '/playback' + (qs.toString() ? '?' + qs : ''));
    },
    register: (username, email, password) => req('/auth/register', { method: 'POST', body: { username, email, password } }),
    login: (identifier, password) => req('/auth/login', { method: 'POST', body: { identifier, password } }),
    me: () => req('/auth/me'),
    watchlist: () => req('/watchlist'),
    addToList: (seriesId) => req('/watchlist', { method: 'POST', body: { seriesId } }),
    removeFromList: (seriesId) => req('/watchlist/' + seriesId, { method: 'DELETE' }),
    continueWatching: (limit = 12) => req('/progress/continue-watching?limit=' + encodeURIComponent(limit)),
    saveProgress: (episodeId, positionSec, durationSec) => req('/progress/' + episodeId, {
      method: 'PUT',
      body: { positionSec, durationSec }
    }),
  };
})();
