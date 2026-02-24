const { findSession } = require('./auth');

const BASE_PATH = process.env.BASE_PATH || '/';
if (!/^\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=\-]*$/.test(BASE_PATH)) {
  console.error('Invalid BASE_PATH: must start with / and contain only URL-safe characters');
  process.exit(1);
}

const COOKIE_PATH = BASE_PATH;

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
const MSG_RATE_MAP_MAX = 10000; // cap map size to prevent memory exhaustion

// Periodically clean up stale message rate limit entries
setInterval(() => {
  const cutoff = Date.now() - MSG_RATE_WINDOW;
  for (const [name, timestamps] of messageTimestamps) {
    if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
      messageTimestamps.delete(name);
    }
  }
}, 60 * 1000);

function messageRateLimit(req, res, next) {
  const name = req.name;
  const now = Date.now();
  let timestamps = messageTimestamps.get(name);

  if (!timestamps) {
    // Evict stale entries when map is full
    if (messageTimestamps.size >= MSG_RATE_MAP_MAX) {
      const cutoff = now - MSG_RATE_WINDOW;
      for (const [key, ts] of messageTimestamps) {
        if (ts.length === 0 || ts[ts.length - 1] <= cutoff) messageTimestamps.delete(key);
      }
    }
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

module.exports = { requireAuth, messageRateLimit, BASE_PATH, COOKIE_PATH, CLEAR_COOKIE_OPTS };
