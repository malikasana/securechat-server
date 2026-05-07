# SecureChat Server

A zero-knowledge encrypted message relay server for private, trusted groups. The server never reads, stores, or logs any message content. It only routes encrypted blobs between verified members and manages group membership with unanimous consent.

---

## Philosophy

This is not a typical chat server. It is a **relay only**. Every message that passes through it is already encrypted by the client before sending. The server has no ability to read anything. It forwards, verifies membership, and manages who is allowed in — nothing more.

Designed for small, trusted circles where everyone knows each other. Not built for scale. Built for privacy.

---

## Tech Stack

- **Node.js** — runtime
- **Express** — REST API
- **ws** — WebSocket server
- **better-sqlite3** — embedded SQLite database
- **node-forge** — RSA signature verification
- **Docker** — containerized deployment

---

## Folder Structure

```
securechat-server/
├── src/
│   ├── index.js                  → Entry point. Starts HTTP + WebSocket server.
│   ├── config.js                 → Reads environment variables.
│   ├── db/
│   │   ├── database.js           → SQLite connection, WAL mode, auto-migrations.
│   │   └── schema.sql            → Table definitions.
│   ├── routes/
│   │   └── api.js                → All REST endpoints.
│   ├── websocket/
│   │   ├── handler.js            → WebSocket connection manager and event router.
│   │   └── events.js             → Event type constants.
│   ├── controllers/
│   │   ├── member.js             → Founder registration and member listing.
│   │   ├── consensus.js          → Join request logic, approval, spam protection.
│   │   └── message.js            → Message relay logic.
│   └── middleware/
│       └── verify.js             → RSA signature verification middleware.
├── data/
│   └── securechat.db             → SQLite database (auto-created, gitignored).
├── .env                          → Environment variables (gitignored).
├── .env.example                  → Template for environment variables.
├── Dockerfile                    → Docker build definition.
├── docker-compose.yml            → Docker Compose configuration.
└── package.json
```

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```
PORT=3000
FOUNDER_KEY=your_secret_key_here
SERVER_NAME=Your Server Name
```

| Variable | Description |
|----------|-------------|
| `PORT` | Port the server listens on. Default `3000`. |
| `FOUNDER_KEY` | Secret string used exactly once to register the founder. Permanently invalidated after first use. |
| `SERVER_NAME` | Display name of the server returned to clients. |

> **Important:** After the founder registers, the `FOUNDER_KEY` is permanently blocked at the database level regardless of what value remains in `.env`. For maximum security, delete the variable from your deployment environment after registration.

---

## Database Schema

Five tables:

### `members`
Stores all active and left members.
```sql
id TEXT PRIMARY KEY
display_name TEXT
public_key TEXT          -- RSA public key (PEM format) for authentication
curve25519_public_key TEXT  -- Curve25519 public key for E2EE message encryption
joined_at INTEGER
status TEXT              -- 'active' or 'left'
```

### `join_requests`
Tracks pending, approved, rejected, and expired join requests.
```sql
id TEXT PRIMARY KEY
requester_id TEXT
requester_name TEXT
requester_public_key TEXT
requester_curve25519_public_key TEXT
requester_ip TEXT
requested_at INTEGER
expires_at INTEGER        -- 48 hours from request time
approvals TEXT            -- JSON array of member IDs who approved
rejections TEXT           -- JSON array of member IDs who rejected
status TEXT               -- 'pending', 'approved', 'rejected', 'expired'
```

### `channels`
Stores general and 1v1 DM channels.
```sql
id TEXT PRIMARY KEY
type TEXT                 -- 'general' or 'dm'
member_ids TEXT           -- JSON array of member IDs
```

### `server_info`
Key-value store for server state.
```
founder_set → 'true' after founder registers
founder_id  → member ID of the founder
requests_locked → 'true' if join requests are closed
```

### `ip_cooldowns`
Temporary spam protection. Cleared on request resolution.
```sql
ip TEXT PRIMARY KEY
requested_at INTEGER
expires_at INTEGER
```

---

## REST API

### Public Endpoints

#### `GET /api/status`
Returns server info. First call any client should make.

**Response:**
```json
{
  "online": true,
  "server_name": "My Server",
  "server_url": "https://your-server.com",
  "member_count": 3,
  "founder_set": true,
  "requests_locked": false
}
```

#### `POST /api/register`
One-time founder registration. Rejected after first use.

**Body:**
```json
{
  "id": "uuid-here",
  "display_name": "Alice",
  "public_key": "-----BEGIN PUBLIC KEY-----...",
  "curve25519_public_key": "base64-encoded-key",
  "founder_key": "your_secret_founder_key"
}
```

**Response:**
```json
{ "success": true, "is_founder": true, "member_id": "uuid-here" }
```

#### `POST /api/join-request`
Submit a join request. IP-rate-limited — same IP blocked while a request is pending.

**Body:**
```json
{
  "id": "uuid-here",
  "display_name": "Bob",
  "public_key": "-----BEGIN PUBLIC KEY-----...",
  "curve25519_public_key": "base64-encoded-key"
}
```

**Response:**
```json
{ "request_id": "uuid", "expires_at": 1234567890000 }
```

#### `GET /api/join-request/:request_id`
Poll join request status. Used by waiting client.

**Response:**
```json
{
  "request_id": "uuid",
  "status": "pending",
  "requester_name": "Bob",
  "expires_at": 1234567890000
}
```
Status values: `pending`, `approved`, `rejected`, `expired`

---

### Authenticated Endpoints

All require three headers:
```
x-member-id: {member_id}
x-signature: {base64(RSA_sign(member_id + timestamp_ms, privateKey))}
x-timestamp: {timestamp_ms}
```

Signature uses RSA + SHA256 via `node-forge`. Timestamp must be within **60 seconds** of server time.

#### `GET /api/members`
Returns all active members including online status.

**Response:**
```json
{
  "members": [
    {
      "id": "uuid",
      "display_name": "Alice",
      "public_key": "-----BEGIN PUBLIC KEY-----...",
      "curve25519_public_key": "base64-key",
      "joined_at": 1234567890000,
      "online": true
    }
  ]
}
```

#### `POST /api/approve/:request_id`
Approve or reject a join request. One rejection from any member immediately denies the request. All members must approve for admission.

**Body:**
```json
{ "approved": true }
```

#### `GET /api/channels`
Returns all channels the authenticated member belongs to.

**Response:**
```json
{
  "channels": [
    { "id": "general", "type": "general", "member_ids": ["uuid1", "uuid2"] },
    { "id": "uuid1:uuid2", "type": "dm", "member_ids": ["uuid1", "uuid2"] }
  ]
}
```

#### `POST /api/lock-requests`
Lock or unlock join requests. Any authenticated member can call this.

**Body:**
```json
{ "locked": true }
```

#### `DELETE /api/members/:id`
Clean leave. Marks member as left and broadcasts `MEMBER_LEFT` to all online members. You can only remove yourself.

---

## WebSocket

Connect to: `wss://your-server.com`

**AUTH must be the very first message.** Any message before AUTH closes the connection immediately.

### Client → Server Events

#### `AUTH`
```javascript
{
  type: 'AUTH',
  payload: {
    member_id: 'uuid',
    signature: 'base64-signature',
    timestamp: 1234567890000
  }
}
```

#### `MESSAGE`
Per-recipient encrypted blobs. Each recipient gets only their own blob.
```javascript
{
  type: 'MESSAGE',
  payload: {
    channel_id: 'general',
    message_id: 'uuid',
    sender_id: 'uuid',
    sender_curve25519_public_key: 'base64-key',
    recipients: [
      { member_id: 'uuid-b', encrypted_blob: 'base64-ciphertext' },
      { member_id: 'uuid-c', encrypted_blob: 'base64-ciphertext' }
    ]
  }
}
```

#### `ACK`
Send after receiving a message. Triggers `DELIVERED` to sender.
```javascript
{ type: 'ACK', payload: { message_id: 'uuid' } }
```

#### `KEY_DISTRIBUTION`
Relay a sender key to a specific member. Used for group E2EE key exchange. Pure relay — server never reads the blob.
```javascript
{
  type: 'KEY_DISTRIBUTION',
  payload: {
    from_member_id: 'uuid-a',
    to_member_id: 'uuid-b',
    channel_id: 'general',
    encrypted_key_blob: 'base64-encrypted-key'
  }
}
```

#### `JOIN_RESPONSE`
Approve or reject a join request via WebSocket.
```javascript
{
  type: 'JOIN_RESPONSE',
  payload: { request_id: 'uuid', approved: true, member_id: 'your-uuid' }
}
```

#### `PING`
Keep-alive. Client should ping every 10 minutes.
```javascript
{ type: 'PING' }
```

---

### Server → Client Events

#### `MESSAGE`
Forwarded to each recipient individually.
```javascript
{
  type: 'MESSAGE',
  payload: {
    channel_id: 'general',
    message_id: 'uuid',
    encrypted_blob: 'base64-ciphertext',
    sender_id: 'uuid',
    sender_name: 'Alice',
    sender_curve25519_public_key: 'base64-key'
  }
}
```

#### `DELIVERED`
All recipients ACKed the message.
```javascript
{ type: 'DELIVERED', payload: { message_id: 'uuid' } }
```

#### `UNDELIVERED`
No ACK received within 10 seconds.
```javascript
{ type: 'UNDELIVERED', payload: { message_id: 'uuid' } }
```

#### `KEY_DISTRIBUTION`
Relayed sender key from another member.
```javascript
{
  type: 'KEY_DISTRIBUTION',
  payload: { from_member_id: 'uuid', channel_id: 'general', encrypted_key_blob: 'base64' }
}
```

#### `JOIN_REQUEST`
Broadcast to all online members when someone requests to join.
```javascript
{
  type: 'JOIN_REQUEST',
  payload: {
    request_id: 'uuid',
    requester_id: 'uuid',
    requester_name: 'Bob',
    requester_public_key: '-----BEGIN PUBLIC KEY-----...',
    expires_at: 1234567890000
  }
}
```

#### `JOIN_REQUEST_RESOLVED`
Sent when a request is approved or rejected.
```javascript
{ type: 'JOIN_REQUEST_RESOLVED', payload: { request_id: 'uuid', status: 'approved' } }
```

#### `MEMBER_JOINED`
Broadcast to all when a new member is admitted.
```javascript
{
  type: 'MEMBER_JOINED',
  payload: {
    member_id: 'uuid',
    display_name: 'Bob',
    public_key: '-----BEGIN PUBLIC KEY-----...',
    curve25519_public_key: 'base64-key'
  }
}
```

#### `MEMBER_LEFT`
Broadcast when a member leaves or disconnects.
```javascript
{ type: 'MEMBER_LEFT', payload: { member_id: 'uuid' } }
```

#### `REQUESTS_LOCK_CHANGED`
Broadcast when join requests are locked or unlocked.
```javascript
{ type: 'REQUESTS_LOCK_CHANGED', payload: { locked: true } }
```

#### `AUTH_FAILED`
Sent when WebSocket AUTH fails. Connection is closed immediately after.
```javascript
{ type: 'AUTH_FAILED', payload: { reason: 'Signature mismatch' } }
```

#### `PONG`
Response to PING.
```javascript
{ type: 'PONG' }
```

---

## Membership Flow

```
1. New person → POST /api/join-request
2. Server stores request, broadcasts JOIN_REQUEST to all online members
3. Each member approves or rejects via POST /api/approve/:id or JOIN_RESPONSE WebSocket event
4. One rejection → immediately denied, IP released
5. All approve → member admitted:
   - Added to members table
   - Added to general channel
   - 1v1 DM channel created with every existing member
   - MEMBER_JOINED broadcast to all with both public keys
6. Existing members send their sender keys to new member via KEY_DISTRIBUTION
7. New member sends their sender key to all existing members via KEY_DISTRIBUTION
```

---

## Security Rules

1. Messages never stored — forwarded from memory, immediately discarded
2. No IP logging except temporary spam guard, auto-cleared on request resolution
3. No message timestamps logged
4. No who-sent-what logging
5. RSA signature verified on every authenticated REST request
6. 60 second timestamp window prevents replay attacks
7. WebSocket closes immediately on any message before AUTH
8. Unanimous consent required — one rejection = immediate deny
9. FOUNDER_KEY one-time use — permanently invalidated at database level after first registration
10. Server cannot admit anyone unilaterally
11. Join requests auto-expire after 48 hours
12. Same IP blocked from spamming join requests
13. Sender cannot spoof `from_member_id` on KEY_DISTRIBUTION — verified against authenticated connection
14. Display names must be unique

---

## Deployment

### Render (Cloud)

1. Push repo to GitHub (keep private)
2. New Web Service on Render → connect repo
3. Build command: `npm install`
4. Start command: `node src/index.js`
5. Add environment variables: `FOUNDER_KEY`, `SERVER_NAME`, `PORT=3000`
6. Deploy
7. Set up UptimeRobot to ping `GET /api/status` every 5 minutes (free tier spins down after 15 min inactivity)
8. After founder registers, optionally delete `FOUNDER_KEY` from Render environment

### Local (with ngrok)

```bash
# Install dependencies
npm install

# Create data directory
mkdir data

# Create .env file
cp .env.example .env
# Edit .env with your values

# Start server
node src/index.js

# In a separate terminal, expose via ngrok
ngrok http 3000
```

Use the ngrok URL as your server URL. Note: free ngrok URLs change on restart.

### Docker

```bash
docker-compose up -d
```

---

## Client Integration Notes

The client is a separate application (mobile or desktop) that connects to this server. From the server's perspective, the client is responsible for:

- Generating UUID member IDs locally
- Generating RSA keypair (2048-bit minimum) for server authentication
- Generating Curve25519 keypair for message encryption
- Encrypting all message content before sending — server only sees ciphertext
- Implementing the signature scheme: `base64(RSA_SHA256_sign(member_id + timestamp_ms_string))`
- Sending `x-member-id`, `x-signature`, `x-timestamp` headers on every authenticated request
- Implementing sender key protocol for group E2EE using `KEY_DISTRIBUTION` events
- Sending `ACK` after receiving each message
- Sending `PING` every 10 minutes to keep WebSocket alive

The server returns member `id` (not `member_id`) in all responses. Clients should map accordingly.

---
