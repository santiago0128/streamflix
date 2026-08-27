'use strict';

/**
 * Título original de una obra a partir de su título en español, vía Wikidata.
 *
 * Para qué: TMDB indexa por título original, no por el de estreno en cada país.
 * Su buscador no encuentra "Sueño de fuga" ni "Parásitos" —devuelve "Sin
 * resultados"— y el catálogo se importa de sitios latinoamericanos, que es
 * justo como se titulan ahí. Sin puente, esas fichas se quedaban sin portada
 * para siempre por mucho que se repitiera la pasada.
 *
 * Wikidata sí conoce esos títulos y guarda la etiqueta en inglés, que es la que
 * TMDB entiende. La imagen de Wikidata (P18) no sirve: los carteles tienen
 * derechos y casi nunca están en Commons. Lo que se aprovecha es el nombre.
 *
 * No pide clave, que es la razón de usarlo: TMDB_API_KEY resolvería esto mejor
 * —su API sí busca títulos alternativos— pero mientras no esté configurada,
 * esta es la única vía.
 *
 * Verifica antes de devolver nada. `wbsearchentities` ordena por relevancia y
 * su primer resultado puede ser cualquier cosa: buscando "La Odisea" devuelve
 * el poema de Homero, y así es como una ficha acabó con la foto de un
 * manuscrito por portada. Se exige que la entidad sea una película o serie
 * (P31) y que el año cuadre cuando se conoce.
 */

const { requestText } = require('./tmdb');

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';

// "Instancia de" que aceptamos. Mismas clases que usa el importador.
const CLASES_PELICULA = new Set(['Q11424', 'Q506240', 'Q24869']);
const CLASES_SERIE = new Set(['Q5398426', 'Q1259759', 'Q581714']);

// Cuántos candidatos de la búsqueda se examinan. El primero no basta —es el que
// devolvía el poema en vez de la película— y pedir muchos es una sola petición.
const CANDIDATOS = 5;

const normalizar = (valor) => String(valor || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .match(/[\p{L}\p{N}]+/gu)?.join(' ') || '';

async function pedirJson(url) {
  const texto = await requestText(String(url));
  return JSON.parse(texto);
}

/** Ids candidatos para un nombre, en español y con el inglés como respaldo. */
async function buscarIds(nombre) {
  const ids = [];
  for (const idioma of ['es', 'en']) {
    const url = new URL(WIKIDATA_API);
    url.searchParams.set('action', 'wbsearchentities');
    url.searchParams.set('search', nombre);
    url.searchParams.set('language', idioma);
    url.searchParams.set('uselang', idioma);
    url.searchParams.set('type', 'item');
    url.searchParams.set('limit', String(CANDIDATOS));
    url.searchParams.set('format', 'json');

    const datos = await pedirJson(url);
    for (const item of (datos?.search || [])) {
      if (item.id && !ids.includes(item.id)) ids.push(item.id);
    }
    if (ids.length) break;
  }
  return ids;
}

/** Etiquetas, alias, "instancia de" y fecha de estreno de varias entidades. */
async function detallesDe(ids) {
  if (!ids.length) return {};
  const url = new URL(WIKIDATA_API);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', ids.join('|'));
  url.searchParams.set('props', 'labels|aliases|claims');
  url.searchParams.set('languages', 'es|en');
  url.searchParams.set('format', 'json');

  const datos = await pedirJson(url);
  return datos?.entities || {};
}

function clasesDe(entidad) {
  return (entidad?.claims?.P31 || [])
    .map((c) => c?.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

function anioDe(entidad) {
  for (const claim of (entidad?.claims?.P577 || [])) {
    const hora = claim?.mainsnak?.datavalue?.value?.time;
    const anio = hora && Number(String(hora).replace(/^[+-]/, '').slice(0, 4));
    if (anio) return anio;
  }
  return null;
}

function nombresDe(entidad, idioma) {
  const etiqueta = entidad?.labels?.[idioma]?.value;
  const alias = (entidad?.aliases?.[idioma] || []).map((a) => a.value);
  return [etiqueta, ...alias].filter(Boolean);
}

/**
 * Devuelve `{ title, year }` con el título en inglés, o null si no se puede
 * afirmar con seguridad cuál es la obra.
 *
 * @param {{Title: string, ReleaseYear: number|null, ContentType: string}} series
 */
async function findEnglishTitle(series) {
  const pedido = normalizar(series?.Title);
  if (!pedido) return null;

  const esperadas = series.ContentType === 'series' ? CLASES_SERIE : CLASES_PELICULA;

  let ids;
  try {
    ids = await buscarIds(series.Title);
  } catch {
    return null;
  }
  if (!ids.length) return null;

  let entidades;
  try {
    entidades = await detallesDe(ids);
  } catch {
    return null;
  }

  const validas = [];
  for (const id of ids) {
    const entidad = entidades[id];
    if (!entidad) continue;

    // Tiene que ser del tipo que buscamos: sin esto entra el poema homérico.
    if (!clasesDe(entidad).some((clase) => esperadas.has(clase))) continue;

    // Y tiene que llamarse como lo que pedimos, en español o en inglés. La
    // búsqueda ya ordena por relevancia, pero "relevante" no es "la misma obra".
    const nombres = [...nombresDe(entidad, 'es'), ...nombresDe(entidad, 'en')];
    if (!nombres.some((nombre) => normalizar(nombre) === pedido)) continue;

    const anio = anioDe(entidad);
    // Un año que no cuadra es casi siempre un remake u otra obra homónima.
    if (series.ReleaseYear && anio && Math.abs(series.ReleaseYear - anio) > 1) continue;

    const ingles = entidad?.labels?.en?.value;
    if (!ingles) continue;
    validas.push({ title: ingles, year: anio, id });
  }

  // Igual que en TMDB: si más de una obra pasa todos los filtros, no hay con
  // qué separarlas y elegir es adivinar. Mejor sin portada que con la de otra
  // película, que es el error que nadie revisa después.
  return validas.length === 1 ? validas[0] : null;
}

module.exports = { findEnglishTitle };
