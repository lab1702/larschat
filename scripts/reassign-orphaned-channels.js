#!/usr/bin/env node
'use strict';

// Reassign orphaned channels to a specified user name.
//
// A channel is "orphaned" when its creator has no active session and no
// user account — typically because they used "Delete All My Data".
//
// Usage:
//   node scripts/reassign-orphaned-channels.js <new-owner-name>
//
// Run from inside the container or anywhere with access to the data directory.

const Database = require('better-sqlite3');
const path = require('path');

const newOwner = process.argv[2];
if (!newOwner) {
  console.error('Usage: node scripts/reassign-orphaned-channels.js <new-owner-name>');
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

// An orphaned channel is one whose created_by_name has no sessions and no
// user account (i.e. the creator effectively no longer exists in the system).
// Exclude #general since it's owned by system.
const orphaned = db.prepare(`
  SELECT c.id, c.name, c.created_by_name
  FROM channels c
  WHERE c.name != 'general'
    AND c.created_by_name != ?
    AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.name = c.created_by_name)
    AND NOT EXISTS (SELECT 1 FROM users u WHERE u.name = c.created_by_name)
`).all(newOwner);

if (orphaned.length === 0) {
  console.log('No orphaned channels found.');
  process.exit(0);
}

console.log(`Found ${orphaned.length} orphaned channel(s):\n`);
orphaned.forEach(ch => {
  console.log(`  #${ch.name} (id=${ch.id}, was: ${ch.created_by_name})`);
});

const update = db.prepare(`UPDATE channels SET created_by_name = ? WHERE id = ?`);
const tx = db.transaction(() => {
  for (const ch of orphaned) {
    update.run(newOwner, ch.id);
  }
});
tx();

console.log(`\nReassigned ${orphaned.length} channel(s) to ${newOwner}.`);
