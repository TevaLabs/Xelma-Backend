require('dotenv').config({ path: '.env.test' });

// Set test environment variables with mock database
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/xelma_test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-testing-only';
process.env.NODE_ENV = 'test';
process.env.SOROBAN_CONTRACT_ID = 'test-contract';
process.env.SOROBAN_ADMIN_SECRET = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
process.env.SOROBAN_ORACLE_SECRET = 'SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
