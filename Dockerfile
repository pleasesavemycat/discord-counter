# syntax=docker/dockerfile:1

# Published by .github/workflows/docker-publish.yml to
# ghcr.io/pleasesavemycat/discord-counter, built for linux/amd64 (the UGREEN
# NASync DXP line is x86_64) so the NAS only ever has to pull, never build.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# su-exec lets the entrypoint take ownership of the mounted data folder as
# root and then drop to an unprivileged uid. Needed because the NAS Docker UI
# gives you no shell to chown a bind mount from.
RUN apk add --no-cache su-exec

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/data \
 && chown -R node:node /app/data \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

ENV DATA_DIR=/app/data \
    HEARTBEAT_FILE=/tmp/heartbeat \
    PUID=1000 \
    PGID=1000

# The bot has no HTTP surface, so liveness is a heartbeat file it touches only
# while its gateway connection is READY. A process that is running but silently
# disconnected fails this and shows as unhealthy in the Docker app.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

# Starts as root only long enough to fix the data folder's ownership; the bot
# itself always runs as PUID:PGID. Set `user:` yourself to skip root entirely.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
