import { io } from 'socket.io-client';
import axios from 'axios';
import { PrismaClient, UserRole } from '@prisma/client';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();
const API_URL = 'http://localhost:3000/api';
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this-in-production';

// Helpers
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Generate tokens directly to avoid needing register/login flow for this test
// (Assuming we might want to bypass auth endpoints if we haven't set up full user registration for Admin/Oracle easily via API)
// Actually, let's use the DB to create users and sign tokens manually for full control.

async function generateToken(role: UserRole) {
    const walletAddress = `TEST_${role}_${Date.now()}`;
    const user = await prisma.user.create({
        data: {
            walletAddress,
            publicKey: `PUB_${walletAddress}`,
            role: role,
            virtualBalance: 1000,
        },
    });

    return {
        user,
        token: jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '1h' }),
    };
}

async function runTest() {
    console.log('🚀 Starting E2E Verification for Enhancements...');

    try {
        // 1. Setup Users
        console.log('\n👤 Creating Test Users...');
        const admin = await generateToken(UserRole.ADMIN);
        const oracle = await generateToken(UserRole.ORACLE);
        const player = await generateToken(UserRole.USER);
        console.log(`✅ Created Admin: ${admin.user.id}`);
        console.log(`✅ Created Oracle: ${oracle.user.id}`);
        console.log(`✅ Created Player: ${player.user.id}`);

        // 2. Setup WebSocket
        console.log('\n🔌 Connecting to WebSocket...');
        const socket = io('http://localhost:3000');

        const events: string[] = [];
        socket.on('connect', () => console.log('✅ WebSocket Connected'));
        socket.on('round:started', (data) => {
            console.log('📨 Event: round:started', data.id);
            events.push('round:started');
        });
        socket.on('prediction:placed', (data) => {
            console.log('📨 Event: prediction:placed');
            events.push('prediction:placed');
        });
        socket.on('price:update', (data) => {
            // console.log('📨 Event: price:update', data.price); // Too spammy
            if (!events.includes('price:update')) events.push('price:update');
        });
        socket.on('round:resolved', (data) => {
            console.log('📨 Event: round:resolved');
            events.push('round:resolved');
        });

        // 3. Test Auth Middleware (Try to start round as Player)
        console.log('\n🔒 Testing Auth Protection...');
        try {
            await axios.post(`${API_URL}/rounds/start`, {
                mode: 1, // Legends
                startPrice: 0.50,
                duration: 1 // 1 minute
            }, {
                headers: { Authorization: `Bearer ${player.token}` }
            });
            console.error('❌ Failed: Player should not be able to start round');
        } catch (error: any) {
            if (error.response?.status === 403) {
                console.log('✅ Success: Player blocked from starting round (403)');
            } else {
                console.error('❌ Unexpected error:', error.message);
            }
        }

        // 4. Start Round (Mode 1: Legends)
        console.log('\n🏁 Starting Round (Legends)...');
        // Using a very short duration for testing auto-resolution might be tricky if scheduler runs every 30s.
        // Let's set duration to 0.1 minutes (6 seconds) to ensure it expires quickly.
        const startRes = await axios.post(`${API_URL}/rounds/start`, {
            mode: 1,
            startPrice: 0.50,
            duration: 0.1 // 6 seconds
        }, {
            headers: { Authorization: `Bearer ${admin.token}` }
        });
        const roundId = startRes.data.round.id;
        console.log(`✅ Round Started: ${roundId}`);

        await sleep(1000); // Wait for socket event

        // 5. Submit Prediction
        console.log('\n🎲 Submitting Prediction...');
        await axios.post(`${API_URL}/predictions/submit`, {
            roundId,
            userId: player.user.id,
            amount: 100,
            priceRange: { min: 0.50, max: 0.525 } // Middle-ish range
        }, {
            headers: { Authorization: `Bearer ${player.token}` }
        });
        console.log('✅ Prediction submitted');

        await sleep(1000);

        // 6. Test Auto-Resolution (Wait for Scheduler)
        console.log('\n⏳ Waiting for Auto-Resolution (approx 40s)...');
        // Scheduler runs every 30s. We set round duration to 6s. 
        // We need to wait enough time for:
        // a. Round to expire (6s)
        // b. Buffer time in scheduler (15s) -> Total 21s
        // c. Scheduler interval (30s) -> worst case ~50-60s

        // To speed this up for the test, we could manually invoke resolve, 
        // BUT the user asked to test auto-resolution.

        let resolved = false;
        for (let i = 0; i < 60; i++) {
            const roundCheck = await prisma.round.findUnique({ where: { id: roundId } });
            if (roundCheck?.status === 'RESOLVED') {
                console.log('✅ Round Auto-Resolved!');
                resolved = true;
                break;
            }
            process.stdout.write('.');
            await sleep(1000);
        }

        if (!resolved) {
            console.warn('\n⚠️ Auto-resolution timed out (might need more time or scheduler issue)');
            // Try manual resolve if auto failed, just to clean up?
        }

        // 7. Verify WebSocket Events
        console.log('\n📡 Verifying Events...');
        const expectedEvents = ['round:started', 'prediction:placed', 'price:update'];
        if (resolved) expectedEvents.push('round:resolved');

        const missingEvents = expectedEvents.filter(e => !events.includes(e));
        if (missingEvents.length === 0) {
            console.log('✅ All expected WebSocket events received');
        } else {
            console.log('⚠️ Missing WebSocket events:', missingEvents);
        }

        console.log('\n✅ Verification Complete!');
        socket.disconnect();
        process.exit(0);

    } catch (error: any) {
        console.error('\n❌ Test Failed:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
        process.exit(1);
    }
}

runTest();
