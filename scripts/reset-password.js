#!/usr/bin/env node
'use strict';

// Reset a user's password and invalidate all their sessions.
//
// Usage:
//   node scripts/reset-password.js <username> <new-password>
//
// Run from inside the container or anywhere with access to the data directory.

const crypto = require('crypto');
const { promisify } = require('util');
const Database = require('better-sqlite3');
const path = require('path');

const scrypt = promisify(crypto.scrypt);

const username = process.argv[2];
const newPassword = process.argv[3];

if (!username || !newPassword) {
  console.error('Usage: node scripts/reset-password.js <username> <new-password>');
  process.exit(1);
}

if (newPassword.length < 8) {
  console.error('Error: Password must be at least 8 characters.');
  process.exit(1);
}

const dbPath = path.join(__dirname, '..', 'data', 'larschat.db');
let db;
try {
  db = new Database(dbPath);
} catch (err) {
  console.error(`Failed to open database at ${dbPath}: ${err.message}`);
  process.exit(1);
}

db.pragma('journal_mode = WAL');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}

(async () => {
  const user = db.prepare('SELECT name FROM users WHERE name = ?').get(username);
  if (!user) {
    console.error(`Error: User "${username}" not found.`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(newPassword);

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE name = ?').run(passwordHash, user.name);
    const sessResult = db.prepare('DELETE FROM sessions WHERE name = ?').run(user.name);
    return sessResult.changes;
  });

  const sessionsDeleted = tx();

  console.log(`Password updated for user "${user.name}".`);
  console.log(`Cleared ${sessionsDeleted} session(s).`);
})();
