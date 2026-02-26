const express = require('express');
require('express-async-errors');
const cookieParser = require('cookie-parser');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { setupWebSocket } = require('./ws');
const { cleanupExpired } = require('./auth');
const { BASE_PATH } = require('./middleware');

const app = express();
const server = http.createServer(app);
const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replace('<head>', `<head>\n  <base href="${BASE_PATH}">`);

// Trust proxy by default (needed for correct req.secure behind reverse proxies).
// Set TRUST_PROXY=0 to disable.
if (process.env.TRUST_PROXY !== '0') app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Security headers
app.use((req, res, next) => {
  if (req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "script-src 'self'",
  ].join('; '));
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  maxAge: '1d',
  setHeaders(res, filePath) {
    if (path.basename(filePath) === 'index.html') {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// CSRF protection: API mutation requests must include a custom header.
// HTML forms cannot set custom headers, blocking cross-site form submissions.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'fetch') {
    return res.status(403).json({ error: 'Missing required header' });
  }
  next();
});

// Health check (no auth required)
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/channels', require('./routes/channels'));
app.use('/api/dm', require('./routes/dm'));
app.use('/api/user', require('./routes/user'));

// SPA fallback + catch-all 404
app.use((req, res) => {
  if (!req.path.startsWith('/api/') && req.method === 'GET') {
    return res.type('html').send(indexHtml);
  }
  res.status(404).json({ error: 'Not found' });
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
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
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
