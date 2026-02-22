const { WebSocketServer } = require('ws');
const cookie = require('cookie');
const { findSession } = require('./auth');
const db = require('./db');

const channelExists = db.prepare('SELECT 1 FROM channels WHERE id = ?');

// Map<name, Set<WebSocket>>
const clients = new Map();
const MAX_CONNECTIONS_PER_USER = 5;
let presenceTimer = null;

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, maxPayload: 1024 });

  wss.on('connection', (ws, req) => {
    // Validate Origin to prevent cross-site WebSocket hijacking
    const origin = req.headers.origin;
    if (origin) {
      const host = req.headers.host;
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          ws.close(4003, 'Origin not allowed');
          return;
        }
      } catch {
        ws.close(4003, 'Invalid origin');
        return;
      }
    }

    const cookies = cookie.parse(req.headers.cookie || '');
    const token = cookies.session;

    if (!token) {
      ws.close(4001, 'Not authenticated');
      return;
    }

    const session = findSession(token);

    if (!session) {
      ws.close(4001, 'Session expired');
      return;
    }

    const name = session.name;
    ws.name = name;
    ws.sessionToken = token;
    ws.isAlive = true;
    ws.subscribedChannel = null;

    if (!clients.has(name)) {
      clients.set(name, new Set());
    }
    const sockets = clients.get(name);
    if (sockets.size >= MAX_CONNECTIONS_PER_USER) {
      ws.close(4008, 'Too many connections');
      return;
    }
    sockets.add(ws);
    broadcastPresenceDebounced();

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe_channel') {
          const id = msg.channelId;
          ws.subscribedChannel = (typeof id === 'number' && Number.isInteger(id) && id > 0 && channelExists.get(id)) ? id : null;
        }
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error for ${name}:`, err.message);
    });

    ws.on('close', () => {
      const sockets = clients.get(name);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) clients.delete(name);
      }
      broadcastPresenceDebounced();
    });
  });

  // Heartbeat every 30s — also re-validates sessions
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      // Drop connections with expired/deleted sessions
      if (ws.sessionToken && !findSession(ws.sessionToken)) {
        ws.close(4001, 'Session expired');
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => clearInterval(interval));

  return wss;
}

function getOnlineUsers() {
  return Array.from(clients.keys()).sort();
}

function broadcastPresenceDebounced() {
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    broadcast('presence', { users: getOnlineUsers() });
  }, 500);
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const [, sockets] of clients) {
    for (const ws of sockets) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }
}

function broadcastToChannel(channelId, type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const [, sockets] of clients) {
    for (const ws of sockets) {
      if (ws.readyState === 1 && ws.subscribedChannel === channelId) {
        ws.send(msg);
      }
    }
  }
}

function sendToUser(name, type, data) {
  const sockets = clients.get(name);
  if (!sockets) return;
  const msg = JSON.stringify({ type, ...data });
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function closeUserConnections(name) {
  const sockets = clients.get(name);
  if (!sockets) return;
  for (const ws of sockets) {
    ws.close(4002, 'Account deleted');
  }
}

module.exports = { setupWebSocket, broadcast, broadcastToChannel, sendToUser, closeUserConnections };
