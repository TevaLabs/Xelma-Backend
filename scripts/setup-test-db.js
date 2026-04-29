#!/usr/bin/env node

/**
 * Test Database Bootstrap Script
 * 
 * Provisions and migrates the test database with a single command.
 * Idempotent and safe to rerun. Works in both local dev and CI environments.
 * 
 * Usage:
 *   npm run test:db:setup
 *   node scripts/setup-test-db.js
 * 
 * Environment Variables:
 *   DATABASE_URL - PostgreSQL connection string (from .env.test)
 *   CI - Set to 'true' in CI environments
 *   SKIP_DB_CHECK - Skip database connectivity check (for CI)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ANSI color codes for better output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logStep(step, message) {
  log(`\n${colors.bright}[${step}]${colors.reset} ${message}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, colors.green);
}

function logError(message) {
  log(`❌ ${message}`, colors.red);
}

function logWarning(message) {
  log(`⚠️  ${message}`, colors.yellow);
}

function logInfo(message) {
  log(`ℹ️  ${message}`, colors.cyan);
}

/**
 * Execute a command and return the output
 */
function exec(command, options = {}) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    });
  } catch (error) {
    if (!options.ignoreError) {
      throw error;
    }
    return null;
  }
}

/**
 * Load environment variables from .env.test
 */
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.test');
  
  if (!fs.existsSync(envPath)) {
    logError('.env.test file not found');
    logInfo('Creating .env.test with default values...');
    
    const defaultEnv = `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/xelma_ci"
JWT_SECRET="test-secret-key-for-testing"
NODE_ENV="test"
`;
    fs.writeFileSync(envPath, defaultEnv);
    logSuccess('.env.test created');
  }
  
  // Load .env.test
  require('dotenv').config({ path: envPath });
  
  if (!process.env.DATABASE_URL) {
    logError('DATABASE_URL not set in .env.test');
    process.exit(1);
  }
  
  logSuccess('Environment variables loaded');
  return process.env.DATABASE_URL;
}

/**
 * Parse PostgreSQL connection string
 */
function parseDbUrl(url) {
  try {
    const match = url.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+?)(\?.*)?$/);
    if (!match) {
      throw new Error('Invalid DATABASE_URL format');
    }
    
    const [, user, password, host, port, database] = match;
    return { user, password, host, port, database };
  } catch (error) {
    logError(`Failed to parse DATABASE_URL: ${error.message}`);
    logInfo('Expected format: postgresql://user:password@host:port/database');
    process.exit(1);
  }
}

/**
 * Check if PostgreSQL is installed and accessible
 */
function checkPostgres(dbConfig) {
  logStep('1/6', 'Checking PostgreSQL installation...');
  
  try {
    const version = exec('psql --version', { silent: true });
    logSuccess(`PostgreSQL found: ${version.trim()}`);
    return true;
  } catch (error) {
    logError('PostgreSQL (psql) not found in PATH');
    logInfo('');
    logInfo('Installation instructions:');
    logInfo('  macOS:   brew install postgresql');
    logInfo('  Ubuntu:  sudo apt-get install postgresql postgresql-contrib');
    logInfo('  Windows: Download from https://www.postgresql.org/download/windows/');
    logInfo('');
    logInfo('Or use Docker:');
    logInfo('  docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:15');
    return false;
  }
}

/**
 * Check if PostgreSQL server is running
 */
function checkPostgresRunning(dbConfig) {
  logStep('2/6', 'Checking PostgreSQL server connectivity...');
  
  const { user, password, host, port } = dbConfig;
  
  try {
    // Try to connect to postgres database (always exists)
    const pgUrl = `postgresql://${user}:${password}@${host}:${port}/postgres`;
    exec(`psql "${pgUrl}" -c "SELECT 1" > /dev/null 2>&1`, { silent: true });
    logSuccess(`PostgreSQL server is running on ${host}:${port}`);
    return true;
  } catch (error) {
    logError(`Cannot connect to PostgreSQL server at ${host}:${port}`);
    logInfo('');
    logInfo('Troubleshooting:');
    logInfo('  1. Check if PostgreSQL is running:');
    logInfo('     macOS:   brew services list | grep postgresql');
    logInfo('     Linux:   sudo systemctl status postgresql');
    logInfo('     Docker:  docker ps | grep postgres');
    logInfo('');
    logInfo('  2. Start PostgreSQL:');
    logInfo('     macOS:   brew services start postgresql');
    logInfo('     Linux:   sudo systemctl start postgresql');
    logInfo('     Docker:  docker start <container-name>');
    logInfo('');
    logInfo('  3. Verify connection settings in .env.test');
    return false;
  }
}

/**
 * Create test database if it doesn't exist
 */
function createDatabase(dbConfig) {
  logStep('3/6', 'Creating test database...');
  
  const { user, password, host, port, database } = dbConfig;
  const pgUrl = `postgresql://${user}:${password}@${host}:${port}/postgres`;
  
  try {
    // Check if database exists
    const checkQuery = `SELECT 1 FROM pg_database WHERE datname='${database}'`;
    const result = exec(`psql "${pgUrl}" -t -c "${checkQuery}"`, { silent: true });
    
    if (result && result.trim() === '1') {
      logInfo(`Database '${database}' already exists`);
      return true;
    }
    
    // Create database
    logInfo(`Creating database '${database}'...`);
    exec(`psql "${pgUrl}" -c "CREATE DATABASE ${database}"`);
    logSuccess(`Database '${database}' created`);
    return true;
  } catch (error) {
    logError(`Failed to create database: ${error.message}`);
    logInfo('');
    logInfo('Manual creation:');
    logInfo(`  psql -U ${user} -h ${host} -p ${port} -c "CREATE DATABASE ${database}"`);
    return false;
  }
}

/**
 * Run Prisma migrations
 */
function runMigrations() {
  logStep('4/6', 'Running Prisma migrations...');
  
  try {
    // Generate Prisma Client first
    logInfo('Generating Prisma Client...');
    exec('npx prisma generate', { silent: false });
    
    // Run migrations
    logInfo('Applying database migrations...');
    exec('npx prisma migrate deploy', { silent: false });
    
    logSuccess('Migrations completed successfully');
    return true;
  } catch (error) {
    logError('Migration failed');
    logInfo('');
    logInfo('Troubleshooting:');
    logInfo('  1. Check if migrations directory exists: prisma/migrations/');
    logInfo('  2. Verify DATABASE_URL in .env.test');
    logInfo('  3. Check migration files for syntax errors');
    logInfo('');
    logInfo('Manual migration:');
    logInfo('  npx prisma migrate deploy');
    return false;
  }
}

/**
 * Seed the database with test data
 */
function seedDatabase() {
  logStep('5/6', 'Seeding test data...');
  
  const seedPath = path.join(__dirname, '..', 'prisma', 'seed.ts');
  
  if (!fs.existsSync(seedPath)) {
    logWarning('Seed file not found, skipping seeding');
    return true;
  }
  
  try {
    logInfo('Running seed script...');
    exec('npx prisma db seed', { silent: false });
    logSuccess('Database seeded successfully');
    return true;
  } catch (error) {
    logWarning('Seeding failed (non-critical)');
    logInfo('You can seed manually later with: npx prisma db seed');
    return true; // Non-critical, don't fail the setup
  }
}

/**
 * Verify database setup
 */
function verifySetup(dbConfig) {
  logStep('6/6', 'Verifying database setup...');
  
  const { database } = dbConfig;
  
  try {
    // Check if we can query the database
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
    // Try a simple query
    prisma.$queryRaw`SELECT 1`.then(() => {
      logSuccess('Database connection verified');
      return prisma.$disconnect();
    }).then(() => {
      logSuccess('Database setup complete! 🎉');
      logInfo('');
      logInfo('Next steps:');
      logInfo('  Run tests:        npm test');
      logInfo('  Run unit tests:   npm run test:unit');
      logInfo('  Run integration:  npm run test:integration');
      logInfo('');
    }).catch((error) => {
      logError(`Verification failed: ${error.message}`);
      process.exit(1);
    });
    
    return true;
  } catch (error) {
    logError(`Verification failed: ${error.message}`);
    return false;
  }
}

/**
 * Main setup function
 */
async function main() {
  log('\n' + '='.repeat(60), colors.bright);
  log('  Test Database Bootstrap', colors.bright + colors.cyan);
  log('='.repeat(60) + '\n', colors.bright);
  
  const isCI = process.env.CI === 'true';
  const skipCheck = process.env.SKIP_DB_CHECK === 'true';
  
  if (isCI) {
    logInfo('Running in CI environment');
  }
  
  // Load environment
  const dbUrl = loadEnv();
  const dbConfig = parseDbUrl(dbUrl);
  
  logInfo(`Target database: ${dbConfig.database}`);
  logInfo(`Host: ${dbConfig.host}:${dbConfig.port}`);
  logInfo('');
  
  // Check prerequisites
  if (!skipCheck) {
    if (!checkPostgres(dbConfig)) {
      process.exit(1);
    }
    
    if (!checkPostgresRunning(dbConfig)) {
      process.exit(1);
    }
  } else {
    logWarning('Skipping database connectivity checks (SKIP_DB_CHECK=true)');
  }
  
  // Create database
  if (!createDatabase(dbConfig)) {
    process.exit(1);
  }
  
  // Run migrations
  if (!runMigrations()) {
    process.exit(1);
  }
  
  // Seed database
  seedDatabase();
  
  // Verify setup
  verifySetup(dbConfig);
}

// Run the script
if (require.main === module) {
  main().catch((error) => {
    logError(`Unexpected error: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
