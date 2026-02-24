const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, CLEAR_COOKIE_OPTS } = require('../middleware');
const { broadcast, closeUserConnections } = require('../ws');
const { hashPassword, verifyPassword, findUser } = require('../auth');

// Pre-compiled prepared statements
const stmts = {
  reassignChannels: db.prepare(`UPDATE channels SET created_by_name = 'system' WHERE created_by_name = ?`),
  deleteUser: db.prepare(`DELETE FROM users WHERE name = ?`),
  updatePassword: db.prepare(`UPDATE users SET password_hash = ? WHERE name = ?`),
  deleteOtherSessions: db.prepare(`DELETE FROM sessions WHERE name = ? AND token != ?`),
};

// Only reassignChannels is needed before deleteUser — messages, direct_messages,
// sessions, and read positions are all ON DELETE CASCADE from users.
const deleteAllData = db.transaction((name) => {
  stmts.reassignChannels.run(name);
  stmts.deleteUser.run(name);
});

// Per-user rate limiter for password verification attempts
const passwordAttempts = new Map();
const PW_RATE_WINDOW = 15 * 60 * 1000; // 15 minutes
const PW_RATE_MAX = 10; // max attempts per window
const PW_RATE_MAP_MAX = 10000;

setInterval(() => {
  const now = Date.now();
  for (const [name, entry] of passwordAttempts) {
    if (now - entry.start >= PW_RATE_WINDOW) passwordAttempts.delete(name);
  }
}, 60 * 1000);

function passwordRateLimit(req, res, next) {
  const name = req.name;
  const now = Date.now();
  let entry = passwordAttempts.get(name);

  if (entry && now - entry.start < PW_RATE_WINDOW) {
    if (entry.count >= PW_RATE_MAX) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
  } else {
    if (passwordAttempts.size >= PW_RATE_MAP_MAX) {
      const cutoff = now - PW_RATE_WINDOW;
      for (const [key, val] of passwordAttempts) {
        if (val.start < cutoff) passwordAttempts.delete(key);
      }
      if (passwordAttempts.size >= PW_RATE_MAP_MAX) {
        const firstKey = passwordAttempts.keys().next().value;
        passwordAttempts.delete(firstKey);
      }
    }
    entry = { count: 0, start: now };
    passwordAttempts.set(name, entry);
  }
  entry.count++;
  next();
}

router.use(requireAuth);

router.get('/me', (req, res) => {
  res.json({ name: req.name });
});

router.put('/password', passwordRateLimit, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword) {
    return res.status(400).json({ error: 'Current password is required' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    return res.status(400).json({ error: 'New password must be 8-128 characters' });
  }
  const user = findUser(req.name);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  const valid = await verifyPassword(currentPassword, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const newHash = await hashPassword(newPassword);
  const sessionToken = req.cookies?.session;
  db.transaction(() => {
    stmts.updatePassword.run(newHash, req.name);
    stmts.deleteOtherSessions.run(req.name, sessionToken);
  })();
  res.json({ ok: true });
});

router.delete('/data', passwordRateLimit, async (req, res) => {
  const { password } = req.body || {};
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Password is required' });
  }
  const user = findUser(req.name);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return res.status(403).json({ error: 'Incorrect password' });
  }
  const name = req.name;
  deleteAllData(name);
  closeUserConnections(name);
  broadcast('user_data_deleted', { name });
  res.clearCookie('session', CLEAR_COOKIE_OPTS);
  res.json({ ok: true });
});

module.exports = router;
