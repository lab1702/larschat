const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'larschat.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- channels.created_by_name is not FK-constrained because it may be
  -- reassigned to 'system' (which is not a real user) on account deletion.
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_by_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS direct_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    to_name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_name_expires ON sessions(name, expires_at);
  CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_name ON messages(name);
  CREATE INDEX IF NOT EXISTS idx_dm_conversation ON direct_messages(from_name, to_name, id);
  CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages(to_name);

  CREATE TABLE IF NOT EXISTS channel_read_positions (
    user_name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_name, channel_id)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS dm_read_positions (
    user_name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    peer_name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_name, peer_name)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS dm_conversations (
    user_name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    peer_name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,
    last_message_id INTEGER NOT NULL,
    PRIMARY KEY (user_name, peer_name)
  ) WITHOUT ROWID;
`);

// Populate dm_conversations from existing direct_messages (migration for existing databases)
const hasConversations = db.prepare(`SELECT COUNT(*) AS cnt FROM dm_conversations`).get();
if (hasConversations.cnt === 0) {
  db.exec(`
    INSERT OR IGNORE INTO dm_conversations (user_name, peer_name, last_message_id)
    SELECT user_name, peer_name, MAX(msg_id) FROM (
      SELECT from_name AS user_name, to_name AS peer_name, id AS msg_id FROM direct_messages
      UNION ALL
      SELECT to_name AS user_name, from_name AS peer_name, id AS msg_id FROM direct_messages
    ) GROUP BY user_name, peer_name
  `);
}

// Seed #general channel
db.prepare(`INSERT OR IGNORE INTO channels (name, created_by_name) VALUES ('general', 'system')`).run();

module.exports = db;
