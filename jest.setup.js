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
