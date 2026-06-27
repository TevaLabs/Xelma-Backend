const { io } = require('socket.io-client');

const url = process.env.WS_URL || 'http://localhost:3001';
const token = process.env.SOCKET_TOKEN || null;

const socket = io(url, {
  auth: token ? { token } : undefined,
  transports: ['websocket'],
  reconnectionAttempts: 5,
});

socket.on('connect', () => {
  console.log('Connected to', url, 'as', socket.id);
  socket.emit('join:round');
  socket.emit('join:chat');
  socket.emit('join:notifications');
});

socket.on('server:hello', data => {
  console.log('server:hello', data);
});

socket.on('round:started', data => {
  console.log('round:started', data);
});

socket.on('price:update', data => {
  console.log('price:update', data);
});

socket.on('chat:message', data => {
  console.log('chat:message', data);
});

socket.on('notification:new', data => {
  console.log('notification:new', data);
});

socket.on('disconnect', reason => {
  console.log('Disconnected:', reason);
});

socket.on('connect_error', error => {
  console.error('Connect error:', error.message || error);
});
