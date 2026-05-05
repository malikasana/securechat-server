const { getDb } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

const EXPIRY_MS = 48 * 60 * 60 * 1000; // 48 hours

function isRequestsLocked() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM server_info WHERE key = 'requests_locked'").get();
  return !!(row && row.value === 'true');
}

function setRequestsLocked(locked) {
  const db = getDb();
  db.prepare("INSERT OR REPLACE INTO server_info (key, value) VALUES ('requests_locked', ?)").run(
    locked ? 'true' : 'false'
  );
}

function createJoinRequest({ id, display_name, public_key, curve25519_public_key, ip }) {
  const db = getDb();

  if (!id || !display_name || !public_key) {
    return { success: false, error: 'Missing required fields' };
  }

  if (isRequestsLocked()) {
    return { success: false, error: 'Join requests are currently closed by the server admin' };
  }

  const existing = db.prepare('SELECT id FROM members WHERE id = ? AND status = ?').get(id, 'active');
  if (existing) {
    return { success: false, error: 'Already a member' };
  }

  const nameTaken = db.prepare('SELECT id FROM members WHERE display_name = ? AND status = ?').get(display_name, 'active');
  if (nameTaken) return { success: false, error: 'Display name already taken.' };

  const pendingById = db.prepare(
    "SELECT id FROM join_requests WHERE requester_id = ? AND status = 'pending'"
  ).get(id);
  if (pendingById) {
    return { success: false, error: 'Already has a pending join request', request_id: pendingById.id };
  }

  if (ip) {
    const now = Date.now();
    const ipRecord = db.prepare('SELECT * FROM ip_cooldowns WHERE ip = ?').get(ip);
    if (ipRecord && now < ipRecord.expires_at) {
      const minutesLeft = Math.ceil((ipRecord.expires_at - now) / 60000);
      return {
        success: false,
        error: `A join request was already submitted from this device. Try again in ${minutesLeft} minute(s) if your previous request was rejected or expired.`
      };
    }
    if (ipRecord) {
      db.prepare('DELETE FROM ip_cooldowns WHERE ip = ?').run(ip);
    }
  }

  const requestId = uuidv4();
  const now = Date.now();
  const expiresAt = now + EXPIRY_MS;

  db.prepare(
    `INSERT INTO join_requests
      (id, requester_id, requester_name, requester_public_key, requester_curve25519_public_key, requester_ip, requested_at, expires_at, approvals, rejections, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(requestId, id, display_name, public_key, curve25519_public_key || '', ip || null, now, expiresAt, '[]', '[]', 'pending');

  if (ip) {
    db.prepare('INSERT OR REPLACE INTO ip_cooldowns (ip, requested_at, expires_at) VALUES (?, ?, ?)').run(
      ip, now, expiresAt
    );
  }

  return { success: true, request_id: requestId, expires_at: expiresAt };
}

function getJoinRequest(requestId) {
  const db = getDb();
  const req = db.prepare('SELECT * FROM join_requests WHERE id = ?').get(requestId);
  if (!req) return null;

  if (req.status === 'pending' && Date.now() > req.expires_at) {
    db.prepare("UPDATE join_requests SET status = 'expired' WHERE id = ?").run(requestId);
    _releaseIp(req.requester_ip);
    req.status = 'expired';
  }

  return req;
}

function processApproval(requestId, memberId, approved, broadcastFn) {
  const db = getDb();

  const request = db.prepare("SELECT * FROM join_requests WHERE id = ? AND status = 'pending'").get(requestId);
  if (!request) {
    return { success: false, error: 'Join request not found or not pending' };
  }

  if (Date.now() > request.expires_at) {
    db.prepare("UPDATE join_requests SET status = 'expired' WHERE id = ?").run(requestId);
    _releaseIp(request.requester_ip);
    return { success: false, error: 'Join request has expired' };
  }

  const voter = db.prepare('SELECT id FROM members WHERE id = ? AND status = ?').get(memberId, 'active');
  if (!voter) {
    return { success: false, error: 'Not a valid member' };
  }

  const approvals = JSON.parse(request.approvals || '[]');
  const rejections = JSON.parse(request.rejections || '[]');

  if (approvals.includes(memberId) || rejections.includes(memberId)) {
    return { success: false, error: 'Already voted on this request' };
  }

  if (!approved) {
    rejections.push(memberId);
    db.prepare(
      "UPDATE join_requests SET rejections = ?, status = 'rejected' WHERE id = ?"
    ).run(JSON.stringify(rejections), requestId);

    _releaseIp(request.requester_ip);

    broadcastFn(null, {
      type: 'JOIN_REQUEST_RESOLVED',
      payload: { request_id: requestId, status: 'rejected' }
    });

    return { success: true, status: 'rejected' };
  }

  approvals.push(memberId);
  db.prepare('UPDATE join_requests SET approvals = ? WHERE id = ?').run(JSON.stringify(approvals), requestId);

  const allMembers = db.prepare('SELECT id FROM members WHERE status = ?').all('active');
  const allApproved = allMembers.every(m => approvals.includes(m.id));

  if (allApproved) {
    db.prepare("UPDATE join_requests SET status = 'approved' WHERE id = ?").run(requestId);

    const now = Date.now();
    db.prepare(
      'INSERT INTO members (id, display_name, public_key, curve25519_public_key, joined_at, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(request.requester_id, request.requester_name, request.requester_public_key, request.requester_curve25519_public_key || '', now, 'active');

    const general = db.prepare("SELECT * FROM channels WHERE id = 'general'").get();
    if (general) {
      const memberIds = JSON.parse(general.member_ids || '[]');
      if (!memberIds.includes(request.requester_id)) {
        memberIds.push(request.requester_id);
        db.prepare("UPDATE channels SET member_ids = ? WHERE id = 'general'").run(JSON.stringify(memberIds));
      }
    }

    for (const m of allMembers) {
      const dmId = [m.id, request.requester_id].sort().join(':');
      const existingDm = db.prepare('SELECT id FROM channels WHERE id = ?').get(dmId);
      if (!existingDm) {
        db.prepare('INSERT INTO channels (id, type, member_ids) VALUES (?, ?, ?)').run(
          dmId, 'dm', JSON.stringify([m.id, request.requester_id])
        );
      }
    }

    _releaseIp(request.requester_ip);

    broadcastFn(null, {
      type: 'MEMBER_JOINED',
      payload: {
        member_id: request.requester_id,
        display_name: request.requester_name,
        public_key: request.requester_public_key,
        curve25519_public_key: request.requester_curve25519_public_key || ''
      }
    });

    return { success: true, status: 'approved' };
  }

  return { success: true, status: 'pending', approvals_count: approvals.length, total_members: allMembers.length };
}

function cleanupExpiredRequests() {
  const db = getDb();
  const now = Date.now();

  const expiredRequests = db.prepare(
    "SELECT requester_ip FROM join_requests WHERE status = 'pending' AND expires_at < ?"
  ).all(now);
  for (const r of expiredRequests) {
    if (r.requester_ip) _releaseIp(r.requester_ip);
  }

  const result = db.prepare(
    "UPDATE join_requests SET status = 'expired' WHERE status = 'pending' AND expires_at < ?"
  ).run(now);

  db.prepare('DELETE FROM ip_cooldowns WHERE expires_at < ?').run(now);

  if (result.changes > 0) {
    console.log(`[cleanup] Expired ${result.changes} join request(s)`);
  }
}

function _releaseIp(ip) {
  if (!ip) return;
  const db = getDb();
  db.prepare('DELETE FROM ip_cooldowns WHERE ip = ?').run(ip);
}

module.exports = {
  createJoinRequest,
  getJoinRequest,
  processApproval,
  cleanupExpiredRequests,
  isRequestsLocked,
  setRequestsLocked
};
