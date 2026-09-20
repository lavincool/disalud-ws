# syntax=docker/dockerfile:1

# Se compila con bun (rápido y consistente con disalud-org) pero se ejecuta con
# Node: engine.io y socket.io están mucho más rodados sobre Node, y este proceso
# mantiene conexiones abiertas durante horas.

FROM oven/bun:1.4.2-slim AS deps-prod
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.2-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Usuario sin privilegios: la imagen de node trae `node` (uid 1000) ya creado.
COPY --from=deps-prod --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 8080

# El healthcheck usa el fetch nativo de Node para no añadir curl a la imagen.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
