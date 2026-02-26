import { jest, describe, it, expect, beforeAll, afterAll } from '@jest/globals';

// Mock SorobanService before any other imports that might trigger its loading
jest.mock('../services/soroban.service', () => ({
    __esModule: true,
    default: {
        initialized: false,
        ensureInitialized: () => { },
        createRound: async () => 'test-round-id',
        placeBet: async () => { },
        resolveRound: async () => { },
        getActiveRound: async () => null,
        mintInitial: async () => 1000,
        getBalance: async () => 1000,
    }
}));

import { prisma } from '../lib/prisma';
import request from 'supertest';
import { createApp } from '../index';
import { Express } from 'express';
import * as StellarSdk from '@stellar/stellar-sdk';
import dotenv from 'dotenv';

dotenv.config();

describe('Auth Race Condition Prevention', () => {
    let app: Express;
    const keypair = StellarSdk.Keypair.random();
    const walletAddress = keypair.publicKey();

    beforeAll(async () => {
        app = createApp();
    });

    afterAll(async () => {
        // Cleanup
        const user = await prisma.user.findUnique({ where: { walletAddress } });
        if (user) {
            await prisma.transaction.deleteMany({ where: { userId: user.id } });
            await prisma.authChallenge.deleteMany({ where: { userId: user.id } });
            await prisma.user.delete({ where: { id: user.id } });
        }
        await prisma.authChallenge.deleteMany({ where: { walletAddress } });
        await prisma.$disconnect();
    });

    it('should prevent multiple successful connects with the same challenge', async () => {
        // 1. Get a challenge
        const challengeRes = await request(app)
            .post('/api/auth/challenge')
            .send({ walletAddress });

        expect(challengeRes.status).toBe(200);
        const { challenge } = challengeRes.body;

        // 2. Sign the challenge
        const signature = keypair.sign(Buffer.from(challenge, 'utf8')).toString('base64');

        // 3. Send two concurrent requests
        const res1Promise = request(app).post('/api/auth/connect').send({ walletAddress, challenge, signature });
        const res2Promise = request(app).post('/api/auth/connect').send({ walletAddress, challenge, signature });

        const [res1, res2] = await Promise.all([res1Promise, res2Promise]);

        // 4. Assert that exactly one succeeded
        const statuses = [res1.status, res2.status];
        const successes = statuses.filter(s => s === 200).length;
        const failures = statuses.filter(s => s === 401).length;

        // Log for debugging if it fails (it should fail before the fix)
        if (successes !== 1) {
            console.log('Concurrent request statuses:', statuses);
            console.log('Response 1:', res1.body);
            console.log('Response 2:', res2.body);
        }

        expect(successes).toBe(1);
        expect(failures).toBe(1);

        // One of them should have the "already used" message
        const errorMessages = [res1.body.message, res2.body.message];
        expect(errorMessages).toContain('Challenge has already been used');
    });
});
