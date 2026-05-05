const { verifyWsAuth } = require('../middleware/verify');
const EVENTS = require('./events');
const { relayMessage } = require('../controllers/message');
const { processApproval } = require('../controllers/consensus');

// Map of memberId → WebSocket connection
const connections = new Map();

// Map of message_id → { sender_id, timer } for ACK tracking
const pendingAcks = new Map();

function setupWebSocket(wss) {
  wss.on('connection', (ws) => {
    let authenticatedMemberId = null;

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
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
          const { channel_id, encrypted_blob, sender_id, sender_curve25519_public_key, message_id, recipients } = data.payload || {};
          if (sender_id !== authenticatedMemberId) break;

          // ACK tracking — one ACK per recipient needed for DELIVERED
          if (message_id) {
            const recipientCount = recipients ? recipients.filter(r => r.member_id !== sender_id).length : null;
            pendingAcks.set(message_id, {
              sender_id,
              channel_id,
              expected: recipientCount,
              received: 0,
              timer: null
            });

            const timer = setTimeout(() => {
              const pending = pendingAcks.get(message_id);
              if (pending) {
                pendingAcks.delete(message_id);
                sendToMember(pending.sender_id, {
                  type: EVENTS.UNDELIVERED,
                  payload: { message_id }
                });
              }
            }, 10000);

            pendingAcks.get(message_id).timer = timer;
          }

          relayMessage(
            { channel_id, encrypted_blob, sender_id, sender_curve25519_public_key, message_id, recipients },
            sendToMember,
            broadcastToChannel
          );
          break;
        }

        case EVENTS.ACK: {
          const { message_id } = data.payload || {};
          if (!message_id) break;

          const pending = pendingAcks.get(message_id);
          if (pending) {
            pending.received += 1;
            // DELIVERED when all recipients acked, or if unknown recipient count just fire on first ACK
            if (pending.expected === null || pending.received >= pending.expected) {
              clearTimeout(pending.timer);
              pendingAcks.delete(message_id);
              sendToMember(pending.sender_id, {
                type: EVENTS.DELIVERED,
                payload: { message_id }
              });
            }
          }
          break;
        }

        case EVENTS.JOIN_RESPONSE: {
          const { request_id, approved, member_id } = data.payload || {};
          if (member_id !== authenticatedMemberId) break;
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
