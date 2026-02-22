const { findSession } = require('./auth');

const COOKIE_PATH = process.env.BASE_PATH || '/';

const CLEAR_COOKIE_OPTS = { path: COOKIE_PATH, httpOnly: true, sameSite: 'lax' };

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = findSession(token);

  if (!session) {
    res.clearCookie('session', CLEAR_COOKIE_OPTS);
    return res.status(401).json({ error: 'Session expired' });
  }

  req.name = session.name;
  next();
}

// Per-user rate limiter for message posting
const messageTimestamps = new Map();
const MSG_RATE_WINDOW = 60 * 1000; // 1 minute
const MSG_RATE_MAX = 30; // max messages per window

function messageRateLimit(req, res, next) {
  const name = req.name;
  const now = Date.now();
  let timestamps = messageTimestamps.get(name);

  if (!timestamps) {
    timestamps = [];
    messageTimestamps.set(name, timestamps);
  }

  // Remove timestamps outside the window
  while (timestamps.length > 0 && timestamps[0] <= now - MSG_RATE_WINDOW) {
    timestamps.shift();
  }

  if (timestamps.length >= MSG_RATE_MAX) {
    return res.status(429).json({ error: 'Too many messages. Please slow down.' });
  }

  timestamps.push(now);
  next();
}

module.exports = { requireAuth, messageRateLimit, COOKIE_PATH, CLEAR_COOKIE_OPTS };
