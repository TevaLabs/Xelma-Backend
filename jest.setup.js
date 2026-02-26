// Load .env so DATABASE_URL and other vars are set for integration tests (auth, notifications, socket, rounds, predictions).
require('dotenv').config();

// Ensure JWT_SECRET is set so validateEnv() in src/index.ts does not process.exit(1) when tests import createApp.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-jwt-secret';
}
