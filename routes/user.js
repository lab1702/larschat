const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware');
const { broadcast } = require('../ws');

// Pre-compiled prepared statements
const stmts = {
  reassignChannels: db.prepare(`UPDATE channels SET created_by_name = 'system' WHERE created_by_name = ?`),
  deleteMessages: db.prepare(`DELETE FROM messages WHERE name = ?`),
  deleteDmSent: db.prepare(`DELETE FROM direct_messages WHERE from_name = ?`),
  deleteDmReceived: db.prepare(`DELETE FROM direct_messages WHERE to_name = ?`),
  deleteSessions: db.prepare(`DELETE FROM sessions WHERE name = ?`),
  deleteUser: db.prepare(`DELETE FROM users WHERE name = ?`),
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

router.delete('/data', (req, res) => {
  const name = req.name;
  deleteAllData(name);
  broadcast('user_data_deleted', { name });
  res.clearCookie('session');
  res.json({ ok: true });
});

module.exports = router;
