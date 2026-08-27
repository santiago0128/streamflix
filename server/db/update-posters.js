#!/usr/bin/env node

/**
 * Reemplaza las portadas del catálogo por las del origen que corresponda:
 * AniList para el anime, TMDB para películas y series.
 *
 * Las portadas venían de las páginas de las que se importó cada título
 * (cuevana3, pelisplushd, jkdesa, henaojara): miniaturas de 10-18 KB que se ven
 * borrosas en la ficha grande, y alojadas en dominios que cambian de número
 * cada pocos meses — el día que ww9 pase a ww10 se caen todas a la vez.
 *
 * El anime va primero a AniList porque guarda el título en romaji, en inglés y
 * en japonés, que es por donde vienen los títulos del catálogo, y su carátula es
 * la oficial del anime; si allí no aparece, se prueba TMDB.
 *
 * Se guarda la URL, no la imagen: no se descarga ni se re-aloja nada.
 *
 *   node server/db/update-posters.js                  # simulación, los tres tipos
 *   node server/db/update-posters.js --apply          # escribe la base
 *   node server/db/update-posters.js --type=anime     # solo un tipo
 *   node server/db/update-posters.js --ids=4,6,11     # solo esas fichas
 *   node server/db/update-posters.js --force          # también las ya migradas
 *
 * Es idempotente: sin --force salta lo que ya está en un CDN bueno, así que se
 * puede repetir sin volver a pedir nada.
 */

require('dotenv').config();
const fs = require('fs');
const { sql, getPool } = require('../db');
const { TMDB_BASE_URL, findTmdbMatch, requestText, normalizeSearchTitle } = require('./tmdb');
const { fetchAnimeArtwork } = require('./anilist');
const { findEnglishTitle } = require('./wikidata');
const { imagenViva } = require('../lib/imagen');

// 500 px de ancho: la ficha de detalle es la que más la agranda y ahí ya se ve
// nítida, sin irse a los 200 KB de w780 en una parrilla de decenas de portadas.
const POSTER_CDN = 'https://image.tmdb.org/t/p/w500';

// Orígenes que ya sirven una portada buena y estable. Lo que esté aquí no se
// toca sin --force: el anime importado de Kitsu, por ejemplo, ya trae la suya, y
// cambiarla por otra no la mejora.
//
// themoviedb.org va aquí junto a tmdb.org porque son el mismo sitio: TMDB sirve
// hoy las imágenes desde media.themoviedb.org y antes desde image.tmdb.org, con
// el mismo fichero al final de la ruta. Sin esto, la pasada diaria proponía
// reescribir dos docenas de fichas —Iron Man entre ellas— para cambiar sólo el
// host de una imagen idéntica: mucho ruido, ningún arreglo, y una escritura
// diaria en filas que ya estaban bien.
const CDN_BUENOS = /(^|\.)(tmdb\.org|themoviedb\.org|kitsu\.io|kitsu\.app|anilist\.co|anili\.st)$/;

const TIPOS = ['movie', 'series', 'anime'];

function parseArgs(argv) {
  const args = { apply: false, force: false, ids: null, types: TIPOS, conDesfase: false, respaldo: null, revisar: false };

  for (const token of argv) {
    if (token === '--apply') args.apply = true;
    else if (token === '--force') args.force = true;
    else if (token === '--con-desfase-de-año' || token === '--con-desfase-de-ano') args.conDesfase = true;
    else if (token === '--revisar') args.revisar = true;
    else if (token.startsWith('--respaldo=')) args.respaldo = token.slice('--respaldo='.length).trim();
    else if (token.startsWith('--type=')) {
      args.types = token
        .slice('--type='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (token.startsWith('--ids=')) {
      args.ids = token
        .slice('--ids='.length)
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
    }
  }

  return args;
}

/**
 * ¿Son la misma imagen, aunque la URL no sea idéntica?
 *
 * TMDB sirve el mismo fichero desde image.tmdb.org y desde media.themoviedb.org,
 * y el nombre del fichero es su identidad. Comparando la URL entera, una portada
 * correcta guardada con el host antiguo se veía como distinta de la resuelta con
 * el nuevo, y la pasada diaria reescribía dos docenas de fichas —Iron Man entre
 * ellas— sin cambiar la imagen. Lo que ya está bien no se toca.
 */
function mismaImagen(a, b) {
  const clave = (url) => {
    const texto = String(url || '').trim();
    if (!texto) return '';
    try {
      const { hostname, pathname } = new URL(texto);
      // /t/p/w500/abc.jpg -> abc.jpg, que es lo que identifica la imagen.
      if (/(^|\.)(tmdb\.org|themoviedb\.org)$/.test(hostname)) {
        return `tmdb:${pathname.split('/').filter(Boolean).pop() || ''}`;
      }
      return texto;
    } catch {
      return texto;
    }
  };
  const claveA = clave(a);
  return Boolean(claveA) && claveA === clave(b);
}

function yaEsBuena(url) {
  try {
    return CDN_BUENOS.test(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

/**
 * Saca el fichero de la portada de la ficha de TMDB.
 *
 * La página trae la portada dos veces y en tamaños distintos según el punto de
 * ruptura, pero todas las variantes son el mismo fichero bajo otra carpeta de
 * tamaño: interesa el nombre, que es lo único estable, y el tamaño lo elegimos
 * nosotros al construir la URL final.
 */
function extractPosterFile(html) {
  const posterImg = html.match(/<img class="poster w-full"[^>]+srcset="([^"]+)"/i);
  if (posterImg?.[1]) {
    const entries = posterImg[1]
      .split(',')
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
    const best = entries[entries.length - 1];
    const file = best?.match(/\/t\/p\/[^/]+(\/[^/?"]+)$/);
    if (file) return file[1];
  }

  // Respaldo: la primera og:image de una ficha es la portada (la segunda, si la
  // hay, es el banner). Cubre las fichas sin <img class="poster">, que son las
  // que aún no tienen imagen propia en algunos idiomas.
  const ogImage = html.match(/<meta property="og:image" content="[^"]*\/t\/p\/[^/]+(\/[^/?"]+)"/i);
  return ogImage ? ogImage[1] : null;
}

/** Comprueba que la portada existe antes de guardarla: un 404 en la base es peor que la miniatura vieja. */
const checkImage = (url) => imagenViva(url);

/** Portada de TMDB, para películas y series (y como respaldo del anime). */
async function resolveFromTmdb(series) {
  let match;
  try {
    match = await findTmdbMatch(series);

    // TMDB indexa por título original: su buscador no encuentra "Sueño de fuga"
    // ni "Todo a la vez en todas partes", que es como los titula el sitio del
    // que se importan. Wikidata sí los conoce y da el nombre en inglés, así que
    // se reintenta con él antes de darse por vencido. Sin esto esas fichas se
    // quedaban sin portada por mucho que se repitiera la pasada diaria.
    if (!match) {
      const enIngles = await findEnglishTitle(series);
      if (enIngles && normalizeSearchTitle(enIngles.title) !== normalizeSearchTitle(series.Title)) {
        match = await findTmdbMatch({
          ...series,
          Title: enIngles.title,
          // El año de Wikidata sólo se usa si no había ninguno: es un dato de
          // apoyo para desambiguar, no una corrección del catálogo.
          ReleaseYear: series.ReleaseYear || enIngles.year || null
        });
        if (match) match = { ...match, viaTituloOriginal: enIngles.title };
      }
    }
  } catch (error) {
    return { ok: false, reason: `TMDB no respondió a la búsqueda: ${error.message || error}`, fallo: true };
  }
  if (!match) return { ok: false, reason: 'sin ficha en TMDB que case con el título y el año' };

  // La API ya devuelve la ruta de la portada en la propia búsqueda, así que no
  // hay que abrir la ficha para extraerla del HTML: una petición menos por
  // título y sin depender de la maquetación de la web, que cambia sin avisar.
  let file = match.posterPath || null;

  if (!file) {
    let detailHtml;
    try {
      detailHtml = await requestText(`${TMDB_BASE_URL}${match.path}`);
    } catch (error) {
      return { ok: false, reason: `no se pudo leer la ficha: ${error.message || error}`, fallo: true };
    }
    file = extractPosterFile(detailHtml);
  }

  if (!file) return { ok: false, reason: 'la ficha de TMDB no tiene portada' };

  return {
    ok: true,
    url: `${POSTER_CDN}${file}`,
    origen: 'TMDB',
    match: { ...match, url: `${TMDB_BASE_URL}${match.path}` }
  };
}

/** Carátula de AniList, para anime. */
async function resolveFromAnilist(series) {
  let artwork;
  try {
    artwork = await fetchAnimeArtwork(series);
  } catch (error) {
    return { ok: false, reason: `AniList no respondió: ${error.message || error}`, fallo: true };
  }
  if (!artwork?.posterUrl) return { ok: false, reason: 'sin ficha en AniList que case con el título' };

  return {
    ok: true,
    url: artwork.posterUrl,
    origen: 'AniList',
    match: { title: artwork.title, year: artwork.year, url: artwork.siteUrl }
  };
}

async function resolvePoster(series) {
  // El anime va primero a AniList; si allí no está, se prueba TMDB, que también
  // tiene anime aunque con los títulos en español.
  const intentos = series.ContentType === 'anime'
    ? [resolveFromAnilist, resolveFromTmdb]
    : [resolveFromTmdb];

  let elegido = null;
  const motivos = [];
  for (const intento of intentos) {
    const resultado = await intento(series);
    if (resultado.ok) { elegido = resultado; break; }
    motivos.push(resultado.reason);
  }
  // Con dos orígenes, quedarse con el motivo del último engaña: en el anime se
  // leía "sin ficha en TMDB" sin mencionar que AniList tampoco la tenía.
  if (!elegido) return { ok: false, reason: motivos.join('; ') };

  const image = await checkImage(elegido.url);
  if (!image.ok) {
    return { ok: false, reason: `la portada de ${elegido.origen} no responde (HTTP ${image.status || 'sin respuesta'})` };
  }

  // Un año que no cuadra suele ser una ficha distinta con el mismo nombre: la
  // fila "Bleach (2024)" es el Sennen Kessen-hen, y buscar "Bleach" devuelve el
  // original de 2004, cuya carátula no es la de esa temporada. No se escribe sin
  // que alguien lo mire; --con-desfase-de-año lo fuerza.
  const desfase = series.ReleaseYear && elegido.match.year
    ? Math.abs(series.ReleaseYear - elegido.match.year)
    : 0;

  return { ...elegido, bytes: image.bytes, desfase };
}

const kb = (bytes) => (bytes ? `${Math.round(bytes / 1024)} KB` : '?');

/**
 * Deja la vuelta atrás de una fila antes de tocarla.
 *
 * Se va añadiendo fila a fila en vez de volcarlo todo al principio para que el
 * fichero valga también si el recorrido se corta a medias: contiene exactamente
 * lo que se cambió, ni más ni menos.
 */
function anotarRespaldo(ruta, series) {
  if (!fs.existsSync(ruta)) {
    fs.writeFileSync(ruta,
      '-- Vuelta atrás de las portadas. Ejecutar contra la misma base.\n' +
      `-- Generado: ${new Date().toISOString()}\n\n`);
  }
  const anterior = series.PosterUrl === null || series.PosterUrl === undefined
    ? 'NULL'
    : `'${String(series.PosterUrl).replace(/'/g, "''")}'`;
  fs.appendFileSync(ruta,
    `UPDATE dbo.Series SET PosterUrl = ${anterior} WHERE Id = ${series.Id};` +
    `  -- [${series.ContentType}] ${String(series.Title).replace(/[\r\n]+/g, ' ')}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = await getPool();

  try {
    const desconocidos = args.types.filter((type) => !TIPOS.includes(type));
    if (desconocidos.length) {
      throw new Error(`tipo de contenido desconocido: ${desconocidos.join(', ')}. Válidos: ${TIPOS.join(', ')}`);
    }

    const request = pool.request();
    args.types.forEach((type, i) => request.input(`t${i}`, sql.NVarChar(20), type));
    const typeFilter = args.types.map((_, i) => `@t${i}`).join(', ');
    const idsFilter = args.ids?.length ? `AND Id IN (${args.ids.join(',')})` : '';
    const result = await request.query(`
      SELECT Id, Title, ContentType, ReleaseYear, PosterUrl
      FROM dbo.Series
      WHERE ContentType IN (${typeFilter}) ${idsFilter}
      ORDER BY ContentType, Id
    `);

    // Sin --revisar se decide por el origen de la URL, que es rápido pero solo
    // ve de dónde viene la imagen, no si sigue ahí. --revisar la pide una por
    // una: es lo que destapa las portadas que dan 404 aunque el dominio parezca
    // bueno, que de otro modo no se rehacen nunca.
    let muertas = new Set();
    if (args.revisar) {
      const candidatas = result.recordset.filter((s) => yaEsBuena(s.PosterUrl));
      if (candidatas.length) {
        console.log(`Revisando ${candidatas.length} portada(s) que ya estaban en un CDN bueno...`);
        for (const series of candidatas) {
          const estado = await imagenViva(series.PosterUrl);
          if (!estado.ok) {
            muertas.add(series.Id);
            console.log(`  rota: #${series.Id} ${series.Title} (${estado.status || estado.motivo || 'sin respuesta'})`);
          }
        }
        console.log(muertas.size ? `${muertas.size} rota(s).\n` : 'Ninguna rota.\n');
      }
    }

    // --revisar ahora comprueba también la identidad, no solo que la URL dé
    // 200. Una portada de otra película en image.tmdb.org está perfectamente
    // viva y por eso el chequeo antiguo la declaraba buena para siempre.
    const rows = result.recordset.filter((series) =>
      args.force || args.revisar || muertas.has(series.Id) || !yaEsBuena(series.PosterUrl));
    const yaMigradas = result.recordset.length - rows.length;
    const etiquetaTipos = args.types.join(', ');

    if (!rows.length) {
      console.log(`No hay portadas pendientes (${result.recordset.length} ficha(s) de tipo '${etiquetaTipos}', todas ya en un CDN bueno).`);
      return;
    }

    console.log(
      `${rows.length} portada(s) a resolver de tipo '${etiquetaTipos}'` +
      `${yaMigradas ? ` (${yaMigradas} ya estaban en un CDN bueno, se saltan)` : ''}\n`
    );

    const fallidas = [];
    const dudosas = [];
    let actualizadas = 0;
    let validadas = 0;

    for (const series of rows) {
      const outcome = await resolvePoster(series);

      if (!outcome.ok) {
        fallidas.push({ series, reason: outcome.reason });
        console.log(`#${series.Id} ${series.Title} — omitida: ${outcome.reason}`);
        continue;
      }

      if (outcome.desfase > 1 && !args.conDesfase) {
        dudosas.push({ series, match: outcome.match, url: outcome.url });
        console.log(
          `⚠ [${series.ContentType}] #${series.Id} ${series.Title} (${series.ReleaseYear}) — ` +
          `omitida: casa con ${outcome.match.title} (${outcome.match.year}), ${outcome.desfase} años de desfase`
        );
        continue;
      }

      if (mismaImagen(series.PosterUrl, outcome.url)) {
        validadas += 1;
        console.log(
          `✓ [${series.ContentType}] #${series.Id} ${series.Title} — identidad y portada verificadas (${outcome.origen})`
        );
        continue;
      }

      if (args.apply) {
        // El respaldo se escribe antes que la fila, no después: si la escritura
        // falla a mitad del recorrido, lo ya cambiado sigue teniendo su vuelta
        // atrás en el fichero.
        if (args.respaldo) anotarRespaldo(args.respaldo, series);
        await pool
          .request()
          .input('id', sql.Int, series.Id)
          .input('posterUrl', sql.NVarChar(500), outcome.url)
          .query('UPDATE dbo.Series SET PosterUrl = @posterUrl WHERE Id = @id');
      }

      actualizadas += 1;
      console.log(
        `[${series.ContentType}] #${series.Id} ${series.Title} (${series.ReleaseYear || 's/f'}) → ` +
        `${outcome.match.title}${outcome.match.year ? ` (${outcome.match.year})` : ''} · ${outcome.origen}`
      );
      console.log(`      antes: ${series.PosterUrl || '(sin portada)'}`);
      console.log(`      ahora: ${outcome.url}  [${kb(outcome.bytes)}]`);
    }

    console.log(
      `\nResumen: ${actualizadas} ${args.apply ? 'actualizada(s)' : 'lista(s) para actualizar'}, ` +
      `${validadas} ya correcta(s), ${fallidas.length} omitida(s).`
    );

    if (fallidas.length) {
      console.log('\nSin portada nueva (conservan la que ya tenían):');
      for (const { series, reason } of fallidas) {
        console.log(`  #${series.Id} ${series.Title} — ${reason}`);
      }
    }

    if (dudosas.length) {
      console.log(`\n⚠ ${dudosas.length} ficha(s) omitida(s) por desfase de año. Puede ser un año mal`);
      console.log('  puesto en la base, o una ficha distinta con el mismo nombre — el caso típico es');
      console.log('  una temporada de una franquicia, cuya carátula no es la de la serie original.');
      for (const { series, match, url } of dudosas) {
        console.log(`  #${series.Id} ${series.Title} (${series.ReleaseYear}) → ${match.title} (${match.year})`);
        if (match.url) console.log(`      ficha:   ${match.url}`);
        console.log(`      portada: ${url}`);
      }
      console.log('\n  Si el año de la base está mal, corrígelo y repite con --ids=<id>.');
      console.log('  Si la ficha es la correcta, repite con --con-desfase-de-año.');
    }

    if (!args.apply) console.log('\n(simulación: no se escribió nada. Repite con --apply)');
  } finally {
    await pool.close();
  }
}

main().catch((error) => {
  console.error('❌ Error actualizando portadas:', error.message || String(error));
  process.exit(1);
});
