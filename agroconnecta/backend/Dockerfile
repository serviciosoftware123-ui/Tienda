# API de AgroConnecta — Node.js 22 (Alpine)
FROM node:22-alpine

ENV NODE_ENV=production \
    UPLOAD_DIR=/data/uploads \
    DOCS_DIR=/data/privado \
    PORT=3000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Carpeta de imágenes subidas (volumen) y usuario sin privilegios
RUN mkdir -p /data/uploads /data/privado && chmod 700 /data/privado && chown -R node:node /data
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=8 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "src/server.js"]
