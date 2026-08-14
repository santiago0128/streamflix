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

La acción **«Actualizar portadas del catálogo»** (pestaña Actions) usa los mismos
secretos que el despliegue, así que no hace falta entrar al servidor. Lanzada a
mano **simula y no escribe nada** — hay que marcar `aplicar` a propósito.

Además corre **sola una vez al día**, y esa pasada sí repara. Una portada rota no
avisa: nadie mira el catálogo entero, y uno se entera cuando alguien abre una
ficha y encuentra el hueco. La pasada diaria usa `--revisar`, que pide cada
imagen y rehace solo las que no responden, así que en un día normal no cambia
nada. El respaldo de esa ejecución queda como artefacto igual que el de las
manuales.

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

**Lo atiende un servicio en segundo plano**, `solicitudes` en
`docker-compose.prod.yml`, que corre `procesar_solicitudes.js --vigilar`: drena
la cola, espera unos segundos y vuelve a mirar. Una solicitud entra en
importación a los segundos de hacerse.

```bash
docker compose -f docker-compose.prod.yml logs -f solicitudes   # qué está haciendo
docker compose -f docker-compose.prod.yml restart solicitudes   # tras tocar el worker
```

Antes esto era un cron horario, y ahí estaba el problema: quien pedía algo justo
después del turno esperaba cincuenta y nueve minutos a que alguien lo mirase, sin
que nada estuviera ocupado. El intervalo de sondeo se cambia con
`SOLICITUDES_INTERVALO_SEG` (15 s por defecto); la consulta es un `TOP 1` sobre un
índice, así que sondear seguido no cuesta nada.

Sigue procesando **de una en una**: veinte importaciones a la vez son veinte
descargas compitiendo por el mismo servidor.

Dos detalles que evitan que la cola se atasque sola:

- **Apagado ordenado.** Con `docker stop` (SIGTERM) corta la importación en curso
  y devuelve esa solicitud a `pendiente` en vez de dejarla en `en curso`, que es
  un estado del que no sale sola. Por eso el servicio tiene
  `stop_grace_period: 30s`.
- **Rescate al arrancar.** Si el proceso muere de golpe —OOM, reinicio del
  servidor—, lo que quedara `en curso` vuelve a la cola en el siguiente arranque.

A mano, sin parar el servicio (el cerrojo compartido evita que se pisen):

```bash
/opt/streamflix/procesar_solicitudes.sh --dry-run   # qué haría, sin tocar nada
/opt/streamflix/procesar_solicitudes.sh --max=3     # solo las tres primeras
```

Queda además la acción **«Atender solicitudes de contenido»** en Actions, ya solo
como disparo manual: sirve para atender la cola sin entrar al servidor, y con
`simular` para verla antes.

**El worker se ejecuta dentro de la imagen del bot, nunca con el `node` del
host.** El host tiene Node 12 y el driver de SQL Server usa `??`, de la 14 para
arriba: lanzado fuera del contenedor muere con un `SyntaxError` antes de leer la
cola. Así estuvo la cola desde que se creó —el `schedule` de Actions lo lanzaba
en el host— y no se notaba porque las solicitudes se quedaban en `pendiente`,
que es indistinguible de «nadie ha pedido nada». Si algún día hay que tocarlo,
copiar el patrón de `vigilar_emision.sh`.

El servicio monta el código del bot desde el host, así que un cambio en el worker
no obliga a reconstruir la imagen — pero sí a **reiniciar el contenedor**: es un
proceso largo y se queda con el código que cargó al arrancar. `deploy.sh bot` ya
lo recrea junto al bot de Telegram.

El bot vive en **su propio repositorio** y el despliegue de la web no lo toca.
Si `/opt/streamflix/jk-anime-launcher` no es un clon de git, el `git pull` de la
acción no puede actualizarlo: avisa y sigue con la versión instalada, en vez de
abortar y dejar la cola sin atender.

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

## 3.2 Capítulos nuevos de lo que está en emisión

Dos vigilantes, uno por tipo de contenido, ambos por cron y ambos dentro de la
imagen del bot:

```cron
 5 * * * *  /opt/streamflix/vigilar_series.sh    >> /var/log/streamflix-series.log 2>&1
20 * * * *  /opt/streamflix/vigilar_emision.sh   >> /var/log/streamflix-emision.log 2>&1
50 * * * *  /opt/streamflix/auto_fix_streamflix_links.sh >> /var/log/streamflix-auto-fix.log 2>&1
```

Los minutos están repartidos a propósito: los tres importan y competirían por el
mismo servidor.

**Anime** (`vigilar_emision.js`) va con calendario: AniList publica
`nextAiringEpisode`, así que sabe que el capítulo 7 sale el sábado y espera un
margen de cortesía antes de ir a por él.

**Series** (`vigilar_series.js`) no puede: el calendario de TMDB está tras su API
y aquí no hay clave. Así que pregunta a quien de verdad manda — el sitio del que
se baja — probando el capítulo siguiente. Da igual que la televisión haya emitido
el 6 si la web de origen no lo ha subido: lo único importable es lo publicado.

```bash
/opt/streamflix/vigilar_series.sh --registrar "The Last of Us"    # empezar a vigilarla
/opt/streamflix/vigilar_series.sh --registrar "Loki" --temporada 2  # si no es la última
/opt/streamflix/vigilar_series.sh --listar                        # qué hay vigilado
/opt/streamflix/vigilar_series.sh --olvidar "The Last of Us"
/opt/streamflix/vigilar_series.sh                                 # lo que hace el cron
```

Solo vigila lo que se registre: una serie terminada no tiene nada que esperar y
revisarla cada hora es gastar el rato en preguntar por un capítulo que no existe.

Dos detalles del diseño, ambos por algo que pasó:

- **Nunca abandona una serie.** Tras `SERIES_MAX_INTENTOS` fallos (8) baja el
  ritmo a una revisión cada `SERIES_ESPERA_LARGA_H` horas (12), pero sigue
  mirando. El vigilante de anime sí abandona, y por eso *Tomb Raider King* se
  quedó una semana congelado en el capítulo 4: un error de código gastó los ocho
  intentos y la serie salió de la rotación sin que nada lo dijera. Una serie
  semanal falla ~24 veces entre capítulo y capítulo, así que ahí abandonar por
  número de fallos sería el comportamiento normal, no la excepción.
- **Tope de `SERIES_MAX_POR_VUELTA` (3) capítulos por serie y vuelta**, para que
  una con veinte pendientes no monopolice la hora y deje al resto sin revisar.
  Lo que quede sigue en la vuelta siguiente.

El estado vive en `dbo.SerieEmision` y se consulta con `--listar`: temporada
vigilada, por qué capítulo va, cuántos intentos lleva y el motivo del último.

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
