'use strict';

/**
 * Estado editorial de un anime para incrustarlo en las consultas del catálogo.
 *
 * AnimeEmision es la fuente más fiable porque el vigilante la refresca contra
 * AniList. Para fichas antiguas que nunca se registraron allí se usa el año:
 * las del año actual quedan "unknown" en vez de afirmar que terminaron.
 */
function releaseStatusSql(seriesAlias = 's') {
  return `
    CASE
      WHEN ${seriesAlias}.ContentType <> 'anime' THEN NULL
      ELSE COALESCE(
        (
          SELECT TOP 1
            CASE
              WHEN ae.Estado = 'FINISHED' OR ae.Activo = 0 THEN 'finished'
              WHEN ae.Estado = 'NOT_YET_RELEASED' THEN 'upcoming'
              WHEN ae.Estado IN ('RELEASING', 'JK_ONLY') AND ae.Activo = 1 THEN 'airing'
              WHEN ae.Activo = 1 THEN 'unknown'
              ELSE 'finished'
            END
          FROM dbo.AnimeEmision ae
          WHERE ae.SeriesId = ${seriesAlias}.Id
          ORDER BY ae.Activo DESC, ae.UltimaRevision DESC, ae.Id DESC
        ),
        CASE
          WHEN ${seriesAlias}.ReleaseYear > YEAR(SYSUTCDATETIME()) THEN 'upcoming'
          WHEN ${seriesAlias}.ReleaseYear = YEAR(SYSUTCDATETIME()) THEN 'unknown'
          ELSE 'finished'
        END
      )
    END`;
}

module.exports = { releaseStatusSql };
