#!/usr/bin/env node

/**
 * Rellena dbo.Seasons.SourceRef en las franquicias de anime ya importadas.
 *
 * En jkanime cada temporada de una franquicia es una ficha aparte, con su
 * propio slug y su numeración empezando otra vez en 1. Pero el slug se guardaba
 * una sola vez, en Series.SourceRef, así que no había forma de saber de qué
 * ficha salía cada temporada y todas resolvían contra la primera.
 *
 * La columna nueva lo arregla de cara al futuro: el importador la escribe. Este
 * script cubre lo que ya está en la base, y evita tener que reimportar catálogos
 * enteros solo para rellenar un campo.
 *
 * El emparejamiento no es una adivinanza: el importador escribe el mismo valor
 * en Episodes.Title y en JkAnimeEpisodeSnapshots.EpisodeTitle, así que se une
 * por título y número y se toma el slug que explique más episodios de la
 * temporada. Si no hay coincidencias, se deja en nulo y se avisa: eso es una
 * temporada cuyos snapshots no están en la base, y esa sí hay que reimportarla.
 *
 *   node server/db/backfill-season-sourceref.js [--dry-run]
 */

require('dotenv').config();
const { sql, getPool } = require('../db');

const dryRun = process.argv.includes('--dry-run');

// OUTER APPLY y no CROSS APPLY: interesa listar también las temporadas sin
// ninguna coincidencia, que son las que hay que reimportar.
const CONSULTA = `
  SELECT
    se.Id                AS SeasonId,
    sr.Title             AS SeriesTitle,
    se.SeasonNumber,
    se.Title             AS SeasonTitle,
    se.SourceRef         AS SourceRefActual,
    x.SeriesSlug,
    x.Coincidencias,
    (SELECT COUNT(*) FROM dbo.Episodes e2 WHERE e2.SeasonId = se.Id) AS TotalEpisodios
  FROM dbo.Seasons se
  JOIN dbo.Series sr ON sr.Id = se.SeriesId
  OUTER APPLY (
    SELECT TOP 1
      s.SeriesSlug,
      COUNT(*) AS Coincidencias
    FROM dbo.Episodes e
    JOIN dbo.JkAnimeEpisodeSnapshots s
      ON s.EpisodeTitle  = e.Title
     AND s.EpisodeNumber = e.EpisodeNumber
    WHERE e.SeasonId = se.Id
      AND s.SeriesSlug IS NOT NULL
    GROUP BY s.SeriesSlug
    ORDER BY COUNT(*) DESC
  ) x
  WHERE sr.SourceRef LIKE 'jkanime:%'
  ORDER BY sr.Title, se.SeasonNumber
`;

async function run() {
  const pool = await getPool();

  // La columna la crea schema.sql, pero este script puede correrse contra una
  // base a la que todavía no se le aplicó: mejor que no reviente por eso.
  await pool.request().batch(`
    IF COL_LENGTH('dbo.Seasons', 'SourceRef') IS NULL
        ALTER TABLE dbo.Seasons ADD SourceRef NVARCHAR(100) NULL;
  `);

  const { recordset: temporadas } = await pool.request().query(CONSULTA);

  if (!temporadas.length) {
    console.log('No hay temporadas de anime importadas desde jkanime.');
    return;
  }

  const porRellenar = [];
  const yaPuestas = [];
  const sinCoincidencia = [];
  const discrepantes = [];

  for (const t of temporadas) {
    const propuesto = t.SeriesSlug ? `jkanime:${t.SeriesSlug}` : null;
    if (!propuesto) sinCoincidencia.push(t);
    else if (!t.SourceRefActual) porRellenar.push({ ...t, propuesto });
    else if (t.SourceRefActual !== propuesto) discrepantes.push({ ...t, propuesto });
    else yaPuestas.push(t);
  }

  const etiqueta = (t) =>
    `${t.SeriesTitle} · T${t.SeasonNumber} ${t.SeasonTitle ? `(${t.SeasonTitle})` : ''}`.trim();

  if (porRellenar.length) {
    console.log(`\n${dryRun ? 'Se rellenarían' : 'Rellenando'} ${porRellenar.length} temporada(s):\n`);
    for (const t of porRellenar) {
      console.log(`  ${etiqueta(t)}`);
      console.log(`      -> ${t.propuesto}   (${t.Coincidencias}/${t.TotalEpisodios} episodios casan)`);
    }
  }

  if (!dryRun) {
    for (const t of porRellenar) {
      await pool.request()
        .input('id', sql.Int, t.SeasonId)
        .input('sourceRef', sql.NVarChar(100), t.propuesto)
        .query('UPDATE dbo.Seasons SET SourceRef = @sourceRef WHERE Id = @id');
    }
  }

  if (discrepantes.length) {
    console.log(`\n⚠️  ${discrepantes.length} temporada(s) ya tienen SourceRef y no coincide con lo deducido.`);
    console.log('   No se tocan: revísalas a mano si alguna reproduce el capítulo equivocado.\n');
    for (const t of discrepantes) {
      console.log(`  ${etiqueta(t)}`);
      console.log(`      guardado: ${t.SourceRefActual}`);
      console.log(`      deducido: ${t.propuesto}   (${t.Coincidencias}/${t.TotalEpisodios} episodios casan)`);
    }
  }

  if (sinCoincidencia.length) {
    console.log(`\n⚠️  ${sinCoincidencia.length} temporada(s) sin ningún snapshot que case por título.`);
    console.log('   Sus capítulos no tienen origen guardado en esta base: hay que reimportarlas.\n');
    for (const t of sinCoincidencia) {
      console.log(`  ${etiqueta(t)}  (${t.TotalEpisodios} episodios)`);
    }
  }

  console.log(
    `\nResumen: ${porRellenar.length} ${dryRun ? 'por rellenar' : 'rellenadas'}, ` +
    `${yaPuestas.length} ya estaban, ${discrepantes.length} discrepantes, ` +
    `${sinCoincidencia.length} sin origen.`
  );
  if (dryRun) console.log('(--dry-run: no se escribió nada)');
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Error rellenando SourceRef de temporadas:', err.message);
    process.exit(1);
  });
