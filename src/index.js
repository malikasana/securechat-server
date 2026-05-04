require('dotenv').config();
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const config = require('./config');
const { getDb } = require('./db/database');
const apiRouter = require('./routes/api');
const { setupWebSocket } = require('./websocket/handler');
const { cleanupExpiredRequests } = require('./controllers/consensus');

const app = express();
app.use(express.json());

// CORS — allow any origin (clients are native apps / different origins)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-member-id, x-signature, x-timestamp');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/api', apiRouter);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'SecureChat server running' });
});

// Create HTTP server
const server = http.createServer(app);

// Attach WebSocket server
const wss = new WebSocket.Server({ server });
setupWebSocket(wss);

// Startup: clean up expired join requests
const db = getDb();
cleanupExpiredRequests();

// Hourly cleanup
setInterval(cleanupExpiredRequests, 60 * 60 * 1000);

// Validate founder key is configured
if (!config.FOUNDER_KEY) {
  console.warn('[WARN] FOUNDER_KEY is not set in .env — founder registration will not work');
}

server.listen(config.PORT, () => {
  console.log(`[SecureChat] Server running on port ${config.PORT}`);
  console.log(`[SecureChat] Server name: ${config.SERVER_NAME}`);

  const founderSet = db.prepare("SELECT value FROM server_info WHERE key = 'founder_set'").get();
  if (founderSet && founderSet.value === 'true') {
    console.log('[SecureChat] Founder already registered — registration closed');
  } else {
    console.log('[SecureChat] Awaiting founder registration');
  }
});
