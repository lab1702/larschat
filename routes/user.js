const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, CLEAR_COOKIE_OPTS } = require('../middleware');
const { broadcast, closeUserConnections } = require('../ws');
const { hashPassword, verifyPassword, findUser } = require('../auth');

// Pre-compiled prepared statements
const stmts = {
  reassignChannels: db.prepare(`UPDATE channels SET created_by_name = 'system' WHERE created_by_name = ?`),
  deleteMessages: db.prepare(`DELETE FROM messages WHERE name = ?`),
  deleteDmSent: db.prepare(`DELETE FROM direct_messages WHERE from_name = ?`),
  deleteDmReceived: db.prepare(`DELETE FROM direct_messages WHERE to_name = ?`),
  deleteSessions: db.prepare(`DELETE FROM sessions WHERE name = ?`),
  deleteUser: db.prepare(`DELETE FROM users WHERE name = ?`),
  updatePassword: db.prepare(`UPDATE users SET password_hash = ? WHERE name = ?`),
  deleteOtherSessions: db.prepare(`DELETE FROM sessions WHERE name = ? AND token != ?`),
};

const deleteAllData = db.transaction((name) => {
  stmts.reassignChannels.run(name);
  stmts.deleteMessages.run(name);
  stmts.deleteDmSent.run(name);
  stmts.deleteDmReceived.run(name);
  stmts.deleteSessions.run(name);
  stmts.deleteUser.run(name);
});

router.use(requireAuth);

router.get('/me', (req, res) => {
  res.json({ name: req.name });
});

router.put('/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
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
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    const newHash = await hashPassword(newPassword);
    const sessionToken = req.cookies?.session;
    db.transaction(() => {
      stmts.updatePassword.run(newHash, req.name);
      stmts.deleteOtherSessions.run(req.name, sessionToken);
    })();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/data', (req, res) => {
  const name = req.name;
  deleteAllData(name);
  closeUserConnections(name);
  broadcast('user_data_deleted', { name });
  res.clearCookie('session', CLEAR_COOKIE_OPTS);
  res.json({ ok: true });
});

module.exports = router;
