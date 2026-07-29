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
│  │  └─ verify-content.js # verifica que lo guardado sea la serie correcta
│  ├─ middleware/auth.js   # verificación de JWT
│  └─ routes/
│     ├─ auth.js           # register / login / me
│     ├─ series.js         # catálogo, búsqueda, filtro, detalle
│     └─ watchlist.js      # Mi Lista (requiere sesión)
└─ public/
   ├─ index.html
   ├─ css/styles.css
   └─ js/{api,player,app}.js
```

## Modelo de datos
`Users`, `Genres`, `Series`, `SeriesGenres` (N:N), `Seasons`, `Episodes`
(con `VideoUrl` + marcas `IntroStartSec`/`IntroEndSec`/`OutroStartSec`),
`Watchlist` (Mi Lista) y `WatchProgress` (seguir viendo).

## Reproductor — atajos de teclado
| Tecla | Acción |
|-------|--------|
| `Espacio` / `k` | play / pausa |
| `←` / `→` | -10s / +10s |
| `↑` / `↓` | volumen |
| `n` / `p` | siguiente / anterior episodio |
| `f` | pantalla completa |
| `Esc` | cerrar |

## Cómo funciona "saltar intro"
Cada episodio guarda en la BD los segundos donde empieza y termina la intro
(`IntroStartSec`, `IntroEndSec`). El reproductor muestra el botón **Saltar intro**
sólo dentro de esa ventana; al pulsarlo salta a `IntroEndSec`. `OutroStartSec`
dispara el botón **Siguiente episodio**. Para ajustar estas marcas basta con
actualizar la fila del episodio en la tabla `Episodes`.

## Próximos pasos sugeridos
- Panel de administración para cargar series/episodios (hoy se cargan por SQL)
- "Seguir viendo" usando la tabla `WatchProgress` (ya existe)
- Streaming HLS y subtítulos
- Perfiles múltiples por cuenta
```
