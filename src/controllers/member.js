const { getDb } = require('../db/database');
const config = require('../config');

function registerFounder({ id, display_name, public_key, founder_key }) {
  const db = getDb();

  const founderSet = db.prepare("SELECT value FROM server_info WHERE key = 'founder_set'").get();
  if (founderSet && founderSet.value === 'true') {
    return { success: false, error: 'Founder already registered. Registration is closed.' };
  }

  if (!founder_key || founder_key !== config.FOUNDER_KEY) {
    return { success: false, error: 'Invalid founder key' };
  }

  if (!id || !display_name || !public_key) {
    return { success: false, error: 'Missing required fields' };
  }

  const existing = db.prepare('SELECT id FROM members WHERE id = ?').get(id);
  if (existing) {
    return { success: false, error: 'Member ID already exists' };
  }

  // Check display name uniqueness
  const nameTaken = db.prepare('SELECT id FROM members WHERE display_name = ? AND status = ?').get(display_name, 'active');
  if (nameTaken) return { success: false, error: 'Display name already taken.' };

  const now = Date.now();

  db.prepare(
    'INSERT INTO members (id, display_name, public_key, joined_at, status) VALUES (?, ?, ?, ?, ?)'
  ).run(id, display_name, public_key, now, 'active');

  const channelId = 'general';
  const existingGeneral = db.prepare('SELECT id FROM channels WHERE id = ?').get(channelId);
  if (!existingGeneral) {
    db.prepare('INSERT INTO channels (id, type, member_ids) VALUES (?, ?, ?)').run(
      channelId, 'general', JSON.stringify([id])
    );
  } else {
    const memberIds = JSON.parse(existingGeneral.member_ids || '[]');
    if (!memberIds.includes(id)) {
      memberIds.push(id);
      db.prepare('UPDATE channels SET member_ids = ? WHERE id = ?').run(JSON.stringify(memberIds), channelId);
    }
  }

  db.prepare("INSERT OR REPLACE INTO server_info (key, value) VALUES ('founder_set', 'true')").run();
  db.prepare("INSERT OR REPLACE INTO server_info (key, value) VALUES ('founder_id', ?)").run(id);

  return { success: true, is_founder: true, member_id: id };
}

function getMembers() {
  const db = getDb();
  return db.prepare('SELECT id, display_name, public_key, joined_at FROM members WHERE status = ?').all('active');
}

module.exports = { registerFounder, getMembers };
