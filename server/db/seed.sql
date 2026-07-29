-- =====================================================================
--  StreamFlix — Datos de ejemplo
--  Sólo se ejecuta si aún no hay series cargadas.
--  Los VideoUrl son MP4 públicos y reproducibles (bucket de Google).
-- =====================================================================
IF NOT EXISTS (SELECT 1 FROM dbo.Series)
BEGIN
    DECLARE @s INT, @season INT;

    ------------------------------------------------------------------
    -- Géneros
    ------------------------------------------------------------------
    INSERT INTO dbo.Genres (Name) VALUES
        (N'Animación'), (N'Comedia'), (N'Ciencia Ficción'), (N'Fantasía'),
        (N'Aventura'), (N'Acción'), (N'Documental'), (N'Drama');

    ------------------------------------------------------------------
    -- Serie 1: Big Buck Adventures
    ------------------------------------------------------------------
    INSERT INTO dbo.Series (Title, Description, PosterUrl, BackdropUrl, ReleaseYear, Rating)
    VALUES (N'Big Buck Adventures',
            N'Un conejo bonachón se enfrenta a tres roedores abusivos en un bosque encantado.',
            N'https://picsum.photos/seed/bigbuck/320/460',
            N'https://picsum.photos/seed/bigbuckbg/1280/500', 2018, 8.2);
    SET @s = SCOPE_IDENTITY();
    INSERT INTO dbo.SeriesGenres (SeriesId, GenreId) SELECT @s, Id FROM dbo.Genres WHERE Name IN (N'Animación', N'Comedia', N'Aventura');
    INSERT INTO dbo.Seasons (SeriesId, SeasonNumber, Title) VALUES (@s, 1, N'Temporada 1');
    SET @season = SCOPE_IDENTITY();
    INSERT INTO dbo.Episodes (SeasonId, EpisodeNumber, Title, Description, VideoUrl, ThumbnailUrl, DurationSec, IntroStartSec, IntroEndSec, OutroStartSec) VALUES
        (@season, 1, N'El gran conejo', N'Buck despierta en un día soleado.', N'https://archive.org/download/big-buck-bunny-512kb_202603/BigBuckBunny_512kb.mp4', N'https://picsum.photos/seed/bb1/320/180', 596, 0, 90, 536),
        (@season, 2, N'Diversión mayor', N'Una tarde de juegos se sale de control.', N'https://archive.org/download/CaminandesLlamigos/Caminandes_%20Llamigos-1080p.mp4', N'https://picsum.photos/seed/bb2/320/180', 150, 0, 12, 130),
        (@season, 3, N'Paseos salvajes', N'La persecución final por el bosque.', N'https://archive.org/download/CaminandesLlamigos/Caminandes_%20Llamigos-1080p.mp4', N'https://picsum.photos/seed/bb3/320/180', 150, 0, 12, 130);

    ------------------------------------------------------------------
    -- Serie 2: Elephants Dream
    ------------------------------------------------------------------
    INSERT INTO dbo.Series (Title, Description, PosterUrl, BackdropUrl, ReleaseYear, Rating)
    VALUES (N'Elephants Dream',
            N'Dos personajes exploran una extraña máquina infinita llena de peligros surrealistas.',
            N'https://picsum.photos/seed/eledream/320/460',
            N'https://picsum.photos/seed/eledreambg/1280/500', 2019, 7.8);
    SET @s = SCOPE_IDENTITY();
    INSERT INTO dbo.SeriesGenres (SeriesId, GenreId) SELECT @s, Id FROM dbo.Genres WHERE Name IN (N'Animación', N'Ciencia Ficción', N'Drama');
    INSERT INTO dbo.Seasons (SeriesId, SeasonNumber, Title) VALUES (@s, 1, N'Temporada 1');
    SET @season = SCOPE_IDENTITY();
    INSERT INTO dbo.Episodes (SeasonId, EpisodeNumber, Title, Description, VideoUrl, ThumbnailUrl, DurationSec, IntroStartSec, IntroEndSec, OutroStartSec) VALUES
        (@season, 1, N'La máquina', N'Proog guía a Emo por la estructura.', N'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4', N'https://picsum.photos/seed/ed1/320/180', 653, 0, 90, 593),
        (@season, 2, N'Grandes llamas', N'Un mundo en llamas pone todo a prueba.', N'https://archive.org/download/CaminandesLlamigos/Caminandes_%20Llamigos-1080p.mp4', N'https://picsum.photos/seed/ed2/320/180', 150, 0, 12, 130),
        (@season, 3, N'La huida', N'El escape definitivo.', N'https://archive.org/download/CaminandesLlamigos/Caminandes_%20Llamigos-1080p.mp4', N'https://picsum.photos/seed/ed3/320/180', 150, 0, 12, 130);

    ------------------------------------------------------------------
    -- Serie 3: Sintel Saga
    ------------------------------------------------------------------
    INSERT INTO dbo.Series (Title, Description, PosterUrl, BackdropUrl, ReleaseYear, Rating)
    VALUES (N'Sintel Saga',
            N'Una guerrera solitaria busca al dragón que perdió, cruzando tierras heladas.',
            N'https://picsum.photos/seed/sintel/320/460',
            N'https://picsum.photos/seed/sintelbg/1280/500', 2020, 8.9);
    SET @s = SCOPE_IDENTITY();
    INSERT INTO dbo.SeriesGenres (SeriesId, GenreId) SELECT @s, Id FROM dbo.Genres WHERE Name IN (N'Fantasía', N'Aventura', N'Drama');
    INSERT INTO dbo.Seasons (SeriesId, SeasonNumber, Title) VALUES (@s, 1, N'Temporada 1');
    SET @season = SCOPE_IDENTITY();
    INSERT INTO dbo.Episodes (SeasonId, EpisodeNumber, Title, Description, VideoUrl, ThumbnailUrl, DurationSec, IntroStartSec, IntroEndSec, OutroStartSec) VALUES
        (@season, 1, N'El dragón perdido', N'Sintel recuerda cómo empezó todo.', N'https://archive.org/download/Sintel/sintel-2048-stereo_512kb.mp4', N'https://picsum.photos/seed/si1/320/180', 888, 0, 90, 828),
        (@season, 2, N'Crisis', N'El colapso lo cambia todo.', N'https://archive.org/download/CaminandesLlamigos/Caminandes_%20Llamigos-1080p.mp4', N'https://picsum.photos/seed/si2/320/180', 150, 0, 12, 130);

    ------------------------------------------------------------------
    -- Serie 4: Tears of Steel
    ------------------------------------------------------------------
    INSERT INTO dbo.Series (Title, Description, PosterUrl, BackdropUrl, ReleaseYear, Rating)
    VALUES (N'Tears of Steel',
            N'Un grupo de guerreros y científicos intenta salvar el mundo de máquinas hostiles.',
            N'https://picsum.photos/seed/tears/320/460',
            N'https://picsum.photos/seed/tearsbg/1280/500', 2021, 8.1);
    SET @s = SCOPE_IDENTITY();
    INSERT INTO dbo.SeriesGenres (SeriesId, GenreId) SELECT @s, Id FROM dbo.Genres WHERE Name IN (N'Ciencia Ficción', N'Acción');
    INSERT INTO dbo.Seasons (SeriesId, SeasonNumber, Title) VALUES (@s, 1, N'Temporada 1');
    SET @season = SCOPE_IDENTITY();
    INSERT INTO dbo.Episodes (SeasonId, EpisodeNumber, Title, Description, VideoUrl, ThumbnailUrl, DurationSec, IntroStartSec, IntroEndSec, OutroStartSec) VALUES
        (@season, 1, N'Amsterdam', N'El pasado vuelve para cobrar su precio.', N'https://archive.org/download/tears-of-steel_202504/Tears%20of%20Steel.mp4', N'https://picsum.photos/seed/ts1/320/180', 735, 0, 90, 675),
        (@season, 2, N'Bullrun', N'Una carrera contra el tiempo.', N'https://archive.org/download/cosmos-laundromat/Cosmos%20Laundromat.mp4', N'https://picsum.photos/seed/ts2/320/180', 730, 0, 90, 670);

    ------------------------------------------------------------------
    -- Serie 5: Motor World (documental)
    ------------------------------------------------------------------
    INSERT INTO dbo.Series (Title, Description, PosterUrl, BackdropUrl, ReleaseYear, Rating)
    VALUES (N'Motor World',
            N'Un recorrido por autos icónicos, pruebas de manejo y reseñas a fondo.',
            N'https://picsum.photos/seed/motor/320/460',
            N'https://picsum.photos/seed/motorbg/1280/500', 2022, 7.2);
    SET @s = SCOPE_IDENTITY();
    INSERT INTO dbo.SeriesGenres (SeriesId, GenreId) SELECT @s, Id FROM dbo.Genres WHERE Name IN (N'Documental');
    INSERT INTO dbo.Seasons (SeriesId, SeasonNumber, Title) VALUES (@s, 1, N'Temporada 1');
    SET @season = SCOPE_IDENTITY();
    INSERT INTO dbo.Episodes (SeasonId, EpisodeNumber, Title, Description, VideoUrl, ThumbnailUrl, DurationSec, IntroStartSec, IntroEndSec, OutroStartSec) VALUES
        (@season, 1, N'Volkswagen GTI', N'Reseña completa del hot hatch alemán.', N'https://archive.org/download/cosmos-laundromat/Cosmos%20Laundromat.mp4', N'https://picsum.photos/seed/mw1/320/180', 730, 0, 90, 670),
        (@season, 2, N'Subaru Outback', N'Del asfalto a la tierra.', N'https://archive.org/download/cosmos-laundromat/Cosmos%20Laundromat.mp4', N'https://picsum.photos/seed/mw2/320/180', 730, 0, 90, 670),
        (@season, 3, N'¿Qué compras con mil?', N'Autos usados por poco dinero.', N'https://archive.org/download/cosmos-laundromat/Cosmos%20Laundromat.mp4', N'https://picsum.photos/seed/mw3/320/180', 730, 0, 90, 670);

    PRINT 'Datos de ejemplo insertados.';
END
ELSE
    PRINT 'La base ya tenía datos; no se insertó nada.';
