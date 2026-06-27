import dotenv from 'dotenv';
import { createServer } from 'http';

dotenv.config();

import app from './app';
import { initWebSocket } from './socket';

const PORT = process.env.PORT || 3001;
const httpServer = createServer(app);

initWebSocket(httpServer).catch(error => {
  console.error('WebSocket initialization failed:', error);
  process.exit(1);
});

httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});