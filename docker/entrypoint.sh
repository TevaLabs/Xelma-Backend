#!/bin/sh
set -e

# Verify Soroban contract bindings if Soroban integration is active. This is a
# runtime check because the image can be built as API-only and enabled later
# with environment variables.
if [ "$DATA_MODE" = "live" ] || [ "$SOROBAN_ENABLED" = "true" ] || [ "$BET_STUB_MODE" = "false" ] || [ -n "$SOROBAN_CONTRACT_ID" ]; then
  echo "Verifying Soroban contract bindings..."
  node -e "require('@tevalabs/xelma-bindings')"
  node scripts/install-bindings.js --check
fi

echo "Running Prisma generate..."
npx prisma generate

if [ "$RUN_MIGRATIONS" != "false" ]; then
  echo "Applying database migrations..."
  npx prisma migrate deploy || echo "Warning: Database migration failed or database unreachable; continuing startup"
fi

echo "Starting API server..."
if [ "$API_MODE" = "hackathon" ]; then
  exec node dist/server.js
else
  exec node dist/index.js
fi
