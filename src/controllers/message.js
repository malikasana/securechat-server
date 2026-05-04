const { getDb } = require('../db/database');

/**
 * Relay an encrypted message blob to all other channel members.
 * Never stores content. Verifies membership only.
 */
function relayMessage({ channel_id, encrypted_blob, sender_id }, broadcastToChannel) {
  const db = getDb();

  // Verify channel exists
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channel_id);
  if (!channel) {
    return { success: false, error: 'Channel not found' };
  }

  const memberIds = JSON.parse(channel.member_ids || '[]');

  // Verify sender belongs to channel
  if (!memberIds.includes(sender_id)) {
    return { success: false, error: 'Sender is not a member of this channel' };
  }

  // Get sender display name for recipients
  const sender = db.prepare('SELECT display_name FROM members WHERE id = ?').get(sender_id);

  // Forward to all other members in channel — never store
  broadcastToChannel(channel_id, sender_id, {
    type: 'MESSAGE',
    payload: {
      channel_id,
      encrypted_blob,
      sender_id,
      sender_name: sender ? sender.display_name : 'Unknown'
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
