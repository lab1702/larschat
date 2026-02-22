# LarsChat

A self-hosted, real-time chat application. Channels, direct messages, online presence — all backed by SQLite and delivered over WebSockets.

## Features

- **Channels** — public chat rooms anyone can create; `#general` is always available
- **Direct messages** — private 1-on-1 conversations
- **Real-time updates** — messages and presence broadcast instantly via WebSocket
- **Auto-registration** — new usernames are created on first login
- **Emoji picker** — built-in emoji support
- **Account deletion** — users can permanently delete all their data
- **Security** — httpOnly session cookies, CSP headers, login rate limiting, scrypt password hashing

## Tech Stack

| Layer     | Technology                        |
|-----------|-----------------------------------|
| Backend   | Node.js, Express                  |
| Real-time | WebSocket (`ws`)                  |
| Database  | SQLite (`better-sqlite3`, WAL mode) |
| Frontend  | Vanilla HTML, CSS, JavaScript (SPA) |
| Auth      | Session tokens, scrypt hashing    |

## Quick Start

```bash
npm install
npm start
```

The server listens on `http://127.0.0.1:3000` by default. Set the `HOST` and `PORT` environment variables to change it.

## Docker

```bash
docker compose up -d
```

Data is persisted in a named volume (`larschat-data`). The container runs as a non-root user on Node 20 Alpine.

## Project Structure

```
server.js          Express server, security headers, SPA fallback
ws.js              WebSocket setup, presence tracking, message broadcasting
db.js              SQLite schema, migrations, connection
auth.js            Password hashing (scrypt), session management
middleware.js       Auth middleware (requireAuth)
routes/
  auth.js          Login, logout, session check, rate limiting
  channels.js      CRUD channels, channel messages
  dm.js            Direct messages, contacts, conversations
  user.js          User profile, account deletion
  query.js         Shared query param parsing
public/
  index.html       SPA shell
  app.js           Client-side application logic
  style.css        Styles
  emoji-data.js    Emoji dataset
scripts/
  generate-emoji-data.js        Build the emoji dataset
  reassign-orphaned-channels.js Maintenance script
```

## API

All endpoints except auth return `401` if not authenticated. Responses are JSON.

### Auth

| Method | Path              | Description                         |
|--------|-------------------|-------------------------------------|
| POST   | `/api/auth/login` | Log in or register (auto-creates)   |
| GET    | `/api/auth/check` | Check current session               |
| POST   | `/api/auth/logout`| Log out                             |

### Channels

| Method | Path                          | Description              |
|--------|-------------------------------|--------------------------|
| GET    | `/api/channels`               | List all channels        |
| POST   | `/api/channels`               | Create a channel         |
| DELETE | `/api/channels/:id`           | Delete a channel (creator only) |
| GET    | `/api/channels/:id/messages`  | Get channel messages     |
| POST   | `/api/channels/:id/messages`  | Post a message           |

### Direct Messages

| Method | Path                    | Description                    |
|--------|-------------------------|--------------------------------|
| GET    | `/api/dm/contacts`      | List all users                 |
| GET    | `/api/dm/conversations` | List DM conversations          |
| GET    | `/api/dm/:name`         | Get DM history with a user     |
| POST   | `/api/dm`               | Send a direct message          |

### User

| Method | Path             | Description                       |
|--------|------------------|-----------------------------------|
| GET    | `/api/user/me`   | Get current user info             |
| DELETE | `/api/user/data` | Delete all user data permanently  |

### WebSocket

Connect to `ws://host:port` with a valid session cookie. Events:

- `presence` — online user list updated
- `channel_created` / `channel_deleted` — channel changes
- `channel_message` — new message in a subscribed channel
- `dm` — new direct message

Send `{ "type": "subscribe_channel", "channelId": <id> }` to receive messages for a specific channel.

## Configuration

| Variable      | Default     | Description                              |
|---------------|-------------|------------------------------------------|
| `HOST`        | `127.0.0.1` | Bind address                             |
| `PORT`        | `3000`      | Server port                              |
| `TRUST_PROXY` | `1`     | Set to `0` to disable Express trust proxy |

## License

MIT.
