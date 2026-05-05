const { getDb } = require('../db/database');

/**
 * Relay encrypted blobs to recipients.
 * Supports both new per-recipient format and legacy single blob format.
 * Never stores content. Verifies membership only.
 */
function relayMessage({ channel_id, encrypted_blob, sender_id, sender_curve25519_public_key, message_id, recipients }, sendToMember, broadcastToChannel) {
  const db = getDb();

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel_id);
  if (!channel) return { success: false, error: 'Channel not found' };

  const memberIds = JSON.parse(channel.member_ids || '[]');
  if (!memberIds.includes(sender_id)) return { success: false, error: 'Sender is not a member of this channel' };

  const sender = db.prepare('SELECT display_name, curve25519_public_key FROM members WHERE id = ?').get(sender_id);
  const senderName = sender ? sender.display_name : 'Unknown';
  const senderCurve = sender_curve25519_public_key || (sender ? sender.curve25519_public_key : '');

  // New format — per-recipient encrypted blobs
  if (recipients && Array.isArray(recipients)) {
    for (const r of recipients) {
      if (!r.member_id || !r.encrypted_blob) continue;
      if (!memberIds.includes(r.member_id)) continue; // must be channel member
      if (r.member_id === sender_id) continue;
      sendToMember(r.member_id, {
        type: 'MESSAGE',
        payload: {
          channel_id,
          message_id,
          encrypted_blob: r.encrypted_blob,
          sender_id,
          sender_name: senderName,
          sender_curve25519_public_key: senderCurve
        }
      });
    }
    return { success: true };
  }

  // Legacy format — single blob broadcast to all channel members
  broadcastToChannel(channel_id, sender_id, {
    type: 'MESSAGE',
    payload: {
      channel_id,
      message_id,
      encrypted_blob,
      sender_id,
      sender_name: senderName,
      sender_curve25519_public_key: senderCurve
    }
  });

  return { success: true };
}

function getChannelsForMember(memberId) {
  const db = getDb();
  const allChannels = db.prepare('SELECT * FROM channels').all();

  return allChannels
    .filter(ch => {
      const ids = JSON.parse(ch.member_ids || '[]');
      return ids.includes(memberId);
    })
    .map(ch => ({
      id: ch.id,
      type: ch.type,
      member_ids: JSON.parse(ch.member_ids || '[]')
    }));
}

module.exports = { relayMessage, getChannelsForMember };
