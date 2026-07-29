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
