# Imagen de la aplicación web. El importador (jk-anime-launcher) corre aparte,
# porque se ejecuta a demanda y no como servicio.
FROM node:20-alpine

WORKDIR /app

# Las dependencias se copian primero para que la capa se reutilice mientras no
# cambien, y el código de la app no obligue a reinstalar en cada despliegue.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY media ./media

# El contenedor corre como `node`, no como root, así que todo lo copiado tiene
# que ser legible por cualquiera. Los modos vienen del servidor de despliegue y
# ahí basta con que una carpeta llegue sin permiso de entrada (drwxr--r--) para
# que Express conteste 500 a cada fichero de dentro: sirve el HTML, pero las
# imágenes que enlaza dan error y no hay nada en el HTML que lo delate.
# `a+rX` añade lectura a todo y ejecución solo a los directorios.
RUN chmod -R a+rX /app/server /app/public /app/media

ENV NODE_ENV=production
EXPOSE 3000

# Sin usuario root dentro del contenedor.
USER node

CMD ["node", "server/index.js"]
