-- =====================================================================
--  StreamFlix — Esquema de base de datos (SQL Server)
--  Idempotente: se puede ejecutar varias veces sin error.
-- =====================================================================

-- Usuarios
IF OBJECT_ID('dbo.Users', 'U') IS NULL
CREATE TABLE dbo.Users (
    Id            INT IDENTITY(1,1) PRIMARY KEY,
    Username      NVARCHAR(50)  NOT NULL UNIQUE,
    Email         NVARCHAR(255) NOT NULL UNIQUE,
    PasswordHash  NVARCHAR(255) NOT NULL,
    CreatedAt     DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Géneros
IF OBJECT_ID('dbo.Genres', 'U') IS NULL
CREATE TABLE dbo.Genres (
    Id    INT IDENTITY(1,1) PRIMARY KEY,
    Name  NVARCHAR(50) NOT NULL UNIQUE
);

-- Series
IF OBJECT_ID('dbo.Series', 'U') IS NULL
CREATE TABLE dbo.Series (
    Id           INT IDENTITY(1,1) PRIMARY KEY,
    Title        NVARCHAR(200) NOT NULL,
    Description  NVARCHAR(MAX) NULL,
    PosterUrl    NVARCHAR(500) NULL,
    BackdropUrl  NVARCHAR(500) NULL,
    ReleaseYear  INT NULL,
    Rating       DECIMAL(3,1) NULL,
    CreatedAt    DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
);

-- Referencia al catálogo de origen (ej. 'kitsu:3936'), para poder verificar
-- después que lo guardado sigue correspondiendo a la serie que se quiso traer.
IF COL_LENGTH('dbo.Series', 'SourceRef') IS NULL
    ALTER TABLE dbo.Series ADD SourceRef NVARCHAR(100) NULL;

-- Tipo de contenido principal:
--   'anime'  = solo títulos importados desde páginas de anime (JKAnime)
--   'series' = serie convencional
--   'movie'  = película (se modela con una temporada/episodio técnico para
--              reutilizar el reproductor actual sin duplicar lógica)
IF COL_LENGTH('dbo.Series', 'ContentType') IS NULL
    ALTER TABLE dbo.Series ADD ContentType NVARCHAR(20) NOT NULL
        CONSTRAINT DF_Series_ContentType DEFAULT 'series' WITH VALUES;

-- Relación N:N Series <-> Géneros
IF OBJECT_ID('dbo.SeriesGenres', 'U') IS NULL
CREATE TABLE dbo.SeriesGenres (
    SeriesId INT NOT NULL,
    GenreId  INT NOT NULL,
    CONSTRAINT PK_SeriesGenres PRIMARY KEY (SeriesId, GenreId),
    CONSTRAINT FK_SeriesGenres_Series FOREIGN KEY (SeriesId) REFERENCES dbo.Series(Id) ON DELETE CASCADE,
    CONSTRAINT FK_SeriesGenres_Genres FOREIGN KEY (GenreId)  REFERENCES dbo.Genres(Id) ON DELETE CASCADE
);

-- Temporadas
IF OBJECT_ID('dbo.Seasons', 'U') IS NULL
CREATE TABLE dbo.Seasons (
    Id           INT IDENTITY(1,1) PRIMARY KEY,
    SeriesId     INT NOT NULL,
    SeasonNumber INT NOT NULL,
    Title        NVARCHAR(200) NULL,
    CONSTRAINT FK_Seasons_Series FOREIGN KEY (SeriesId) REFERENCES dbo.Series(Id) ON DELETE CASCADE,
    CONSTRAINT UQ_Seasons UNIQUE (SeriesId, SeasonNumber)
);

-- Referencia al catálogo de origen, por temporada (ej. 'jkanime:bleach-sennen-
-- kessen-hen-soukoku-tan'). En las franquicias de anime cada temporada es una
-- ficha distinta del sitio de origen, con su propio slug y su numeración
-- empezando otra vez en 1, así que el SourceRef de la serie no basta para saber
-- de dónde salió un capítulo: sin esto, el capítulo 2 de cualquier temporada de
-- Bleach se resolvía contra el capítulo 2 de la serie original.
-- Nulo para lo importado antes de que existiera la columna y para las series
-- convencionales, donde la temporada ya se distingue por SeasonNumber.
IF COL_LENGTH('dbo.Seasons', 'SourceRef') IS NULL
    ALTER TABLE dbo.Seasons ADD SourceRef NVARCHAR(100) NULL;

-- Episodios  (aquí viven los links de reproducción + marcas de intro/outro)
IF OBJECT_ID('dbo.Episodes', 'U') IS NULL
CREATE TABLE dbo.Episodes (
    Id            INT IDENTITY(1,1) PRIMARY KEY,
    SeasonId      INT NOT NULL,
    EpisodeNumber INT NOT NULL,
    Title         NVARCHAR(200) NOT NULL,
    Description   NVARCHAR(MAX) NULL,
    VideoUrl      NVARCHAR(1000) NOT NULL,   -- link de reproducción del video
    ThumbnailUrl  NVARCHAR(500) NULL,
    DurationSec   INT NULL,
    IntroStartSec INT NULL,                  -- inicio de la intro (para el botón "saltar intro")
    IntroEndSec   INT NULL,                  -- fin de la intro
    OutroStartSec INT NULL,                  -- inicio de los créditos (para "siguiente episodio")
    CONSTRAINT FK_Episodes_Seasons FOREIGN KEY (SeasonId) REFERENCES dbo.Seasons(Id) ON DELETE CASCADE,
    CONSTRAINT UQ_Episodes UNIQUE (SeasonId, EpisodeNumber)
);

-- Cómo debe reproducirse cada episodio:
--   'file'  = archivo progresivo (MP4/WebM) directo en VideoUrl
--   'hls'   = playlist HLS (.m3u8), se reproduce con hls.js
--   'embed' = reproductor de terceros incrustado en un <iframe>
IF COL_LENGTH('dbo.Episodes', 'Provider') IS NULL
    ALTER TABLE dbo.Episodes ADD Provider NVARCHAR(20) NOT NULL
        CONSTRAINT DF_Episodes_Provider DEFAULT 'file';

-- Relleno de ContentType para filas anteriores a que existiera la columna.
-- Va aquí, al final, porque el UPDATE consulta Seasons y Episodes: puesto más
-- arriba, una instalación limpia moría con "Invalid object name 'dbo.Seasons'"
-- al no existir todavía. El EXEC difiere la compilación, pero no la ejecución.
EXEC(N'
UPDATE s
   SET ContentType = CASE
       WHEN s.SourceRef LIKE ''jkanime:%'' THEN ''anime''
       WHEN EXISTS (
           SELECT 1
             FROM dbo.Seasons se
             JOIN dbo.Episodes e ON e.SeasonId = se.Id
            WHERE se.SeriesId = s.Id
           GROUP BY se.SeriesId
           HAVING COUNT(*) = 1 AND COUNT(DISTINCT se.Id) = 1
       ) THEN ''movie''
       WHEN s.ContentType IS NULL OR s.ContentType = '''' THEN ''series''
       WHEN s.ContentType = ''anime'' THEN ''series''
       ELSE s.ContentType
   END
  FROM dbo.Series s
 WHERE s.SourceRef LIKE ''jkanime:%''
    OR EXISTS (
           SELECT 1
             FROM dbo.Seasons se
             JOIN dbo.Episodes e ON e.SeasonId = se.Id
            WHERE se.SeriesId = s.Id
           GROUP BY se.SeriesId
           HAVING COUNT(*) = 1 AND COUNT(DISTINCT se.Id) = 1
       )
    OR s.ContentType IS NULL
    OR s.ContentType = ''''
    OR s.ContentType NOT IN (''anime'', ''series'', ''movie'');
');

-- Mi Lista (watchlist por usuario)
IF OBJECT_ID('dbo.Watchlist', 'U') IS NULL
CREATE TABLE dbo.Watchlist (
    Id       INT IDENTITY(1,1) PRIMARY KEY,
    UserId   INT NOT NULL,
    SeriesId INT NOT NULL,
    AddedAt  DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_Watchlist_Users  FOREIGN KEY (UserId)   REFERENCES dbo.Users(Id)  ON DELETE CASCADE,
    CONSTRAINT FK_Watchlist_Series FOREIGN KEY (SeriesId) REFERENCES dbo.Series(Id) ON DELETE CASCADE,
    CONSTRAINT UQ_Watchlist UNIQUE (UserId, SeriesId)
);

-- Progreso de reproducción ("seguir viendo")
IF OBJECT_ID('dbo.WatchProgress', 'U') IS NULL
CREATE TABLE dbo.WatchProgress (
    UserId      INT NOT NULL,
    EpisodeId   INT NOT NULL,
    PositionSec INT NOT NULL DEFAULT 0,
    UpdatedAt   DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_WatchProgress PRIMARY KEY (UserId, EpisodeId),
    CONSTRAINT FK_WatchProgress_Users    FOREIGN KEY (UserId)    REFERENCES dbo.Users(Id)    ON DELETE CASCADE,
    CONSTRAINT FK_WatchProgress_Episodes FOREIGN KEY (EpisodeId) REFERENCES dbo.Episodes(Id) ON DELETE CASCADE
);

-- Solicitudes de contenido: lo que la gente pide que se importe.
-- El estado lo mueve a mano quien atiende la cola; el importador vive en otro
-- repositorio y no escribe aquí.
IF OBJECT_ID('dbo.ContentRequests', 'U') IS NULL
CREATE TABLE dbo.ContentRequests (
    Id          INT IDENTITY(1,1) PRIMARY KEY,
    UserId      INT NOT NULL,
    Title       NVARCHAR(200) NOT NULL,
    ContentType NVARCHAR(20)  NOT NULL,
    Notes       NVARCHAR(500) NULL,
    Status      NVARCHAR(20)  NOT NULL CONSTRAINT DF_ContentRequests_Status DEFAULT 'pendiente',
    CreatedAt   DATETIME2     NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ContentRequests_Users FOREIGN KEY (UserId) REFERENCES dbo.Users(Id) ON DELETE CASCADE,
    CONSTRAINT CK_ContentRequests_Type   CHECK (ContentType IN ('anime', 'series', 'movie')),
    CONSTRAINT CK_ContentRequests_Status CHECK (Status IN ('pendiente', 'en curso', 'listo', 'rechazada'))
);

-- Por qué quedó como quedó, en cristiano y para enseñárselo a quien la pidió.
-- Sin esto, una solicitud rechazada solo decía "rechazada": el motivo se iba en
-- un mensaje de Telegram que ve el administrador y nadie más, así que quien la
-- pidió no sabía si su título no existe, si se llama de otra forma o si falló
-- algo pasajero que merece reintento.
IF COL_LENGTH('dbo.ContentRequests', 'ResultNote') IS NULL
    ALTER TABLE dbo.ContentRequests ADD ResultNote NVARCHAR(500) NULL;

-- La cola se lee por estado y por fecha; y de un usuario, lo suyo.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ContentRequests_Status' AND object_id = OBJECT_ID('dbo.ContentRequests'))
    CREATE INDEX IX_ContentRequests_Status ON dbo.ContentRequests (Status, CreatedAt DESC);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_ContentRequests_User' AND object_id = OBJECT_ID('dbo.ContentRequests'))
    CREATE INDEX IX_ContentRequests_User ON dbo.ContentRequests (UserId, CreatedAt DESC);

-- Un mismo usuario no puede tener dos veces el mismo título en cola. Filtrado
-- por estado a propósito: si ya se atendió, pedirlo otra vez es legítimo.
--
-- OJO: un índice filtrado obliga a QUOTED_IDENTIFIER ON para cualquier INSERT,
-- UPDATE o DELETE sobre la tabla. El driver de Node lo activa por su cuenta, así
-- que la aplicación no se entera; sqlcmd no, y allí falla con un error que no
-- menciona el índice. Al tocar esta tabla a mano hay que anteponer:
--   SET QUOTED_IDENTIFIER ON;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_ContentRequests_Pendiente' AND object_id = OBJECT_ID('dbo.ContentRequests'))
    CREATE UNIQUE INDEX UQ_ContentRequests_Pendiente
        ON dbo.ContentRequests (UserId, Title)
        WHERE Status = 'pendiente';
