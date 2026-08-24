'use strict';

const https = require('https');
const { sql } = require('../db');

const ANILIST_API = 'https://graphql.anilist.co';
const TMDB_API = 'https://api.themoviedb.org/3';
const REQUEST_TIMEOUT_MS = 15000;

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)?.join(' ')
    .trim() || '';
}

function identityKey(value, contentType = '') {
  const normalized = normalizeTitle(value);
  if (contentType !== 'anime') return normalized;
  // El catálogo agrupa temporadas en una ficha. Los sitios de origen suelen
  // llamar a esa misma ficha "X Temporada 1", mientras AniList declara "X".
  return normalized
    .replace(/\s+(?:temporada|season)\s+(?:final|\d+)$/i, '')
    .trim();
}

function uniqueAliases(values) {
  const seen = new Set();
  const aliases = [];
  for (const value of values || []) {
    const alias = String(value || '').trim();
    const normalized = normalizeTitle(alias);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push({ alias, normalized });
  }
  return aliases;
}

function requestJson(url, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request(url, {
      method,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'NoxisIdentity/1.0',
        ...(payload ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        } : {}),
        ...headers
      }
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        if ((res.statusCode || 0) >= 400) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(text));
        } catch {
          reject(new Error('respuesta JSON inválida'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('tiempo de espera agotado')));
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

async function resolveAnimeIdentity(title) {
  const query = `
    query ($search: String) {
      Media(search: $search, type: ANIME) {
        id
        idMal
        seasonYear
        title { romaji english native }
        synonyms
      }
    }
  `;
  const response = await requestJson(ANILIST_API, {
    method: 'POST',
    body: { query, variables: { search: title } }
  });
  const media = response?.data?.Media;
  if (!media?.id) return null;

  const aliases = uniqueAliases([
    media.title?.romaji,
    media.title?.english,
    media.title?.native,
    ...(media.synonyms || [])
  ]);
  const requested = normalizeTitle(title);

  // AniList siempre devuelve "lo más parecido". Para usarlo como identidad,
  // el texto pedido debe ser uno de los nombres que la propia ficha declara;
  // así una búsqueda aproximada no puede bloquear otra obra por error.
  if (!aliases.some((item) => item.normalized === requested)) return null;

  return {
    canonicalRef: `anilist:${media.id}`,
    aliases,
    year: media.seasonYear || null
  };
}

function tmdbAuth() {
  const key = String(process.env.TMDB_API_KEY || '').trim();
  if (!key) return null;
  return key.startsWith('eyJ')
    ? { query: '', headers: { Authorization: `Bearer ${key}` } }
    : { query: `&api_key=${encodeURIComponent(key)}`, headers: {} };
}

async function resolveTmdbIdentity(title, contentType) {
  const auth = tmdbAuth();
  if (!auth) return null;
  const mediaType = contentType === 'movie' ? 'movie' : 'tv';
  const url = `${TMDB_API}/search/${mediaType}?language=es-ES&query=${encodeURIComponent(title)}${auth.query}`;
  const response = await requestJson(url, { headers: auth.headers });
  const requested = normalizeTitle(title);

  for (const item of (response?.results || []).slice(0, 10)) {
    const aliases = uniqueAliases([
      item.title,
      item.name,
      item.original_title,
      item.original_name
    ]);
    if (!aliases.some((alias) => alias.normalized === requested)) continue;
    const date = item.release_date || item.first_air_date || '';
    return {
      canonicalRef: `tmdb:${mediaType}:${item.id}`,
      aliases,
      year: Number(String(date).slice(0, 4)) || null
    };
  }
  return null;
}

async function resolveIdentity(title, contentType) {
  try {
    if (contentType === 'anime') return await resolveAnimeIdentity(title);
    if (contentType === 'movie' || contentType === 'series') {
      return await resolveTmdbIdentity(title, contentType);
    }
  } catch (error) {
    // La fuente externa mejora la detección, pero una caída suya no debe impedir
    // solicitar contenido nuevo. La comprobación local sigue funcionando.
    console.warn(`No se pudo resolver la identidad de "${title}": ${error.message || error}`);
  }
  return null;
}

async function findExistingContent(pool, { title, contentType }) {
  const requested = normalizeTitle(title);
  if (!requested) return null;

  // Se compara en JS para usar exactamente la misma normalización Unicode con
  // títulos latinos, romaji y japonés. Además, las ramas dinámicas permiten que
  // la API siga funcionando durante un despliegue en el que el código nuevo ya
  // arrancó pero schema.sql todavía no se ha aplicado.
  const result = await pool.request()
    .input('contentType', sql.NVarChar(20), contentType)
    .query(`
      IF COL_LENGTH('dbo.Series', 'CanonicalRef') IS NOT NULL
        EXEC sp_executesql
          N'SELECT Id, Title, ContentType, ReleaseYear, CanonicalRef
              FROM dbo.Series WHERE ContentType = @tipo',
          N'@tipo NVARCHAR(20)', @tipo=@contentType;
      ELSE
        SELECT Id, Title, ContentType, ReleaseYear, CAST(NULL AS NVARCHAR(100)) AS CanonicalRef
          FROM dbo.Series WHERE ContentType = @contentType;

      IF OBJECT_ID('dbo.SeriesAliases', 'U') IS NOT NULL
        EXEC(N'SELECT SeriesId, Alias, AliasNormalized FROM dbo.SeriesAliases');
      ELSE
        SELECT CAST(NULL AS INT) AS SeriesId, CAST(NULL AS NVARCHAR(500)) AS Alias,
               CAST(NULL AS NVARCHAR(500)) AS AliasNormalized WHERE 1 = 0;
    `);

  const rows = result.recordsets[0] || [];
  const savedAliases = new Map();
  for (const item of (result.recordsets[1] || [])) {
    if (!savedAliases.has(item.SeriesId)) savedAliases.set(item.SeriesId, new Set());
    savedAliases.get(item.SeriesId).add(item.AliasNormalized || normalizeTitle(item.Alias));
  }

  const findBy = (wanted, canonicalRef = null) => rows.find((series) => {
    if (canonicalRef && series.CanonicalRef === canonicalRef) return true;
    if (wanted.has(identityKey(series.Title, contentType))) return true;
    return [...(savedAliases.get(series.Id) || [])]
      .some((alias) => wanted.has(identityKey(alias, contentType)));
  }) || null;

  const local = findBy(new Set([identityKey(title, contentType)]));
  if (local) return local;

  // Solo se consulta AniList/TMDB cuando el nombre local no basta. La mayoría
  // de solicitudes usan el mismo título de la web y no deben esperar una
  // petición externa para enterarse de que ya existe.
  const identity = await resolveIdentity(title, contentType);
  if (!identity) return null;
  const wanted = new Set(uniqueAliases([
    title,
    ...identity.aliases.map((item) => item.alias)
  ]).map((item) => identityKey(item.alias, contentType)));
  return findBy(wanted, identity.canonicalRef);
}

module.exports = {
  findExistingContent,
  identityKey,
  normalizeTitle,
  resolveAnimeIdentity,
  resolveIdentity,
  resolveTmdbIdentity,
  uniqueAliases
};
