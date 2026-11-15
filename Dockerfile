# WarMind: one Node process serving the game and the API, SQLite on /data.
#
#   docker build --build-arg BUILD_COMMIT=$(git rev-parse --short HEAD) -t warmind .
#   docker run -p 3000:3000 -v warmind-data:/data -e SESSION_SECRET=... warmind

# --- Dependencies: production only; bcrypt and better-sqlite3 are native
FROM node:24-bookworm-slim AS deps
WORKDIR /app
# Build tools, in case no prebuilt binary matches this platform
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Runtime: no build tools, unprivileged user
FROM node:24-bookworm-slim
WORKDIR /app
ARG BUILD_COMMIT=""
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/warmind.db \
    BUILD_COMMIT=$BUILD_COMMIT
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY client ./client
COPY engine ./engine
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/index.js"]
