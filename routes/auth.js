const express = require('express');
const router = express.Router();
const { findUser, createUser, verifyPassword, findSession, createSession, deleteSession } = require('../auth');

// In-memory rate limiter for failed login attempts
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = 15; // max failed attempts per window

function rateLimit(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (entry && now - entry.start < RATE_LIMIT_WINDOW) {
    if (entry.count >= RATE_LIMIT_MAX) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }
  } else {
    loginAttempts.set(ip, { count: 0, start: now });
  }
  next();
}

function recordFailedAttempt(ip) {
  const entry = loginAttempts.get(ip);
  if (entry) entry.count++;
}

// Periodically clean up stale rate limit entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.start >= RATE_LIMIT_WINDOW) loginAttempts.delete(ip);
  }
}, 60 * 1000);

const NAME_RE = /^[a-zA-Z0-9_-]{1,50}$/;
const RESERVED_NAMES = ['system', 'contacts', 'conversations'];

router.post('/login', rateLimit, async (req, res) => {
  const { name, password } = req.body || {};
  if (typeof name !== 'string' || typeof password !== 'string' || !name || !password) {
    return res.status(400).json({ error: 'Name and password required' });
  }

  const trimmedName = name.trim();
  if (!NAME_RE.test(trimmedName)) {
    return res.status(400).json({ error: 'Name must be 1-50 characters: letters, numbers, hyphens, underscores' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  if (RESERVED_NAMES.includes(trimmedName.toLowerCase())) {
    return res.status(400).json({ error: 'That name is reserved' });
  }

  const existing = findUser(trimmedName);

  if (existing) {
    if (!(await verifyPassword(password, existing.password_hash))) {
      recordFailedAttempt(req.ip);
      return res.status(401).json({ error: 'Wrong password' });
    }
  } else {
    await createUser(trimmedName, password);
  }

  const sessionToken = createSession(trimmedName);

  res.cookie('session', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: 90 * 24 * 60 * 60 * 1000,
    path: '/',
  });

  res.json({ ok: true, name: trimmedName });
});

router.get('/check', (req, res) => {
  const token = req.cookies?.session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = findSession(token);

  if (!session) {
    res.clearCookie('session');
    return res.status(401).json({ error: 'Session expired' });
  }

  res.json({ name: session.name });
});

router.post('/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) {
    deleteSession(token);
  }
  res.clearCookie('session');
  res.json({ ok: true });
});

module.exports = router;
