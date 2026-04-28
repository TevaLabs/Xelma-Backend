#!/usr/bin/env node

/**
 * Test Database Teardown Script
 * 
 * Safely drops the test database and cleans up resources.
 * Useful for resetting the test environment.
 * 
 * Usage:
 *   npm run test:db:teardown
 *   node scripts/teardown-test-db.js
 */

const { execSync } = require('child_process');
const path = require('path');

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
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

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.test');
  require('dotenv').config({ path: envPath });
  
  if (!process.env.DATABASE_URL) {
    logError('DATABASE_URL not set in .env.test');
    process.exit(1);
  }
  
  return process.env.DATABASE_URL;
}

function parseDbUrl(url) {
  const match = url.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+?)(\?.*)?$/);
  if (!match) {
    logError('Invalid DATABASE_URL format');
    process.exit(1);
  }
  
  const [, user, password, host, port, database] = match;
  return { user, password, host, port, database };
}

function dropDatabase(dbConfig) {
  const { user, password, host, port, database } = dbConfig;
  const pgUrl = `postgresql://${user}:${password}@${host}:${port}/postgres`;
  
  // Safety check: don't drop production databases
  const dangerousNames = ['production', 'prod', 'main', 'postgres'];
  if (dangerousNames.some(name => database.toLowerCase().includes(name))) {
    logError(`Refusing to drop database '${database}' - name suggests production database`);
    logInfo('Test databases should have names like: test, ci, dev, staging');
    process.exit(1);
  }
  
  try {
    // Terminate existing connections
    logInfo('Terminating existing connections...');
    const terminateQuery = `
      SELECT pg_terminate_backend(pg_stat_activity.pid)
      FROM pg_stat_activity
      WHERE pg_stat_activity.datname = '${database}'
        AND pid <> pg_backend_pid()
    `;
    exec(`psql "${pgUrl}" -c "${terminateQuery}"`, { silent: true, ignoreError: true });
    
    // Drop database
    logInfo(`Dropping database '${database}'...`);
    exec(`psql "${pgUrl}" -c "DROP DATABASE IF EXISTS ${database}"`);
    logSuccess(`Database '${database}' dropped successfully`);
    return true;
  } catch (error) {
    logError(`Failed to drop database: ${error.message}`);
    return false;
  }
}

async function main() {
  log('\n' + '='.repeat(60), colors.bright);
  log('  Test Database Teardown', colors.bright + colors.cyan);
  log('='.repeat(60) + '\n', colors.bright);
  
  const dbUrl = loadEnv();
  const dbConfig = parseDbUrl(dbUrl);
  
  logWarning(`This will DROP the database: ${dbConfig.database}`);
  logInfo(`Host: ${dbConfig.host}:${dbConfig.port}`);
  logInfo('');
  
  // In CI, proceed automatically
  if (process.env.CI !== 'true' && !process.env.FORCE_TEARDOWN) {
    logWarning('Set FORCE_TEARDOWN=true to proceed in non-CI environments');
    logInfo('Example: FORCE_TEARDOWN=true npm run test:db:teardown');
    process.exit(0);
  }
  
  if (dropDatabase(dbConfig)) {
    logSuccess('Teardown complete! 🎉');
    logInfo('');
    logInfo('To recreate the database, run:');
    logInfo('  npm run test:db:setup');
  } else {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    logError(`Unexpected error: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
}

module.exports = { main };
