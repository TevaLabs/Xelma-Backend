FROM node:22-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
# The local `file:vendor/xelma-bindings` dependency must be present before
# npm installs dependencies, otherwise npm creates a broken link in the image.
COPY vendor/xelma-bindings ./vendor/xelma-bindings
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
# Keep the vendored package in the runtime image as well as the dependency
# stage: npm resolves it through package.json's `file:` specifier.
COPY vendor/xelma-bindings ./vendor/xelma-bindings
ARG SOROBAN_ENABLED=false
RUN npm ci --omit=dev \
  && npm install prisma@^5.8.0 --no-save \
  && if [ "$SOROBAN_ENABLED" = "true" ]; then \
       node -e "require('@tevalabs/xelma-bindings')"; \
     fi
COPY prisma ./prisma
COPY scripts ./scripts
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

# The healthcheck process does not inherit variables exported by entrypoint.sh.
# Select the real route from the container's configured API_MODE instead.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD if [ "$API_MODE" = "hackathon" ]; then wget -qO- "http://127.0.0.1:${PORT:-3000}/api/health"; else wget -qO- "http://127.0.0.1:${PORT:-3000}/health"; fi || exit 1

ENTRYPOINT ["/entrypoint.sh"]
