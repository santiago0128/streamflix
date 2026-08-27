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

// Dos vocabularios, porque son dos fuentes: AniList para el anime (RELEASING,
// FINISHED, NOT_YET_RELEASED, CANCELLED, HIATUS) y TMDB para las series
// convencionales ("Returning Series", "Ended", "Canceled", "In Production",
// "Planned", "Pilot"). Se normalizan a mayúsculas y se resuelven en la misma
// tabla para que ninguna vista tenga que saber de dónde vino el dato.
//
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
  HIATUS: 'unknown',

  // --- TMDB ---
  ENDED: 'finished',
  'IN PRODUCTION': 'upcoming',
  PLANNED: 'upcoming',
  PILOT: 'unknown',
  // "Returning Series" sólo dice que habrá más, no que se esté emitiendo hoy:
  // Devil May Cry está así y su último capítulo salió en mayo. Tratarlo como
  // "en emisión" repetiría el error que teníamos, sólo que con mejor dato, así
  // que quien decide es la fecha del siguiente capítulo (ver `conFecha`).
  'RETURNING SERIES': 'unknown'
};

/**
 * @param {string|null} estado  valor de AnimeEmision.Estado o SerieEmision.Estado
 * @param {boolean} activo     la columna Activo de esa misma fila
 * @param {boolean} conFecha   si hay un próximo capítulo con fecha anunciada
 * @returns {'airing'|'finished'|'upcoming'|'unknown'}
 */
function releaseStatusFromTracker(estado, activo, conFecha = false) {
  const clave = String(estado || '').trim().toUpperCase();
  const mapeado = ESTADOS[clave];

  // Una fecha de estreno confirmada es la prueba más fuerte de que algo está
  // emitiéndose, y manda sobre la etiqueta: "Returning Series" con capítulo
  // anunciado para el jueves está en emisión, sin él sólo está anunciada.
  // Nunca contradice a una terminada: si TMDB dice Ended, no hay tal fecha.
  if (conFecha && activo && mapeado !== 'finished' && mapeado !== 'upcoming') return 'airing';

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
