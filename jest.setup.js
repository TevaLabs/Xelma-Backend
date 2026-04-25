// Load test-specific env first when present, and never override variables already
// provided by the shell/CI job.
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '.env.test'), override: false });
dotenv.config({ override: false });

// Ensure JWT_SECRET is set so validateEnv() in src/index.ts does not process.exit(1) when tests import createApp.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'test-jwt-secret';
}

const DUMMY_DB_URL = 'postgresql://test_user:test_pass@localhost:5432/test_db?schema=public';

// Ensure DATABASE_URL is set so src/config/index.ts validation passes in unit tests
// that mock Prisma and do not require a real database.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DUMMY_DB_URL;
}

// Global helper to check if a real DB is available
global.hasDb = Boolean(
  process.env.DATABASE_URL && 
  process.env.DATABASE_URL !== DUMMY_DB_URL &&
  !process.env.DATABASE_URL.includes('test_pass@localhost')
);
