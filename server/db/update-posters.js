#!/usr/bin/env node

/**
 * Reemplaza las portadas de las películas por las de TMDB.
 *
 * Las portadas del catálogo venían de las páginas de origen (cuevana3,
 * pelisplushd): miniaturas de 10-18 KB que se ven borrosas en la ficha grande,
 * y alojadas en dominios que cambian de número cada pocos meses — el día que
 * ww9 pase a ww10, todas las portadas se caen a la vez.
 *
 * TMDB sirve la misma portada a 500 px (~80 KB) desde image.tmdb.org, que es un
 * CDN estable y el mismo origen que ya usaba alguna ficha suelta del catálogo.
 * Se guarda la URL, no la imagen: no se descarga ni se re-aloja nada.
 *
 *   node server/db/update-movie-posters.js                 # simulación
 *   node server/db/update-movie-posters.js --apply         # escribe la base
 *   node server/db/update-movie-posters.js --ids=4,6,11    # solo esas fichas
 *   node server/db/update-movie-posters.js --force         # también las ya migradas
 *   node server/db/update-movie-posters.js --type=series   # otro tipo de contenido
 *
 * Es idempotente: sin --force salta lo que ya apunta a TMDB, así que se puede
 * repetir sin volver a pedir nada.
 */

require('dotenv').config();
const https = require('https');
const { sql, getPool } = require('../db');
const { TMDB_BASE_URL, findTmdbMatch, requestText } = require('./tmdb');

// 500 px de ancho: la ficha de detalle es la que más la agranda y ahí ya se ve
// nítida, sin irse a los 200 KB de w780 en una parrilla de decenas de portadas.
const POSTER_CDN = 'https://image.tmdb.org/t/p/w500';
const POSTER_HOSTS = /^(image|media)\.tmdb\.org$/;

function parseArgs(argv) {
  const args = { apply: false, force: false, ids: null, type: 'movie' };

  for (const token of argv) {
    if (token === '--apply') args.apply = true;
    else if (token === '--force') args.force = true;
    else if (token.startsWith('--type=')) args.type = token.slice('--type='.length).trim();
    else if (token.startsWith('--ids=')) {
      args.ids = token
        .slice('--ids='.length)
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value > 0);
    }
  }

  return args;
}

function isTmdbPoster(url) {
  try {
    return POSTER_HOSTS.test(new URL(String(url)).hostname);
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
function checkImage(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', timeout: 15000 }, (res) => {
      res.resume();
      const type = String(res.headers['content-type'] || '');
      resolve({
        ok: res.statusCode === 200 && type.startsWith('image/'),
        status: res.statusCode,
        bytes: Number(res.headers['content-length']) || 0
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, bytes: 0 }); });
    req.on('error', () => resolve({ ok: false, status: 0, bytes: 0 }));
    req.end();
  });
}

async function resolvePoster(series) {
  let match;
  try {
    match = await findTmdbMatch(series);
  } catch (error) {
    return { ok: false, reason: `TMDB no respondió a la búsqueda: ${error.message || error}` };
  }
  if (!match) return { ok: false, reason: 'sin ficha en TMDB que case con el título y el año' };

  let detailHtml;
  try {
    detailHtml = await requestText(`${TMDB_BASE_URL}${match.path}`);
  } catch (error) {
    return { ok: false, reason: `no se pudo leer la ficha: ${error.message || error}` };
  }

  const file = extractPosterFile(detailHtml);
  if (!file) return { ok: false, reason: 'la ficha de TMDB no tiene portada' };

  const url = `${POSTER_CDN}${file}`;
  const image = await checkImage(url);
  if (!image.ok) return { ok: false, reason: `la portada no responde (HTTP ${image.status || 'sin respuesta'})` };

  // Un año que no cuadra no basta para descartar la ficha —hay estrenos que la
  // base fecha por el año de importación— pero sí para no darla por buena en
  // silencio: se marca y se repite al final para que alguien la mire.
  const dudosa = Boolean(series.ReleaseYear && match.year && Math.abs(series.ReleaseYear - match.year) > 1);

  return { ok: true, url, bytes: image.bytes, match, dudosa };
}

const kb = (bytes) => (bytes ? `${Math.round(bytes / 1024)} KB` : '?');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pool = await getPool();

  try {
    const request = pool.request().input('type', sql.NVarChar(20), args.type);
    const idsFilter = args.ids?.length ? `AND Id IN (${args.ids.join(',')})` : '';
    const result = await request.query(`
      SELECT Id, Title, ContentType, ReleaseYear, PosterUrl
      FROM dbo.Series
      WHERE ContentType = @type ${idsFilter}
      ORDER BY Id
    `);

    const rows = result.recordset.filter((series) => args.force || !isTmdbPoster(series.PosterUrl));
    const yaMigradas = result.recordset.length - rows.length;

    if (!rows.length) {
      console.log(`No hay portadas pendientes (${result.recordset.length} ficha(s) de tipo '${args.type}', todas ya en TMDB).`);
      return;
    }

    console.log(
      `${rows.length} portada(s) a resolver de tipo '${args.type}'` +
      `${yaMigradas ? ` (${yaMigradas} ya estaban en TMDB, se saltan)` : ''}\n`
    );

    const fallidas = [];
    const dudosas = [];
    let actualizadas = 0;

    for (const series of rows) {
      const outcome = await resolvePoster(series);

      if (!outcome.ok) {
        fallidas.push({ series, reason: outcome.reason });
        console.log(`#${series.Id} ${series.Title} — omitida: ${outcome.reason}`);
        continue;
      }

      if (outcome.dudosa) dudosas.push({ series, match: outcome.match });

      if (args.apply) {
        await pool
          .request()
          .input('id', sql.Int, series.Id)
          .input('posterUrl', sql.NVarChar(500), outcome.url)
          .query('UPDATE dbo.Series SET PosterUrl = @posterUrl WHERE Id = @id');
      }

      actualizadas += 1;
      console.log(
        `${outcome.dudosa ? '⚠ ' : ''}#${series.Id} ${series.Title} (${series.ReleaseYear || 's/f'}) → ` +
        `${outcome.match.title}${outcome.match.year ? ` (${outcome.match.year})` : ''}`
      );
      console.log(`      antes: ${series.PosterUrl || '(sin portada)'}`);
      console.log(`      ahora: ${outcome.url}  [${kb(outcome.bytes)}]`);
    }

    console.log(`\nResumen: ${actualizadas} ${args.apply ? 'actualizada(s)' : 'lista(s) para actualizar'}, ${fallidas.length} omitida(s).`);

    if (fallidas.length) {
      console.log('\nSin portada nueva (conservan la que ya tenían):');
      for (const { series, reason } of fallidas) {
        console.log(`  #${series.Id} ${series.Title} — ${reason}`);
      }
    }

    if (dudosas.length) {
      console.log(`\n⚠ ${dudosas.length} ficha(s) con el año descuadrado. Puede ser un año mal puesto en`);
      console.log('  la base o una película distinta con el mismo título: conviene mirarlas.');
      for (const { series, match } of dudosas) {
        console.log(`  #${series.Id} ${series.Title} (${series.ReleaseYear}) → ${match.title} (${match.year})`);
        console.log(`      ficha: ${TMDB_BASE_URL}${match.path}`);
      }
      console.log('  Para corregir una: --ids=<id> tras arreglar el año, o edita PosterUrl a mano.');
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
