const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, messageRateLimit } = require('../middleware');
const { sendToUser } = require('../ws');
const { userExists } = require('../auth');
const { parseBefore, parseLimit } = require('./query');

// Pre-compiled prepared statements
const stmts = {
  contacts: db.prepare(`SELECT name FROM users WHERE name != ? ORDER BY name ASC`),
  conversations: db.prepare(`
    SELECT d.other_name, d.content AS last_message, d.created_at AS last_message_at, d.id
    FROM (
      SELECT *,
        CASE WHEN from_name = :name THEN to_name ELSE from_name END AS other_name
      FROM direct_messages
      WHERE from_name = :name OR to_name = :name
    ) d
    INNER JOIN (
      SELECT
        CASE WHEN from_name = :name THEN to_name ELSE from_name END AS other_name,
        MAX(id) AS max_id
      FROM direct_messages
      WHERE from_name = :name OR to_name = :name
      GROUP BY other_name
    ) latest ON d.other_name = latest.other_name AND d.id = latest.max_id
    ORDER BY d.id DESC
  `),
  historyBefore: db.prepare(`
    SELECT * FROM direct_messages
    WHERE ((from_name = ? AND to_name = ?) OR (from_name = ? AND to_name = ?))
      AND id < ?
    ORDER BY id DESC LIMIT ?
  `),
  historyLatest: db.prepare(`
    SELECT * FROM direct_messages
    WHERE ((from_name = ? AND to_name = ?) OR (from_name = ? AND to_name = ?))
    ORDER BY id DESC LIMIT ?
  `),
  insertDm: db.prepare(`INSERT INTO direct_messages (from_name, to_name, content) VALUES (?, ?, ?)`),
  findDm: db.prepare(`SELECT * FROM direct_messages WHERE id = ?`),
};

router.use(requireAuth);

// All registered users as potential DM contacts
router.get('/contacts', (req, res) => {
  const contacts = stmts.contacts.all(req.name);
  res.json(contacts.map(c => c.name));
});

// Active DM conversations with most recent message
router.get('/conversations', (req, res) => {
  const conversations = stmts.conversations.all({ name: req.name });
  res.json(conversations);
});

// DM history with specific user
router.get('/:name', (req, res) => {
  const otherName = req.params.name.trim().toLowerCase();
  if (!userExists(otherName)) {
    return res.status(404).json({ error: 'User not found' });
  }

  const { before, limit } = req.query;
  const lim = parseLimit(limit);
  const beforeId = parseBefore(before);

  let messages;
  if (beforeId) {
    messages = stmts.historyBefore.all(req.name, otherName, otherName, req.name, beforeId, lim);
  } else {
    messages = stmts.historyLatest.all(req.name, otherName, otherName, req.name, lim);
  }

  res.json(messages.reverse());
});

// Send DM
router.post('/', messageRateLimit, (req, res) => {
  const { to_name: rawToName, content } = req.body || {};
  if (typeof rawToName !== 'string' || typeof content !== 'string' || !rawToName || !content.trim()) {
    return res.status(400).json({ error: 'to_name and content required' });
  }
  if (content.length > 5000) {
    return res.status(400).json({ error: 'Message too long (max 5000 characters)' });
  }

  const to_name = rawToName.trim().toLowerCase();
  if (to_name === req.name) {
    return res.status(400).json({ error: 'Cannot DM yourself' });
  }

  if (!userExists(to_name)) {
    return res.status(404).json({ error: 'User not found' });
  }

  const result = stmts.insertDm.run(req.name, to_name, content.trim());
  const message = stmts.findDm.get(result.lastInsertRowid);

  // Send to both sender and recipient
  sendToUser(req.name, 'dm', { message });
  sendToUser(to_name, 'dm', { message });

  res.status(201).json(message);
});

module.exports = router;
