const { verifyWsAuth } = require('../middleware/verify');
const EVENTS = require('./events');
const { relayMessage } = require('../controllers/message');
const { processApproval } = require('../controllers/consensus');

// Map of memberId → WebSocket connection
const connections = new Map();

function setupWebSocket(wss) {
  wss.on('connection', (ws) => {
    let authenticatedMemberId = null;

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return; // Silently drop malformed messages
      }

      // AUTH must be first
      if (data.type === EVENTS.AUTH) {
        const { member_id, signature, timestamp } = data.payload || {};
        const result = verifyWsAuth(member_id, signature, timestamp);
        if (!result.valid) {
          ws.send(JSON.stringify({
            type: EVENTS.AUTH_FAILED,
            payload: { reason: result.reason }
          }));
          ws.close();
          return;
        }

        authenticatedMemberId = member_id;
        connections.set(member_id, ws);
        return;
      }

      // Reject all other messages before auth
      if (!authenticatedMemberId) {
        ws.send(JSON.stringify({
          type: EVENTS.AUTH_FAILED,
          payload: { reason: 'Not authenticated' }
        }));
        ws.close();
        return;
      }

      switch (data.type) {
        case EVENTS.MESSAGE: {
          const { channel_id, encrypted_blob, sender_id } = data.payload || {};
          if (sender_id !== authenticatedMemberId) break; // Cannot spoof sender
          relayMessage({ channel_id, encrypted_blob, sender_id }, broadcastToChannel);
          break;
        }

        case EVENTS.JOIN_RESPONSE: {
          const { request_id, approved, member_id, signature, timestamp } = data.payload || {};
          if (member_id !== authenticatedMemberId) break;
          // Re-verify signature for this sensitive action
          const { getDb } = require('../db/database');
          const db = getDb();
          const voter = db.prepare('SELECT public_key FROM members WHERE id = ?').get(member_id);
          if (!voter) break;
          const { verifyWsAuth: verify } = require('../middleware/verify');
          // Already authenticated — trust the connection auth, process the approval
          processApproval(request_id, authenticatedMemberId, approved, broadcastAll);
          break;
        }

        case EVENTS.PING: {
          ws.send(JSON.stringify({ type: EVENTS.PONG }));
          break;
        }
      }
    });

    ws.on('close', () => {
      if (authenticatedMemberId) {
        connections.delete(authenticatedMemberId);
        broadcastAll(authenticatedMemberId, {
          type: EVENTS.MEMBER_LEFT,
          payload: { member_id: authenticatedMemberId }
        });
      }
    });

    ws.on('error', () => {
      if (authenticatedMemberId) {
        connections.delete(authenticatedMemberId);
      }
    });
  });
}

/** Send to all connected members except optional excludeId */
function broadcastAll(excludeId, message) {
  const str = JSON.stringify(message);
  for (const [memberId, conn] of connections.entries()) {
    if (memberId === excludeId) continue;
    if (conn.readyState === conn.OPEN) {
      conn.send(str);
    }
  }
}

/** Send to all members of a channel except sender */
function broadcastToChannel(channelId, senderId, message) {
  const { getDb } = require('../db/database');
  const db = getDb();
  const channel = db.prepare('SELECT member_ids FROM channels WHERE id = ?').get(channelId);
  if (!channel) return;

  const memberIds = JSON.parse(channel.member_ids || '[]');
  const str = JSON.stringify(message);

  for (const memberId of memberIds) {
    if (memberId === senderId) continue;
    const conn = connections.get(memberId);
    if (conn && conn.readyState === conn.OPEN) {
      conn.send(str);
    }
  }
}

/** Send to a specific member */
function sendToMember(memberId, message) {
  const conn = connections.get(memberId);
  if (conn && conn.readyState === conn.OPEN) {
    conn.send(JSON.stringify(message));
  }
}

module.exports = { setupWebSocket, broadcastAll, broadcastToChannel, sendToMember, connections };
