const io = require('socket.io-client');

console.log('🚀 Testing WebSocket Connection...\n');

// Connect to the server (unauthenticated - for testing public events)
const socket = io('http://localhost:3000', {
  transports: ['websocket'],
  reconnectionAttempts: 3,
  reconnectionDelay: 1000,
});

socket.on('connect', () => {
  console.log('✅ Connected to server!');
  console.log('   Socket ID:', socket.id);
  
  // Join the round room to receive all round events
  console.log('\n📡 Joining "round" room...');
  socket.emit('join:round');
});

socket.on('server:hello', (data) => {
  console.log('\n👋 Received server:hello:');
  console.log('   Socket ID:', data.socketId);
  console.log('   Ping Interval:', data.pingInterval + 'ms');
  console.log('   Ping Timeout:', data.pingTimeout + 'ms');
  console.log('   Authenticated:', data.authenticated);
});

socket.on('room:joined', (data) => {
  console.log('\n✅ Joined room:', data.room);
});

socket.on('round_update', (data) => {
  console.log('\n🔄 Round Update:');
  console.log('   Round ID:', data.id);
  console.log('   Status:', data.status);
  console.log('   Mode:', data.mode);
});

socket.on('pool_update', (data) => {
  console.log('\n💰 Pool Update:');
  console.log('   Round ID:', data.roundId);
  console.log('   Pool Up:', data.poolUp);
  console.log('   Pool Down:', data.poolDown);
});

socket.on('price_update', (data) => {
  console.log('\n💵 Price Update:');
  console.log('   Asset:', data.asset);
  console.log('   Price:', data.price);
  console.log('   Timestamp:', data.timestamp);
});

socket.on('prediction:placed', (data) => {
  console.log('\n🎯 Prediction Placed:');
  console.log('   Round ID:', data.roundId);
  console.log('   Amount:', data.amount);
  console.log('   Side:', data.side);
});

socket.on('round:started', (data) => {
  console.log('\n🎬 Round Started:');
  console.log('   Round ID:', data.id);
  console.log('   Mode:', data.mode);
});

socket.on('round:resolved', (data) => {
  console.log('\n🏁 Round Resolved:');
  console.log('   Round ID:', data.id);
  console.log('   Winners:', data.winners);
});

socket.on('auth:error', (data) => {
  console.log('\n❌ Auth Error:');
  console.log('   Code:', data.code);
  console.log('   Message:', data.message);
});

socket.on('error', (error) => {
  console.log('\n❌ Error:', error);
});

socket.on('disconnect', (reason) => {
  console.log('\n👋 Disconnected:', reason);
  process.exit(0);
});

socket.on('connect_error', (error) => {
  console.log('\n❌ Connection Error:', error.message);
  process.exit(1);
});

// Keep the process running
console.log('\n⏳ Listening for events (press Ctrl+C to exit)...');
console.log('─'.repeat(50));

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down...');
  socket.disconnect();
  process.exit(0);
});
