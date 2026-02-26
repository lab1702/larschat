const { findSession } = require('./auth');

let BASE_PATH = process.env.BASE_PATH || '/';
if (!/^\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=\-]*$/.test(BASE_PATH)) {
  console.error('Invalid BASE_PATH: must start with / and contain only URL-safe characters');
  process.exit(1);
}
// Ensure trailing slash so client-side URL construction works correctly
if (!BASE_PATH.endsWith('/')) BASE_PATH += '/';

const COOKIE_PATH = BASE_PATH;

function clearCookie(res, req) {
  res.clearCookie('session', { path: COOKIE_PATH, httpOnly: true, sameSite: 'lax', secure: req.secure });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = findSession(token);

  if (!session) {
    clearCookie(res, req);
    return res.status(401).json({ error: 'Session expired' });
  }

  req.name = session.name;
  next();
}

// Fixed-window rate limiter factory.
// keyFn(req) returns the rate-limit key (e.g. IP or username).
function createRateLimit({ window, max, error, keyFn, mapMax = 10000 }) {
  const entries = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (now - entry.start >= window) entries.delete(key);
    }
  }, 60 * 1000);

  return function rateLimit(req, res, next) {
    const key = keyFn(req);
    const now = Date.now();
    let entry = entries.get(key);

    if (entry && now - entry.start < window) {
      if (entry.count >= max) {
        return res.status(429).json({ error });
      }
    } else {
      if (entries.size >= mapMax) {
        const cutoff = now - window;
        for (const [k, v] of entries) {
          if (v.start < cutoff) entries.delete(k);
        }
        if (entries.size >= mapMax) {
          const firstKey = entries.keys().next().value;
          entries.delete(firstKey);
        }
      }
      entry = { count: 0, start: now };
      entries.set(key, entry);
    }
    entry.count++;
    next();
  };
}

// Per-user sliding-window rate limiter for message posting
const messageTimestamps = new Map();
const MSG_RATE_WINDOW = 60 * 1000; // 1 minute
const MSG_RATE_MAX = 30; // max messages per window
const MSG_RATE_MAP_MAX = 10000; // cap map size to prevent memory exhaustion

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
    if (messageTimestamps.size >= MSG_RATE_MAP_MAX) {
      const cutoff = now - MSG_RATE_WINDOW;
      for (const [key, ts] of messageTimestamps) {
        if (ts.length === 0 || ts[ts.length - 1] <= cutoff) messageTimestamps.delete(key);
      }
    }
    timestamps = [];
    messageTimestamps.set(name, timestamps);
  }

  let start = 0;
  while (start < timestamps.length && timestamps[start] <= now - MSG_RATE_WINDOW) {
    start++;
  }
  if (start > 0) timestamps.splice(0, start);

  if (timestamps.length >= MSG_RATE_MAX) {
    return res.status(429).json({ error: 'Too many messages. Please slow down.' });
  }

  timestamps.push(now);
  next();
}

module.exports = { requireAuth, createRateLimit, messageRateLimit, clearCookie, BASE_PATH, COOKIE_PATH };
