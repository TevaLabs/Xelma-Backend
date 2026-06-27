#!/bin/sh
set -e

echo "Running Prisma generate..."
npx prisma generate

echo "Applying database migrations..."
npx prisma migrate deploy

echo "Starting API server..."
exec node dist/index.js
