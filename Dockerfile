# syntax=docker/dockerfile:1

# Built on the NAS itself (`docker compose up -d --build`), so no cross-platform
# buildx dance is needed — the UGREEN NASync DXP line is x86_64.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# State lives on a mounted volume. Create the mount point owned by the
# unprivileged `node` user (uid 1000) so a fresh named volume inherits the
# right ownership; for a bind mount the host folder's ownership wins, which
# the entrypoint checks and explains before the bot starts.
RUN mkdir -p /app/data \
 && chown -R node:node /app/data \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

USER node

ENV DATA_DIR=/app/data \
    HEARTBEAT_FILE=/tmp/heartbeat

# The bot has no HTTP surface, so liveness is a heartbeat file it touches only
# while its gateway connection is READY. A process that is running but silently
# disconnected fails this, and `restart: unless-stopped` brings it back.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
