# syntax=docker/dockerfile:1
# One image for the whole app: the Express API also serves the built frontend
# (FRONTEND_BUILD_DIRECTORY), so the page calls the API on its own origin.
# `docker compose --profile app up -d --build` runs it next to PostgreSQL;
# see docs/deployment.md.

FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.js ./
COPY public ./public
COPY src ./src
# Baked into the bundle at build time: "same-origin" makes the page call the
# server that served it. A token here would ship to every browser, so it is
# empty unless the image is built for a single trusted user.
ARG VITE_DOMAIN=same-origin
ARG VITE_API_AUTH_TOKEN=
ENV VITE_DOMAIN=${VITE_DOMAIN} VITE_API_AUTH_TOKEN=${VITE_API_AUTH_TOKEN}
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=5001 \
    FRONTEND_BUILD_DIRECTORY=/app/build \
    RAG_DATA_DIRECTORY=/data/rag-data \
    UPLOADS_DIRECTORY=/data/uploads \
    UPLOAD_SESSION_DIRECTORY=/data/upload-sessions \
    FEEDBACK_DIRECTORY=/data/feedback
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
# --legacy-peer-deps: @qdrant/js-client-rest declares typescript as a peer,
# which npm 11 leaves out of the lock file and npm 10.9 then insists on. The
# client needs no TypeScript at runtime.
RUN npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund
COPY server/ ./
COPY --from=web /app/build /app/build
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5001
# Liveness on the port each role listens on (resolveRolePort): /livez where
# routes/system.js serves it (all, api, agent); the retrieval and model-gateway
# apps have no /livez, so there it is their own /health.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "const e = process.env, role = String(e.ARCHIVE_RAG_ROLE || '').trim().toLowerCase(), gw = role === 'model-gateway', tier = gw || role === 'retrieval'; const port = (gw && parseInt(e.MODEL_GATEWAY_PORT, 10)) || parseInt(e.PORT, 10) || (gw ? 5003 : role === 'retrieval' ? 5002 : 5001); fetch('http://127.0.0.1:' + port + (tier ? '/health' : '/livez')).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.js"]
