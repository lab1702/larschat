const express = require('express');
require('express-async-errors');
const cookieParser = require('cookie-parser');
const http = require('http');
const path = require('path');
const { setupWebSocket } = require('./ws');
const { cleanupExpired } = require('./auth');

const fs = require('fs');

const app = express();
const server = http.createServer(app);

// Base path for reverse-proxy sub-path deployments (e.g. BASE_PATH=/chat/)
const BASE_PATH = process.env.BASE_PATH || '/';
if (!/^\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=\-]*$/.test(BASE_PATH)) {
  console.error('Invalid BASE_PATH: must start with / and contain only URL-safe characters');
  process.exit(1);
}
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('<head>', `<head>\n  <base href="${BASE_PATH}">`);

// Trust proxy by default (needed for correct req.secure behind reverse proxies).
// Set TRUST_PROXY=0 to disable.
if (process.env.TRUST_PROXY !== '0') app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "script-src 'self'",
  ].join('; '));
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/dm', require('./routes/dm'));
app.use('/api/user', require('./routes/user'));

// SPA fallback (exclude API paths)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.type('html').send(indexHtml);
});

// Error-handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// WebSocket
const wss = setupWebSocket(server);

// Cleanup expired sessions every hour
setInterval(cleanupExpired, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`LarsChat running on ${HOST}:${PORT}`);
});

// Graceful shutdown
function shutdown() {
  console.log('Shutting down...');
  wss.close(() => {
    server.close(() => {
      const db = require('./db');
      db.close();
      process.exit(0);
    });
    // Close keep-alive connections that would otherwise hold the server open
    server.closeAllConnections();
  });
  // Force exit after 5s if graceful shutdown stalls
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
