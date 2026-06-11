#!/usr/bin/env node

/**
 * Test Database Reset Script
 * 
 * Drops and recreates the test database from scratch.
 * Combines teardown and setup in a single command.
 * 
 * Usage:
 *   npm run test:db:reset
 *   node scripts/reset-test-db.js
 */

const { execSync } = require('child_process');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  cyan: '\x1b[36m',
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

async function main() {
  log('\n' + '='.repeat(60), colors.bright);
  log('  Test Database Reset', colors.bright + colors.cyan);
  log('='.repeat(60) + '\n', colors.bright);
  
  try {
    // Set FORCE_TEARDOWN for non-interactive execution
    process.env.FORCE_TEARDOWN = 'true';
    
    // Run teardown
    log('\n📦 Step 1: Tearing down existing database...\n', colors.cyan);
    execSync('node scripts/teardown-test-db.js', { stdio: 'inherit' });
    
    // Run setup
    log('\n📦 Step 2: Setting up fresh database...\n', colors.cyan);
    execSync('node scripts/setup-test-db.js', { stdio: 'inherit' });
    
    log('\n✅ Database reset complete! 🎉\n', colors.bright);
  } catch (error) {
    console.error('\n❌ Reset failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
