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

ENV NODE_ENV=production
EXPOSE 3000

# Sin usuario root dentro del contenedor.
USER node

CMD ["node", "server/index.js"]
