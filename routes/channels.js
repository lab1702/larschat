const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, messageRateLimit } = require('../middleware');
const { broadcast, broadcastToChannel, broadcastToOthers } = require('../ws');

const { parseBefore, parseLimit } = require('./query');

const CHANNEL_RE = /^[a-zA-Z0-9_-]{1,50}$/;

// Pre-compiled prepared statements
const stmts = {
  listAll: db.prepare(`
    SELECT c.*, COALESCE(unread.cnt, 0) AS unread_count
    FROM channels c
    LEFT JOIN (
      SELECT m.channel_id, COUNT(*) AS cnt
      FROM messages m
      LEFT JOIN channel_read_positions crp
        ON crp.channel_id = m.channel_id AND crp.user_name = ?
      WHERE m.id > COALESCE(crp.last_read_id, 0)
      GROUP BY m.channel_id
    ) unread ON unread.channel_id = c.id
    ORDER BY c.id ASC
  `),
  insert: db.prepare(`INSERT INTO channels (name, created_by_name) VALUES (?, ?)`),
  findById: db.prepare(`SELECT * FROM channels WHERE id = ?`),
  findIdById: db.prepare(`SELECT id FROM channels WHERE id = ?`),
  deleteById: db.prepare(`DELETE FROM channels WHERE id = ?`),
  messagesBefore: db.prepare(`SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?`),
  messagesLatest: db.prepare(`SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?`),
  insertMessage: db.prepare(`INSERT INTO messages (channel_id, name, content) VALUES (?, ?, ?)`),
  findMessage: db.prepare(`SELECT * FROM messages WHERE id = ?`),
  markChannelRead: db.prepare(`
    INSERT INTO channel_read_positions (user_name, channel_id, last_read_id)
    VALUES (?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ?))
    ON CONFLICT(user_name, channel_id) DO UPDATE
    SET last_read_id = MAX(last_read_id, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = excluded.channel_id))
  `),
};

function parseIdParam(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid channel ID' });
  }
  req.params.id = id;
  next();
}

router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(stmts.listAll.all(req.name));
});

router.post('/', messageRateLimit, (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !CHANNEL_RE.test(name)) {
    return res.status(400).json({ error: 'Channel name must be alphanumeric + hyphens/underscores, 1-50 chars' });
  }

  const normalizedName = name.toLowerCase();
  try {
    const result = stmts.insert.run(normalizedName, req.name);
    const channel = stmts.findById.get(result.lastInsertRowid);
    broadcast('channel_created', { channel });
    res.status(201).json(channel);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Channel already exists' });
    }
    throw err;
  }
});

router.delete('/:id', parseIdParam, (req, res) => {
  const channel = stmts.findById.get(req.params.id);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  if (channel.name === 'general') {
    return res.status(403).json({ error: 'Cannot delete #general' });
  }

  if (channel.created_by_name !== req.name && channel.created_by_name !== 'system') {
    return res.status(403).json({ error: 'Only the creator can delete this channel' });
  }

  stmts.deleteById.run(req.params.id);
  broadcast('channel_deleted', { channelId: channel.id });
  res.json({ ok: true });
});

router.put('/:id/read', parseIdParam, (req, res) => {
  const channel = stmts.findIdById.get(req.params.id);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  stmts.markChannelRead.run(req.name, req.params.id, req.params.id);
  res.json({ ok: true });
});

router.get('/:id/messages', parseIdParam, (req, res) => {
  const channel = stmts.findIdById.get(req.params.id);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const { before, limit } = req.query;
  const lim = parseLimit(limit);
  const beforeId = parseBefore(before);

  let messages;
  if (beforeId) {
    messages = stmts.messagesBefore.all(req.params.id, beforeId, lim);
  } else {
    messages = stmts.messagesLatest.all(req.params.id, lim);
  }

  res.json(messages.reverse());
});

router.post('/:id/messages', parseIdParam, messageRateLimit, (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Message content required' });
  }
  if (content.length > 5000) {
    return res.status(400).json({ error: 'Message too long (max 5000 characters)' });
  }

  const channel = stmts.findIdById.get(req.params.id);
  if (!channel) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const result = stmts.insertMessage.run(req.params.id, req.name, content.trim());
  const message = stmts.findMessage.get(result.lastInsertRowid);
  broadcastToChannel(req.params.id, 'channel_message', { message });
  broadcastToOthers(req.params.id, 'channel_unread', { channelId: req.params.id, name: req.name });
  res.status(201).json(message);
});

module.exports = router;
