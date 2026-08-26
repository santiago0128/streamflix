'use strict';

/**
 * Estado editorial de un anime, en una sola definición.
 *
 * Hay dos consumidores —las tarjetas del catálogo (SQL, incrustado en las
 * consultas) y el calendario (JS, sobre filas ya leídas)— y antes cada uno
 * tenía su propia versión de las reglas. Discrepaban justo en el caso que más
 * duele: el calendario daba por "en emisión" cualquier fila viva del vigilante,
 * así que una serie terminada que el vigilante seguía sondeando aparecía
 * emitiendo para siempre. Las dos salidas se derivan ahora de `ESTADOS`.
 *
 * `Activo` NO significa "está en emisión": significa "el vigilante todavía la
 * mira". Una serie cuya temporada acabó sin que el vigilante se enterara sigue
 * activa. Por eso el estado sale de `Estado`, y `Activo` sólo puede rebajarlo.
 */

// AniList: RELEASING, FINISHED, NOT_YET_RELEASED, CANCELLED, HIATUS.
// JK_ONLY es nuestro: AniList no la reconoce y alguien la registró a mano
// contra JK Anime, así que la afirmación viene de una persona, no del código.
const ESTADOS = {
  RELEASING: 'airing',
  JK_ONLY: 'airing',
  NOT_YET_RELEASED: 'upcoming',
  FINISHED: 'finished',
  CANCELLED: 'finished',
  CANCELED: 'finished',
  // En pausa no es en emisión, pero tampoco terminada: no hay fecha que dar.
  HIATUS: 'unknown'
};

/**
 * @param {string|null} estado  valor de AnimeEmision.Estado
 * @param {boolean} activo     AnimeEmision.Activo
 * @returns {'airing'|'finished'|'upcoming'|'unknown'}
 */
function releaseStatusFromTracker(estado, activo) {
  const clave = String(estado || '').trim().toUpperCase();
  const mapeado = ESTADOS[clave];

  // Terminada es terminada aunque el vigilante siga apuntada la fila.
  if (mapeado === 'finished') return 'finished';
  // Que aún no haya salido no depende de que la vigilemos.
  if (mapeado === 'upcoming') return 'upcoming';

  // A partir de aquí hace falta que el vigilante la tenga viva: una fila
  // apagada es una que dejamos de seguir, y no vamos a prometer capítulos.
  if (!activo) return 'finished';

  // Sin estado reconocido no se inventa: "por confirmar" es la respuesta
  // honesta, y es exactamente la que faltaba antes.
  return mapeado || 'unknown';
}

function sqlCase(estadoExpr, activoExpr) {
  const rama = (valores, salida) =>
    `WHEN UPPER(LTRIM(RTRIM(${estadoExpr}))) IN (${valores.map((v) => `'${v}'`).join(', ')}) THEN '${salida}'`;

  return `
        CASE
          ${rama(['FINISHED', 'CANCELLED', 'CANCELED'], 'finished')}
          ${rama(['NOT_YET_RELEASED'], 'upcoming')}
          WHEN ${activoExpr} = 0 THEN 'finished'
          ${rama(['RELEASING', 'JK_ONLY'], 'airing')}
          ELSE 'unknown'
        END`;
}

/**
 * Expresión SQL con el estado del anime, para incrustar en las consultas del
 * catálogo. Para fichas que nunca se registraron en AnimeEmision se cae al año:
 * las del año en curso quedan "unknown" en vez de afirmar que terminaron.
 */
function releaseStatusSql(seriesAlias = 's') {
  return `
    CASE
      WHEN ${seriesAlias}.ContentType <> 'anime' THEN NULL
      ELSE COALESCE(
        (
          SELECT TOP 1 ${sqlCase('ae.Estado', 'ae.Activo')}
          FROM dbo.AnimeEmision ae
          WHERE ae.SeriesId = ${seriesAlias}.Id
          ORDER BY ae.Activo DESC, ae.UltimaRevision DESC, ae.Id DESC
        ),
        CASE
          WHEN ${seriesAlias}.ReleaseYear > YEAR(SYSUTCDATETIME()) THEN 'upcoming'
          WHEN ${seriesAlias}.ReleaseYear = YEAR(SYSUTCDATETIME()) THEN 'unknown'
          WHEN ${seriesAlias}.ReleaseYear IS NULL THEN 'unknown'
          ELSE 'finished'
        END
      )
    END`;
}

module.exports = { releaseStatusSql, releaseStatusFromTracker };
