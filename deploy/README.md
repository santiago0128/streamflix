# Despliegue en servidor

Montaje: SQL Server y la aplicación en Docker, el importador en el host, y un
proxy inverso delante para HTTPS.

```
/opt/streamflix/
  streamflix/          repositorio de la app (este)
    .env               secretos de producción (no versionado)
  jk-anime-launcher/   el bot importador
```

## 1. Requisitos del servidor

- Docker y el plugin compose.
- **2 GB de RAM libres como mínimo** para SQL Server; con 4 GB va cómodo.
  Por debajo de 2 GB el contenedor arranca y se muere sin mensaje claro.
- ~6 GB de disco: imagen de SQL Server (~1,5 GB), sus datos (~1 GB inicial),
  imagen de Node (~150 MB) y el catálogo.

## 2. Puesta en marcha

```bash
cd /opt/streamflix/streamflix
cp .env.example .env
# Generar los dos secretos y ponerlos en .env:
openssl rand -base64 32   # DB_PASSWORD (revisar que cumpla la política de SQL Server)
openssl rand -base64 32   # JWT_SECRET

docker compose -f docker-compose.prod.yml up -d --build
```

La base tarda ~1 minuto en aceptar conexiones la primera vez; el `healthcheck`
retiene el arranque de la app hasta entonces.

Crear el esquema:

```bash
docker compose -f docker-compose.prod.yml exec app node server/db/init.js
```

Comprobar:

```bash
curl localhost:3000/api/health     # {"status":"ok","db":"connected"}
```

## 2.1 Temporadas de franquicias de anime (una vez)

En jkanime cada temporada de una franquicia es una ficha aparte, con su propio
slug y su numeración empezando otra vez en 1. Ese slug se guarda ahora en
`dbo.Seasons.SourceRef`; sin él, el capítulo 2 de cualquier temporada de Bleach
se resolvía contra el capítulo 2 de la serie original.

Para lo ya importado, el campo se rellena a partir de los snapshots que ya están
en la base, sin reimportar nada. El script crea la columna si falta, así que
basta con:

```bash
docker compose -f docker-compose.prod.yml exec app node server/db/backfill-season-sourceref.js --dry-run
docker compose -f docker-compose.prod.yml exec app node server/db/backfill-season-sourceref.js
```

Es idempotente: se puede repetir. Las temporadas que avise como «sin origen» son
las que no tienen snapshots en la base y sí hay que volver a importar.

## 2.2 Portadas del catálogo

Las portadas que trae el importador son las de la página de origen: miniaturas
pequeñas y en dominios que rotan. `update-posters.js` las cambia por las de
AniList (anime) y TMDB (cine y series). Ver el README principal para el detalle.

Lo cómodo es la acción **«Actualizar portadas del catálogo»** en la pestaña
Actions del repositorio: usa los mismos secretos que el despliegue, así que no
hace falta entrar al servidor. Por defecto **simula y no escribe nada** — hay que
marcar `aplicar` a propósito.

Conviene lanzarla dos veces: la primera sin `aplicar`, para leer el informe, y la
segunda marcándolo. En el informe importa la lista final: son las fichas cuyo año
no cuadra con el del catálogo de origen, que casi siempre es otra cosa con el
mismo nombre (una temporada de una franquicia, o un concurso derivado de una
serie). Esas se omiten a propósito; si la ficha es la correcta, se repite
marcando también `con_desfase_de_anio`.

Cuando escribe, deja la vuelta atrás en `/tmp/portadas-respaldo.sql` dentro del
contenedor y la sube como artefacto `respaldo-portadas` de la ejecución. Para
deshacer, ese fichero se pasa tal cual a la base.

A mano, si se prefiere:

```bash
cd /opt/streamflix/streamflix
docker compose -f docker-compose.prod.yml exec -T app node server/db/update-posters.js
docker compose -f docker-compose.prod.yml exec -T app \
  node server/db/update-posters.js --apply --respaldo=/tmp/portadas-respaldo.sql
```

## 3. Importador

El bot no es un servicio: se ejecuta a demanda. Necesita Node en el host y
encontrar el `.env` de la app, que resuelve por `STREAMFLIX_ROOT`.

```bash
cd /opt/streamflix/jk-anime-launcher
npm ci --omit=dev
export STREAMFLIX_ROOT=/opt/streamflix/streamflix

node import_series_to_streamflix.js --content-type serie --title "Stranger Things" --no-browser
```

`--no-browser` es obligatorio en un servidor: no hay navegador que abrir.

Los enlaces de video llevan token y caducan en horas. Conviene una tarea diaria
que revise y reimporte lo que se haya roto:

```cron
0 5 * * * cd /opt/streamflix/jk-anime-launcher && STREAMFLIX_ROOT=/opt/streamflix/streamflix JK_NO_BROWSER=1 node check_streamflix_links.js --fix >> /var/log/streamflix-import.log 2>&1
```

## 3.1 Atender las solicitudes de contenido

Lo que la gente pide desde **Solicitar** se guarda en `dbo.ContentRequests` y se
queda en `pendiente` hasta que alguien lo atiende. De eso se encarga
`procesar_solicitudes.js`, en el repositorio del bot: coge las pendientes por
orden de llegada, lanza el importador y deja cada una en `listo` o `rechazada`,
avisando por Telegram del resultado.

```bash
cd /opt/streamflix/jk-anime-launcher
export STREAMFLIX_ROOT=/opt/streamflix/streamflix

node procesar_solicitudes.js --dry-run   # qué haría, sin tocar nada
node procesar_solicitudes.js             # atiende la cola
```

En cron, para que no haga falta acordarse:

```cron
*/15 * * * * cd /opt/streamflix/jk-anime-launcher && STREAMFLIX_ROOT=/opt/streamflix/streamflix JK_NO_BROWSER=1 node procesar_solicitudes.js >> /var/log/streamflix-solicitudes.log 2>&1
```

Va **de una en una**: veinte importaciones a la vez son veinte descargas
compitiendo por el mismo servidor y acaban fallando todas. Dos ejecuciones que se
solapen tampoco se pisan — hay un cerrojo, y cada solicitud se reclama con un
`UPDATE` condicional, así que solo una puede cogerla.

Un título que no aparezca **no se importa a lo que más se le parezca**: queda en
`rechazada` con el motivo. Importar *Stealing Pulp Fiction* porque alguien pidió
*Pulp Fiction* es peor que no importar nada, y deshacerlo cuesta más que hacerlo
a mano. Para forzar un parecido concreto se importa a mano con `--accept-similar`.

**Cualquiera con cuenta puede encolar importaciones**, que es lo que se pidió: no
hay tope ni aprobación. Si algún día molesta, el freno más simple es bajar el
límite de pendientes por usuario en [server/routes/requests.js](../server/routes/requests.js).

## 4. Proxy inverso

La app escucha solo en `127.0.0.1:3000`. Delante va nginx o Caddy con el
certificado. Con Caddy son dos líneas en `/etc/caddy/Caddyfile`:

```
tu-dominio.com {
    reverse_proxy 127.0.0.1:3000
}
```

## 5. Antes de abrirlo a internet

`GET /api/episodes/:id/stream` **no pide autenticación**. Tal cual, cualquiera
que conozca la URL puede usar el servidor como proxy de video con tu ancho de
banda, sin pasar por el login. En local no importaba; expuesto sí.

Opciones, de menos a más trabajo:

1. Dejar el sitio entero detrás de autenticación básica en el proxy inverso.
2. Restringir por IP en el proxy inverso.
3. Firmar la URL de reproducción con un token corto por episodio y usuario,
   igual que ya se hace con los sub-recursos del playlist.

Lo demás que conviene revisar: el puerto 1433 no está publicado (la base solo
se ve desde la red de Docker), y los secretos del repositorio —incluida la
contraseña del `docker-compose.yml` de desarrollo— no sirven aquí.
