# Multi-stage production SagaFlow container ($0 self-hosted or hosted cloud)
# Supports SQLite (DB-per-tenant), portable JSON folders, or PostgreSQL RLS + NATS JetStream
FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace manifests first for optimal Docker layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
COPY packages/sdk/package.json packages/sdk/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci --no-audit --no-fund

COPY packages ./packages
COPY apps ./apps

RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4000
ENV ROLE=all
ENV STORAGE_DRIVER=sqlite
ENV STORAGE_ISOLATION=db-per-tenant
ENV STORAGE_PATH=/app/data
ENV QUEUE_DRIVER=local

# Create non-root user & writable data volume
RUN addgroup -S sagaflow && adduser -S sagaflow -G sagaflow \
  && mkdir -p /app/data \
  && chown -R sagaflow:sagaflow /app

COPY --from=builder --chown=sagaflow:sagaflow /app/package.json ./
COPY --from=builder --chown=sagaflow:sagaflow /app/node_modules ./node_modules
COPY --from=builder --chown=sagaflow:sagaflow /app/packages/shared/package.json packages/shared/
COPY --from=builder --chown=sagaflow:sagaflow /app/packages/shared/dist packages/shared/dist
COPY --from=builder --chown=sagaflow:sagaflow /app/packages/engine/package.json packages/engine/
COPY --from=builder --chown=sagaflow:sagaflow /app/packages/engine/dist packages/engine/dist
COPY --from=builder --chown=sagaflow:sagaflow /app/packages/sdk/package.json packages/sdk/
COPY --from=builder --chown=sagaflow:sagaflow /app/packages/sdk/dist packages/sdk/dist
COPY --from=builder --chown=sagaflow:sagaflow /app/apps/api/package.json apps/api/
COPY --from=builder --chown=sagaflow:sagaflow /app/apps/api/dist apps/api/dist
COPY --from=builder --chown=sagaflow:sagaflow /app/apps/web/dist apps/web/dist

USER sagaflow
VOLUME ["/app/data"]
EXPOSE 4000

HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "apps/api/dist/server.js"]
