/**
 * =====================================================================
 *  StreamFlix — Verificación de contenido
 *
 *  Comprueba que lo que hay en la base es de verdad la serie que se quiso
 *  traer, y no relleno. Contrasta contra el catálogo de origen (Kitsu) y
 *  contra los archivos de video reales.
 *
 *  Uso:
 *    npm run db:verify              -> verifica todas las series
 *    npm run db:verify -- 6         -> sólo la serie con Id 6
 *    npm run db:verify -- --quick   -> no sondea duraciones (más rápido)
 *
 *  Sale con código 1 si encuentra algún error, para poder usarlo en CI.
 * =====================================================================
 */
require('dotenv').config();
const https = require('https');
const { sql, getPool } = require('../db');

const KITSU = 'https://kitsu.io/api/edge';
// Cuánto puede desviarse la duración real del video respecto a la esperada
// antes de considerar que no es el episodio correcto.
const DURATION_TOLERANCE = 0.2; // 20 %

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const OK = `${C.green}✅${C.reset}`;
const WARN = `${C.yellow}⚠️ ${C.reset}`;
const BAD = `${C.red}❌${C.reset}`;

// ---------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------
function request(url, { method = 'GET', headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('demasiadas redirecciones'));
    const req = https.request(
      url,
      { method, headers: { 'User-Agent': 'StreamFlix/0.1', ...headers } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(request(new URL(res.headers.location, url).toString(),
            { method, headers, redirects: redirects + 1 }));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** Reintenta: archive.org devuelve 500 esporádicos cuando un nodo está ocupado. */
async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fn();
      if (r && r.status && r.status >= 500) { last = new Error(`HTTP ${r.status}`); continue; }
      return r;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw last || new Error('falló tras varios intentos');
}

function getJson(url) {
  return withRetry(() => request(url, { headers: { Accept: 'application/vnd.api+json' } }))
    .then((r) => {
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return JSON.parse(r.buf.toString('utf8'));
    });
}

// ---------------------------------------------------------------------
// Sondeo de video
// ---------------------------------------------------------------------

/** Los videos propios se guardan como rutas relativas tipo /media/ep01.mp4 */
function isLocal(url) {
  return typeof url === 'string' && url.startsWith('/');
}

function localPath(url) {
  const path = require('path');
  const rel = decodeURIComponent(url.replace(/^\/media\//, ''));
  return path.join(__dirname, '..', '..', 'media', rel);
}

/** Devuelve un lector de bytes por rango, sea el video remoto o un archivo local. */
function makeReader(url) {
  if (isLocal(url)) {
    const fs = require('fs');
    const file = localPath(url);
    return async (start, end) => {
      const fd = fs.openSync(file, 'r');
      try {
        const len = end - start + 1;
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, start);
        return buf.subarray(0, read);
      } finally { fs.closeSync(fd); }
    };
  }
  return async (start, end) => {
    const r = await withRetry(() => request(url, { headers: { Range: `bytes=${start}-${end}` } }));
    return r.buf;
  };
}

/**
 * Duración de una playlist HLS: suma los #EXTINF de los segmentos. Si es una
 * master playlist, baja primero a la primera variante.
 */
async function hlsDuration(url, depth = 0) {
  if (depth > 2) return null;
  let text;
  if (isLocal(url)) {
    const fs = require('fs');
    text = fs.readFileSync(localPath(url), 'utf8');
  } else {
    const r = await withRetry(() => request(url));
    if (r.status !== 200) return null;
    text = r.buf.toString('utf8');
  }
  const lines = text.split(/\r?\n/);

  // Master playlist: seguir la primera variante
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const i = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
    const variant = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
    if (!variant) return null;
    const next = isLocal(url)
      ? `${url.replace(/[^/]+$/, '')}${variant.trim()}`
      : new URL(variant.trim(), url).toString();
    return hlsDuration(next, depth + 1);
  }

  let total = 0, found = false;
  for (const l of lines) {
    const m = l.match(/^#EXTINF:\s*([\d.]+)/);
    if (m) { total += parseFloat(m[1]); found = true; }
  }
  return found ? total : null;
}

/** Lee la duración real de un MP4 recorriendo sus atoms. */
async function mp4Duration(url) {
  const readBytes = makeReader(url);
  let offset = 0;
  for (let i = 0; i < 12; i++) {
    const head = await readBytes(offset, offset + 15);
    if (!head || head.length < 8) return null;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    if (size === 1) size = Number(head.readBigUInt64BE(8));

    if (type === 'moov') {
      const mv = await readBytes(offset, offset + Math.min(size, 300000) - 1);
      const idx = mv.indexOf('mvhd', 0, 'latin1');
      if (idx < 0) return null;
      const version = mv[idx + 4];
      const timescale = version === 1 ? mv.readUInt32BE(idx + 24) : mv.readUInt32BE(idx + 16);
      const duration = version === 1
        ? Number(mv.readBigUInt64BE(idx + 28))
        : mv.readUInt32BE(idx + 20);
      return timescale ? duration / timescale : null;
    }
    if (!size || size < 8) return null;
    offset += size;
  }
  return null;
}

const probeCache = new Map();

/** Comprueba alcanzabilidad, soporte de rangos y duración real de un video. */
async function probeVideo(url, provider, quick) {
  const key = `${provider}|${url}`;
  if (probeCache.has(key)) return probeCache.get(key);
  const out = {
    url, provider, reachable: false, acceptsRanges: false,
    contentType: null, seconds: null, measurable: provider !== 'embed', error: null,
  };
  try {
    if (provider === 'embed') {
      // Un embed es una página de terceros: se comprueba que responda, pero su
      // duración no es medible desde aquí.
      const r = await withRetry(() => request(url));
      out.reachable = r.status === 200;
      out.acceptsRanges = true; // lo gestiona el reproductor incrustado
      out.contentType = r.headers['content-type'] || null;
      if (!out.reachable) out.error = `HTTP ${r.status}`;
    } else if (isLocal(url)) {
      // Archivo propio: se comprueba en disco, sin depender de que el servidor esté arriba.
      const fs = require('fs');
      const file = localPath(url);
      out.reachable = fs.existsSync(file) && fs.statSync(file).size > 0;
      out.acceptsRanges = out.reachable; // express.static responde 206
      if (!out.reachable) out.error = `no existe ${file}`;
      else if (!quick) out.seconds = provider === 'hls' ? await hlsDuration(url) : await mp4Duration(url);
    } else if (provider === 'hls') {
      const r = await withRetry(() => request(url));
      out.reachable = r.status === 200;
      out.acceptsRanges = true; // HLS se sirve por segmentos, no por rangos
      out.contentType = r.headers['content-type'] || null;
      if (!out.reachable) out.error = `HTTP ${r.status}`;
      else if (!quick) out.seconds = await hlsDuration(url);
    } else {
      const r = await withRetry(() => request(url, { headers: { Range: 'bytes=0-1000' } }));
      out.reachable = r.status === 200 || r.status === 206;
      out.acceptsRanges = r.status === 206;
      out.contentType = r.headers['content-type'] || null;
      if (!out.reachable) out.error = `HTTP ${r.status}`;
      else if (!quick) out.seconds = await mp4Duration(url);
    }
  } catch (e) {
    out.error = e.message;
  }
  probeCache.set(key, out);
  return out;
}

const imgCache = new Map();
async function probeImage(url) {
  if (!url) return { ok: false, error: 'sin URL' };
  if (imgCache.has(url)) return imgCache.get(url);
  let out;
  try {
    const r = await withRetry(() => request(url, { headers: { Range: 'bytes=0-200' } }));
    out = { ok: r.status === 200 || r.status === 206, error: null };
    if (!out.ok) out.error = `HTTP ${r.status}`;
  } catch (e) { out = { ok: false, error: e.message }; }
  imgCache.set(url, out);
  return out;
}

// ---------------------------------------------------------------------
// Verificación
// ---------------------------------------------------------------------
function fmt(sec) {
  if (sec == null) return '¿?';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

async function verifySeries(pool, series, quick) {
  const problems = [];
  const note = (level, msg) => problems.push({ level, msg });

  console.log(`\n${C.bold}━━ ${series.Title} ${C.dim}(Id ${series.Id})${C.reset}`);

  const epsRes = await pool.request().input('id', sql.Int, series.Id)
    .query(`SELECT e.Id, e.EpisodeNumber, e.Title, e.VideoUrl, e.Provider, e.DurationSec,
                   e.ThumbnailUrl, e.IntroEndSec, e.OutroStartSec
              FROM dbo.Episodes e JOIN dbo.Seasons s ON s.Id = e.SeasonId
             WHERE s.SeriesId = @id ORDER BY e.EpisodeNumber`);
  const eps = epsRes.recordset;

  // ---- 1. Identidad contra el catálogo de origen -------------------
  let expectedEpSeconds = null;
  console.log(`  ${C.cyan}Identidad${C.reset}`);
  if (!series.SourceRef) {
    console.log(`    ${WARN} sin SourceRef: no se puede contrastar con un catálogo`);
    note('warn', 'sin SourceRef; la identidad no es verificable');
  } else {
    const [source, id] = series.SourceRef.split(':');
    if (source !== 'kitsu') {
      console.log(`    ${WARN} origen '${source}' desconocido`);
      note('warn', `origen '${source}' no soportado`);
    } else {
      try {
        const at = (await getJson(`${KITSU}/anime/${id}`)).data.attributes;
        const srcTitle = at.titles.en || at.canonicalTitle;
        const srcYear = at.startDate ? Number(at.startDate.slice(0, 4)) : null;
        if (at.episodeLength) expectedEpSeconds = at.episodeLength * 60;

        const tOk = srcTitle === series.Title;
        console.log(`    ${tOk ? OK : BAD} título: "${series.Title}"${tOk ? '' : ` ≠ fuente "${srcTitle}"`}`);
        if (!tOk) note('error', `título no coincide con la fuente ("${srcTitle}")`);

        const yOk = srcYear === series.ReleaseYear;
        console.log(`    ${yOk ? OK : BAD} año: ${series.ReleaseYear}${yOk ? '' : ` ≠ fuente ${srcYear}`}`);
        if (!yOk) note('error', `año no coincide con la fuente (${srcYear})`);

        const cOk = at.episodeCount === eps.length;
        console.log(`    ${cOk ? OK : BAD} episodios: ${eps.length} en base / ${at.episodeCount} en la fuente`);
        if (!cOk) note('error', `faltan o sobran episodios (fuente: ${at.episodeCount})`);

        console.log(`    ${C.dim}duración esperada por episodio: ${expectedEpSeconds ? fmt(expectedEpSeconds) : '¿?'}${C.reset}`);
      } catch (e) {
        console.log(`    ${WARN} no se pudo consultar la fuente: ${e.message}`);
        note('warn', `fuente inaccesible: ${e.message}`);
      }
    }
  }

  // ---- 2. Integridad de la numeración ------------------------------
  console.log(`  ${C.cyan}Episodios${C.reset}`);
  if (!eps.length) {
    console.log(`    ${BAD} la serie no tiene episodios`);
    note('error', 'sin episodios');
  } else {
    const nums = eps.map((e) => e.EpisodeNumber);
    const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
    const gaps = [];
    for (let n = 1; n <= Math.max(...nums); n++) if (!nums.includes(n)) gaps.push(n);
    const seqOk = !dup.length && !gaps.length && Math.min(...nums) === 1;
    console.log(`    ${seqOk ? OK : BAD} numeración 1..${Math.max(...nums)}` +
      (gaps.length ? ` — huecos: ${gaps.slice(0, 10).join(', ')}` : '') +
      (dup.length ? ` — duplicados: ${[...new Set(dup)].join(', ')}` : ''));
    if (!seqOk) note('error', 'numeración de episodios incompleta o duplicada');
  }

  // ---- 3. Videos ----------------------------------------------------
  console.log(`  ${C.cyan}Video${C.reset}`);
  const provOf = (e) => String(e.Provider || 'file').toLowerCase();
  const keyOf = (e) => `${provOf(e)}|${e.VideoUrl}`;
  const uniqueUrls = [...new Set(eps.map((e) => e.VideoUrl))];
  const providersUsed = [...new Set(eps.map(provOf))];
  console.log(`    ${C.dim}${eps.length} episodios · ${uniqueUrls.length} archivo(s) distinto(s) · proveedor: ${providersUsed.join(', ')}${C.reset}`);

  // Reutilización de archivos: señal fuerte de relleno
  if (eps.length > 1 && uniqueUrls.length < eps.length) {
    const reused = eps.length - uniqueUrls.length;
    console.log(`    ${BAD} ${reused} episodio(s) reutilizan el video de otro — no puede ser contenido real`);
    note('error', `${reused} episodios comparten archivo de video con otro episodio`);
  } else if (uniqueUrls.length === eps.length) {
    console.log(`    ${OK} cada episodio tiene su propio archivo`);
  }

  let unreachable = 0, noRanges = 0, mismatchDeclared = 0, mismatchExpected = 0, unmeasured = 0;
  const seenDurations = new Set();

  const seen = new Set();
  for (const e of eps) {
    if (seen.has(keyOf(e))) continue;
    seen.add(keyOf(e));
    const p = await probeVideo(e.VideoUrl, provOf(e), quick);
    if (!p.reachable) { unreachable++; continue; }
    if (!p.acceptsRanges) noRanges++;
    if (p.seconds != null) seenDurations.add(Math.round(p.seconds));
  }

  let embedCount = 0;
  for (const e of eps) {
    const p = probeCache.get(keyOf(e));
    // Un embed no es medible desde aquí; se cuenta aparte, no como fallo.
    if (p && p.reachable && !p.measurable) { embedCount++; continue; }
    // No se pudo medir: NO se puede afirmar que esté bien.
    if (!p || !p.reachable || p.seconds == null) { unmeasured++; continue; }
    // ¿La duración declarada coincide con el archivo? (si no, el reproductor se rompe)
    if (Math.abs(p.seconds - e.DurationSec) > 2) mismatchDeclared++;
    // ¿El archivo dura lo que debería durar un episodio de esta serie?
    if (expectedEpSeconds) {
      const diff = Math.abs(p.seconds - expectedEpSeconds) / expectedEpSeconds;
      if (diff > DURATION_TOLERANCE) mismatchExpected++;
    }
  }

  if (unreachable) {
    console.log(`    ${BAD} ${unreachable} archivo(s) no alcanzables`);
    note('error', `${unreachable} videos no se pueden descargar`);
  } else {
    console.log(`    ${OK} todos los archivos responden`);
  }
  if (noRanges) {
    console.log(`    ${WARN} ${noRanges} archivo(s) sin soporte de rangos (el seek no funcionará)`);
    note('warn', `${noRanges} videos no aceptan range requests`);
  }
  if (mismatchDeclared) {
    console.log(`    ${BAD} ${mismatchDeclared} episodio(s) con DurationSec distinto al archivo real`);
    note('error', `${mismatchDeclared} episodios tienen DurationSec incorrecto`);
  }
  if (!quick) {
    const list = [...seenDurations].sort((a, b) => a - b).map(fmt).join(', ');
    if (embedCount) {
      // No es un fallo, pero tampoco una comprobación: hay que decirlo.
      console.log(`    ${WARN} ${embedCount} episodio(s) usan reproductor incrustado: el contenido no es verificable desde aquí`);
      note('warn', `${embedCount} episodios con provider 'embed' sin verificar`);
    }
    if (unmeasured) {
      // Nunca dar por buena una duración que no se pudo medir.
      console.log(`    ${BAD} ${unmeasured}/${eps.length} episodio(s) sin medir: no se puede confirmar el contenido`);
      note('error', `${unmeasured} episodios cuya duración no se pudo comprobar`);
    }
    if (!expectedEpSeconds) {
      console.log(`    ${WARN} sin duración de referencia: no se puede contrastar el contenido`);
      note('warn', 'la fuente no indica duración por episodio');
    } else if (mismatchExpected) {
      console.log(`    ${BAD} ${mismatchExpected}/${eps.length} episodio(s) NO duran lo que un episodio de esta serie`);
      console.log(`       ${C.dim}esperado ~${fmt(expectedEpSeconds)} · encontrado: ${list}${C.reset}`);
      note('error', `${mismatchExpected} episodios con video que no corresponde a la serie`);
    } else {
      const medidos = eps.length - unmeasured - embedCount;
      if (medidos > 0) {
        console.log(`    ${OK} ${medidos}/${eps.length} episodio(s) medidos duran lo esperado (~${fmt(expectedEpSeconds)})`);
      }
    }
  }

  // ---- 4. Imágenes ---------------------------------------------------
  console.log(`  ${C.cyan}Imágenes${C.reset}`);
  const poster = await probeImage(series.PosterUrl);
  console.log(`    ${poster.ok ? OK : BAD} portada${poster.ok ? '' : ` — ${poster.error}`}`);
  if (!poster.ok) note('error', `portada inaccesible: ${poster.error}`);

  const backdrop = await probeImage(series.BackdropUrl);
  console.log(`    ${backdrop.ok ? OK : WARN} banner${backdrop.ok ? '' : ` — ${backdrop.error}`}`);
  if (!backdrop.ok) note('warn', `banner inaccesible: ${backdrop.error}`);

  // Muestra de miniaturas (hasta 8) para no disparar cientos de peticiones
  const sample = eps.filter((e) => e.ThumbnailUrl)
    .filter((_, i, a) => i % Math.max(1, Math.ceil(a.length / 8)) === 0).slice(0, 8);
  let badThumbs = 0;
  for (const e of sample) if (!(await probeImage(e.ThumbnailUrl)).ok) badThumbs++;
  console.log(`    ${badThumbs ? BAD : OK} miniaturas: ${sample.length - badThumbs}/${sample.length} de la muestra OK`);
  if (badThumbs) note('error', `${badThumbs} miniaturas rotas en la muestra`);

  return problems;
}

// ---------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const quick = args.includes('--quick');
  const onlyId = args.filter((a) => !a.startsWith('--'))[0];

  const pool = await getPool();
  const res = onlyId
    ? await pool.request().input('id', sql.Int, Number(onlyId))
        .query('SELECT * FROM dbo.Series WHERE Id = @id')
    : await pool.request().query('SELECT * FROM dbo.Series ORDER BY Id');

  if (!res.recordset.length) {
    console.log('No hay series que verificar.');
    return 0;
  }

  console.log(`${C.bold}Verificando ${res.recordset.length} serie(s)${quick ? ' (modo rápido)' : ''}…${C.reset}`);

  let errors = 0, warns = 0;
  for (const s of res.recordset) {
    const problems = await verifySeries(pool, s, quick);
    errors += problems.filter((p) => p.level === 'error').length;
    warns += problems.filter((p) => p.level === 'warn').length;
  }

  console.log(`\n${C.bold}━━ Resumen ━━${C.reset}`);
  console.log(`  ${errors ? BAD : OK} ${errors} error(es), ${warns} advertencia(s)`);
  if (errors) {
    console.log(`\n  ${C.dim}Un error de "duraciones que no corresponden" significa que el video`);
    console.log(`  guardado no es el episodio real de la serie, aunque los metadatos sí lo sean.${C.reset}`);
  }
  return errors ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error('❌ Error verificando:', err.message); process.exit(1); });
