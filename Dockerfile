# syntax=docker/dockerfile:1
# Build: npm ci + tsc; ship only the compiled JS and production deps.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config ./config
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data

# Every flag of `npm run node` is an L1_* env var (src/node/settings.ts).
# RPC binds to all container interfaces; the node refuses to start that way
# without TLS (L1_RPC_TLS_CERT/KEY) or an explicit L1_RPC_ALLOW_INSECURE=true
# -- docker-compose.yml sets the latter because it only publishes RPC on the
# host's loopback.
ENV L1_DATA_DIR=/data \
    L1_PORT=8001 \
    L1_RPC_PORT=9001 \
    L1_RPC_BIND=0.0.0.0
EXPOSE 8001 9001

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "dist/scripts/healthcheck.js"]

ENTRYPOINT ["node", "dist/src/node/main.js"]
