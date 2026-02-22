const { WebSocketServer } = require('ws');
const cookie = require('cookie');
const { findSession } = require('./auth');

// Map<name, Set<WebSocket>>
const clients = new Map();
let presenceTimer = null;

function setupWebSocket(server) {
  const wss = new WebSocketServer({ server, maxPayload: 1024 });

  wss.on('connection', (ws, req) => {
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
    ws.isAlive = true;
    ws.subscribedChannel = null;

    if (!clients.has(name)) {
      clients.set(name, new Set());
    }
    clients.get(name).add(ws);
    broadcastPresenceDebounced();

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe_channel') {
          ws.subscribedChannel = typeof msg.channelId === 'number' ? msg.channelId : null;
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

  // Heartbeat every 30s
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
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

module.exports = { setupWebSocket, broadcast, broadcastToChannel, sendToUser };
