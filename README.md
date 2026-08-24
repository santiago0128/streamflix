# 🎬 StreamFlix

Maqueta de plataforma de streaming: catálogo de series con buscador y filtro por
género, login con lista de reproducción propia por usuario y un reproductor de
video personalizado con **cambio de capítulos** y **saltar intro**.

## Stack
- **Base de datos:** SQL Server 2022 (en Docker)
- **Backend:** Node.js + Express + `mssql` + JWT (auth con `bcryptjs`)
- **Frontend:** SPA en HTML/CSS/JS (sin build), tema oscuro estilo Netflix

## Requisitos
- Docker (para SQL Server)
- Node.js 16+

## Puesta en marcha

```bash
# 1) Levantar SQL Server
docker compose up -d

# 2) Instalar dependencias
npm install

# 3) Crear la base, tablas y datos de ejemplo
npm run db:init

# 4) Arrancar el servidor
npm start
```

Luego abre **http://localhost:3000**.

Las credenciales de la base y el puerto están en `.env`.

## Importar anime desde Kitsu

`npm run db:anime` trae metadatos reales (portada, banner, sinopsis, géneros y la
lista completa de episodios con título, resumen y miniatura) desde la API pública
de [Kitsu](https://kitsu.docs.apiary.io/) — no necesita API key — y los inserta en
la base.

```bash
npm run db:anime -- "one punch" --placeholder-video   # busca y pide confirmación
npm run db:anime -- 7442 --media-dir ./media/opm      # con tus propios videos
npm run db:anime -- 3936 --dry-run --placeholder-video # sólo mostrar, no escribir
npm run db:anime -- 3936 --force --placeholder-video   # borra y vuelve a importar
```

Antes de escribir nada muestra una ficha con lo que encontró (títulos en inglés,
romaji y japonés, fechas de emisión, nº de episodios, duración, géneros, portada)
y pide confirmación. `--yes` la omite, `--dry-run` no toca la base.

Es idempotente: si la serie ya existe avisa y no hace nada (salvo con `--force`).
Los géneros de Kitsu se traducen al español y se crean en `Genres` si faltan; cada
serie importada recibe además `Anime` y `Animación` para poder filtrarla.

### De dónde sale el video

**Este importador no puede traer el video real**: los episodios de un anime son
contenido con licencia. Hay que elegir explícitamente una de las dos opciones —
si no se indica ninguna, el script se niega a correr.

| Opción | Qué hace |
|--------|----------|
| `--media-dir <ruta>` | Usa tus propios archivos. La carpeta debe estar dentro de `media/`. Los empareja por número de episodio en el nombre (`E01`, `cap01`, `1x05`, …) y los publica en `/media`. Los episodios sin archivo se omiten. |
| `--placeholder-video` | Rellena con películas libres de la Blender Foundation. **No es la serie**: sirve para probar el reproductor, y `db:verify` lo marcará como error a propósito. |

`media/` está en `.gitignore` y Express la sirve con soporte de *range requests*,
así que el seek del reproductor funciona con archivos locales.

## Portadas

Las portadas venían de la página de la que se importó cada título (cuevana3,
pelisplushd, jkdesa, henaojara): miniaturas de 10-18 KB, borrosas en la ficha
grande y colgando de dominios que cambian de número cada pocos meses.
`npm run db:posters` las sustituye por las del catálogo que corresponda —
**AniList para el anime, TMDB para películas y series**.

```bash
npm run db:posters                    # simulación de los tres tipos
npm run db:posters -- --apply         # escribe la base
npm run db:posters -- --type=anime    # solo un tipo (movie, series, anime)
npm run db:posters -- --ids=4,6       # solo esas fichas
npm run db:posters -- --force         # rehace también las ya migradas
npm run db:posters -- --revisar       # además, busca portadas que den 404
npm run db:posters -- --apply --respaldo=vuelta.sql   # deja cómo deshacerlo
```

`--revisar` pide cada portada que ya estaba en un CDN bueno y comprueba dos
cosas: que responda y que la ficha de TMDB/AniList siga correspondiendo al
título, tipo y año guardados. Sin él la decisión es solo por el dominio de la
URL, que no detecta una portada viva pero perteneciente a otra película.

La comprobación **reintenta antes de dar una imagen por muerta**. Pedir el
catálogo entero de una tirada hace que el CDN corte la conexión, y con un solo
intento aparecen como rotas imágenes que responden 200 las tres veces si se
piden de una en una. Reemplazar una portada buena por ese motivo es peor que el
problema que se quería arreglar.

`--respaldo` escribe un `UPDATE` por cada fila **antes** de tocarla, así que el
fichero sirve aunque el recorrido se corte a la mitad: contiene exactamente lo
que se cambió. Para deshacer, se ejecuta contra la misma base.

El anime va primero a AniList porque guarda el título en romaji, en inglés y en
japonés, que es por donde vienen los títulos del catálogo («Shingeki no Kyojin
Temporada 1»), y su carátula es la oficial del anime en vez del cartel de una
edición concreta. Si allí no aparece, se prueba TMDB.

Guarda la URL, no la imagen: no descarga ni re-aloja nada. Ninguno de los dos
orígenes necesita clave. Es idempotente: sin `--force` salta lo que ya está en un
CDN bueno (TMDB, AniList, Kitsu), así que no toca el anime importado de Kitsu,
que ya trae su carátula.

Antes de escribir comprueba que la imagen responde. Y **no escribe nada que no
case con seguridad**: si el título no aparece, deja la portada que hubiera; una
equivocada es peor que una borrosa, porque nadie la revisa después.

Por eso omite también las fichas cuyo año no cuadra, que casi siempre son otra
cosa con el mismo nombre: «El juego del calamar» casa con *Squid Game: The
Challenge* (el concurso derivado), y «Bleach (2024)» —que es el *Sennen
Kessen-hen*— casa con el BLEACH original de 2004, cuya carátula no es la de esa
temporada. Las lista al final con el enlace a la ficha para revisarlas:

- si el año de la base está mal, corrígelo y repite con `--ids=<id>`;
- si la ficha es la correcta, repite con `--con-desfase-de-año`.

## Bienvenida

Al entrar sale un modal que explica las dos cosas que no se descubren solas: que
se puede **pedir** contenido que falte, y que hay un botón de **donar** para el
servidor. Cada bloque dice también lo que *no* promete —ni plazos ni ventajas por
donar—, que es lo que evita la queja después.

Sale **en cada carga de la página**, a propósito: la idea es que nadie se pierda
que se puede pedir contenido, y quien recarga es justo quien todavía no lo ha
leído. No se recuerda nada entre cargas.

El bloque de donaciones solo aparece si hay donaciones configuradas, y el modal
no sale al volver de Mercado Pago: ahí ya hay un agradecimiento, y volver a pedir
justo después de que alguien haya dado sobra.

Para enseñarlo una sola vez por visita, basta con marcarlo en `sessionStorage`
dentro de `mostrarBienvenida()` ([public/js/app.js](public/js/app.js)) y salir si
la marca ya está.

## Solicitar contenido

El enlace **Solicitar** de la barra superior abre un formulario para pedir un
título que no esté en el catálogo. Se guarda en `dbo.ContentRequests` y, si el
bot está configurado, avisa por Telegram con el título, el tipo y quién lo pidió.

Exige sesión, para saber de quién viene cada petición, pero el enlace se ve
también sin ella: si se escondiera, nadie descubriría que la función existe. Al
pulsarlo sin sesión se ofrece entrar.

Cada persona ve las suyas con su estado y puede retirar las que sigan
pendientes. Los frenos son dos: **5 pendientes por cuenta** y un índice único que
impide pedir dos veces el mismo título mientras el primero siga en cola.

El estado (`pendiente`, `en curso`, `listo`, `rechazada`) se mueve a mano en la
base — el importador vive en otro repositorio y no escribe aquí:

```sql
SET QUOTED_IDENTIFIER ON;   -- obligatorio: la tabla tiene un índice filtrado
UPDATE dbo.ContentRequests SET Status = 'listo' WHERE Id = 12;
```

Antes de encolar, la web compara el título con el catálogo y sus alias oficiales
(inglés, romaji y japonés en anime; TMDB en cine/series cuando hay clave). El
worker repite la comprobación y usa la IA solo como respaldo para proponer
traducciones: nunca bloquea por simple parecido. Así «Solo Leveling» y
«俺だけレベルアップな件» se consideran la misma obra.

## Donaciones

El botón **Donar** lleva a Mercado Pago. Los datos de la tarjeta no pasan por
aquí en ningún caso. Hay dos formas de tenerlo montado y **si están las dos,
manda el enlace**:

| | `MP_DONATION_LINK` (recomendada) | `MP_ACCESS_TOKEN` (Checkout Pro) |
|---|---|---|
| Credenciales | ninguna | un token que puede cobrar |
| Importe | lo pone el donante en Mercado Pago | se elige en la web, con sugerencias |
| Si el servidor cae | sigue funcionando | deja de funcionar |
| Configuración | una variable | moneda, importes, límites, `PUBLIC_BASE_URL` |

Para una donación, el enlace es lo que conviene: no hay secreto que guardar, no
caduca y tiene menos formas de romperse. Se crea en el panel de Mercado Pago
(*Cobrar* → *Link de pago*).

Checkout Pro solo compensa cuando el pago tiene que **atarse a algo** de aquí —
desbloquear una cuenta, registrar quién pagó, dar una suscripción. Una donación
no ata nada, así que ese modo añade un secreto y varias formas nuevas de fallar
a cambio de poco. Si aun así se quiere: el servidor crea la preferencia, hacen
falta las variables de la tabla, y conviene fijar `PUBLIC_BASE_URL` con la
dirección pública porque es a donde Mercado Pago devuelve al donante y detrás del
proxy inverso no se puede deducir. Con `https` se activa el retorno automático, y
el token de prueba (`TEST-...`) devuelve un enlace de sandbox.

**Sin ninguna de las dos, el botón no aparece**: la web pregunta primero a
`/api/donations/config`, para no enseñar un botón que lleva a un error.

## Verificar el contenido

`npm run db:verify` comprueba que lo guardado es de verdad la serie que se quiso
traer, no relleno. Sale con código 1 si encuentra errores, así que sirve en CI.

```bash
npm run db:verify              # todas las series
npm run db:verify -- 9         # sólo una
npm run db:verify -- --quick   # sin sondear duraciones (más rápido)
```

Qué comprueba:

- **Identidad** — vuelve a consultar el catálogo de origen (columna `SourceRef`,
  ej. `kitsu:3936`) y contrasta título, año y número de episodios.
- **Numeración** — que los episodios vayan de 1 a N sin huecos ni duplicados.
- **Video** — que cada archivo responda, acepte *range requests* y, sobre todo,
  que su **duración real** (leída de los atoms del MP4, sin descargarlo entero)
  coincida con la del episodio según la fuente. Aquí es donde se destapa el video
  de relleno: un archivo de 10 min no puede ser un episodio de 24 min.
- **Archivos repetidos** — si varios episodios comparten video, no es contenido real.
- **Imágenes** — portada, banner y una muestra de miniaturas.

Si una duración no se puede medir, se reporta como error: nunca se da por buena
una comprobación que no se pudo hacer.

## Estructura

```
streamflix/
├─ docker-compose.yml      # SQL Server
├─ .env                    # config (BD, JWT, puerto)
├─ server/
│  ├─ index.js             # Express + rutas + estáticos
│  ├─ db.js                # pool de conexión a SQL Server
│  ├─ db/
│  │  ├─ schema.sql        # tablas
│  │  ├─ seed.sql          # datos de ejemplo (videos reales)
│  │  ├─ init.js           # crea BD + aplica schema + seed
│  │  ├─ import-anime.js   # importador de anime desde la API de Kitsu
│  │  ├─ tmdb.js           # búsqueda de fichas en TMDB (cine y series)
│  │  ├─ anilist.js        # búsqueda de fichas en AniList (anime)
│  │  ├─ update-posters.js # portadas del catálogo desde AniList/TMDB
│  │  └─ verify-content.js # verifica que lo guardado sea la serie correcta
│  ├─ middleware/auth.js   # verificación de JWT
│  ├─ lib/telegram.js      # avisos al chat que administra el catálogo
│  └─ routes/
│     ├─ auth.js           # register / login / me
│     ├─ series.js         # catálogo, búsqueda, filtro, detalle
│     ├─ requests.js       # solicitudes de contenido (requiere sesión)
│     ├─ donations.js      # Checkout Pro de Mercado Pago
│     └─ watchlist.js      # Mi Lista (requiere sesión)
└─ public/
   ├─ index.html
   ├─ css/styles.css
   └─ js/{api,player,app}.js
```

## Modelo de datos
`Users`, `Genres`, `Series`, `SeriesGenres` (N:N), `Seasons`, `Episodes`
(con `VideoUrl` + marcas `IntroStartSec`/`IntroEndSec`/`OutroStartSec`),
`Watchlist` (Mi Lista), `WatchProgress` (seguir viendo) y `ContentRequests`
(lo que la gente pide que se importe).

## Proxy de reproducción
Todo lo que no sea `Provider = 'embed'` se reproduce a través de
`GET /api/episodes/:id/stream` en vez de apuntar al origen. Es lo que permite usar
el reproductor propio con contenido importado: los CDN de origen no mandan
`Access-Control-Allow-Origin`, así que el navegador no puede leerlos directamente.

El proxy hace tres cosas además de reenviar el stream:

- Reescribe los playlist `m3u8` para que las variantes y los segmentos también
  pasen por aquí. Cada sub-recurso va firmado (`?u=...&sig=...`) para que el
  endpoint no quede como proxy abierto a cualquier URL de internet.
- Manda el `Referer` con el que se verificó el video, que algunos CDN exigen. Sale
  de las tablas de snapshots que escribe el importador.
- Destapa los segmentos que algunos CDN disfrazan de imagen (cabecera PNG con el
  MPEG-TS detrás).

### Orden de las fuentes en el anime

Un capítulo de anime puede estar en varios catálogos. El orden lo fija
`CATALOGOS_ANIME` en [series.js](server/routes/series.js), no el orden de las
consultas:

1. **animejara** — el que trae el latino, con los idiomas declarados por capítulo.
2. **henaojara** — mismo grupo, catálogo más viejo. Ambos viven en `PelisPlusSnapshots`
   con `ContentType = 'anime'`; se distinguen por `SourceSite`.
3. **jkanime** (`JkAnimeEpisodeSnapshots`) — respaldo, subtitulado casi entero.

Los candidatos se agrupan por catálogo antes de ordenarlos por servidor, para que
la preferencia entre sitios mande sobre la preferencia entre servidores: sin eso,
un `vidhide` de jkanime se probaba antes que cualquier opción de animejara, porque
la lista de servidores se ordenaba junta y ese es el servidor mejor valorado.

El respaldo sigue entero: si un catálogo no tiene el capítulo, o ninguno de sus
candidatos devuelve un video que responda, se resuelve contra el siguiente. Cada
embed viaja con el `Referer` de la página de **su** catálogo, no con el del
primero de la lista.

### Idiomas

El idioma pedido se respeta o no se reproduce: **nunca se sirve otro idioma bajo
la etiqueta del elegido**. Eso obliga a descartar dos clases de fuente cuando hay
un idioma concreto en juego:

- Las opciones que no declaran idioma (el reproductor propio de jkanime), salvo
  que todo su catálogo hable ese mismo idioma.
- La URL ya verificada que cada snapshot guarda suelta (`VideoSrcUrl`,
  `VerifiedVideoUrl`, `PrimaryVideoUrl`), salvo que la fila entera sea de ese
  idioma. En animejara los tres idiomas van en la misma fila, así que esa URL no
  dice de cuál es: era lo que hacía sonar Death Note en japonés con el latino
  puesto.

El desplegable se dibuja con los idiomas de la **temporada** (`audioOptions`), no
con los del capítulo: si la temporada no tiene latino no hay nada que elegir y no
aparece. La respuesta de `/playback` trae además `audioDisponible` (lo que tiene
ese capítulo) y `audioFallback`, para poder marcar «no en este capítulo» sin
mentir sobre lo que suena.

Cuando el capítulo no tiene el idioma preferido —el 192 de Bleach en adelante no
tiene latino— suena el que haya y **la preferencia no se toca**: solo la cambia el
usuario desde el selector. Antes se guardaba el idioma que resolvía el servidor, y
un capítulo sin latino dejaba la serie entera en japonés para siempre.

Sin preferencia guardada manda `ORDEN_AUDIO`: latino primero y japonés al final,
porque el japonés está en todo el catálogo de jkanime y ponerlo delante dejaría el
latino sin usar nunca.

## Reproductor — atajos de teclado
| Tecla | Acción |
|-------|--------|
| `Espacio` / `k` | play / pausa |
| `←` / `→` | -10s / +10s |
| `↑` / `↓` | volumen |
| `n` / `p` | siguiente / anterior episodio |
| `f` | pantalla completa |
| `Esc` | cerrar el panel abierto; si no hay ninguno, cerrar el reproductor |

Los capítulos se cambian desde el botón de lista de la barra inferior, que abre
la lista dentro del propio reproductor con el que suena marcado. Antes era un
`<select>` nativo: a pantalla completa el desplegable del sistema se abría fuera
del vídeo y con los títulos cortados.

El botón de siguiente capítulo está en la barra inferior y también en el mando
central, que es el que se ve en el móvil: allí la barra esconde los controles de
capítulo por falta de sitio, así que sin él la única forma de pasar de capítulo
con el dedo era esperar a los créditos. En una película, donde no hay siguiente
ni lista que enseñar, los dos desaparecen.

## Cómo funciona "saltar intro"
Cada episodio guarda en la BD los segundos donde empieza y termina la intro
(`IntroStartSec`, `IntroEndSec`). El reproductor muestra el botón **Saltar intro**
sólo dentro de esa ventana; al pulsarlo salta a `IntroEndSec`. `OutroStartSec`
dispara el botón **Siguiente episodio**. Para ajustar estas marcas basta con
actualizar la fila del episodio en la tabla `Episodes`.

El importador consulta las marcas exactas por episodio en AniSkip usando el ID
de MyAnimeList resuelto por AniList. Esto se aplica tanto a JKAnime como a
AnimeJara/HenaoJara. Para lo ya importado, desde el repositorio del bot:

```bash
npm run db:skip-times                         # simulación
npm run db:skip-times -- --ids=1004 --apply # una ficha concreta
npm run db:skip-times -- --apply             # todo lo que tenga datos
```

Si AniSkip no conoce un episodio se deja sin marca; una IA de texto no puede
verificar un segundo de vídeo y no se usa para inventarlo.

## Próximos pasos sugeridos
- Panel de administración para cargar series/episodios (hoy se cargan por SQL)
- "Seguir viendo" usando la tabla `WatchProgress` (ya existe)
- Streaming HLS y subtítulos
- Perfiles múltiples por cuenta
```
