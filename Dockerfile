FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

FROM deps AS build
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --omit=dev && npm install prisma@^5.8.0 --no-save
COPY prisma ./prisma
COPY scripts ./scripts
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

# Health probe path.  The full app (dist/index.js) serves a detailed health
# check at GET /health; the hackathon app (dist/server.js) serves a
# lightweight check at GET /api/health.  Override HEALTHCHECK_PATH at
# runtime when switching modes (the entrypoint also sets this automatically
# when API_MODE=hackathon).
ENV HEALTHCHECK_PATH=/health
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}${HEALTHCHECK_PATH} || exit 1

ENTRYPOINT ["/entrypoint.sh"]
