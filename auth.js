const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTS = { cost: 32768, blockSize: 8, parallelization: 1, maxmem: 64 * 1024 * 1024 };

// Pre-compiled prepared statements
const stmts = {
  findUser: db.prepare(`SELECT name, password_hash FROM users WHERE name = ?`),
  userExists: db.prepare(`SELECT 1 FROM users WHERE name = ?`),
  insertUser: db.prepare(`INSERT INTO users (name, password_hash) VALUES (?, ?)`),
  insertSession: db.prepare(`INSERT INTO sessions (token, name, expires_at) VALUES (?, ?, ?)`),
  findSession: db.prepare(`SELECT name FROM sessions WHERE token = ? AND expires_at > datetime('now')`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE token = ?`),
  cleanupExpired: db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`),
  evictExcessSessions: db.prepare(`
    DELETE FROM sessions WHERE token IN (
      SELECT token FROM sessions WHERE name = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?
    )
  `),
};

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64, SCRYPT_OPTS)).toString('hex');
  return `${salt}:${hash}`;
}

async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = (await scrypt(password, salt, 64, SCRYPT_OPTS)).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(test, 'hex'), Buffer.from(hash, 'hex'));
}

function findUser(name) {
  return stmts.findUser.get(name);
}

async function createUser(name, password) {
  const password_hash = await hashPassword(password);
  stmts.insertUser.run(name, password_hash);
}

const MAX_SESSIONS_PER_USER = 10;

function createSession(name) {
  const token = generateToken();
  // Format as "YYYY-MM-DD HH:MM:SS" UTC — must match SQLite's datetime('now') format
  const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  stmts.insertSession.run(token, name, expires);
  // Evict oldest sessions if over the per-user limit
  stmts.evictExcessSessions.run(name, MAX_SESSIONS_PER_USER);
  return token;
}

function findSession(token) {
  return stmts.findSession.get(token);
}

function deleteSession(token) {
  stmts.deleteSession.run(token);
}

function cleanupExpired() {
  stmts.cleanupExpired.run();
}

function userExists(name) {
  return !!stmts.userExists.get(name);
}

module.exports = { hashPassword, verifyPassword, findUser, userExists, createUser, findSession, createSession, deleteSession, cleanupExpired };
