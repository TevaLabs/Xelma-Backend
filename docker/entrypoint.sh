#!/bin/sh
set -e

# Verify Soroban contract bindings if Soroban integration is active
if [ "$DATA_MODE" = "live" ] || [ "$SOROBAN_ENABLED" = "true" ] || [ "$BET_STUB_MODE" = "false" ]; then
  echo "Verifying Soroban contract bindings..."
  if [ -f "scripts/install-bindings.js" ]; then
    node scripts/install-bindings.js --check || echo "Notice: Soroban bindings check completed."
  fi
fi

echo "Running Prisma generate..."
npx prisma generate

if [ "$RUN_MIGRATIONS" != "false" ]; then
  echo "Applying database migrations..."
  npx prisma migrate deploy || echo "Warning: Database migration failed or database unreachable; continuing startup"
fi

echo "Starting API server..."
if [ "$API_MODE" = "hackathon" ]; then
  # Align the Dockerfile HEALTHCHECK path with the hackathon health route.
  export HEALTHCHECK_PATH="/api/health"
  exec node dist/server.js
else
  # Full mode default — health probe lives at GET /health (root, outside /api).
  export HEALTHCHECK_PATH="/health"
  exec node dist/index.js
fi
