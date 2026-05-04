const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const config = require('../config');
const { requireAuth } = require('../middleware/verify');
const { registerFounder, getMembers } = require('../controllers/member');
const { createJoinRequest, getJoinRequest, processApproval, isRequestsLocked, setRequestsLocked } = require('../controllers/consensus');
const { getChannelsForMember } = require('../controllers/message');
const { broadcastAll } = require('../websocket/handler');

// Helper to get real IP (works behind Render's proxy)
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || null;
}

// GET /api/status — public
router.get('/status', (req, res) => {
  const db = getDb();
  const founderSet = db.prepare("SELECT value FROM server_info WHERE key = 'founder_set'").get();
  const memberCount = db.prepare("SELECT COUNT(*) as count FROM members WHERE status = 'active'").get();
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const serverUrl = `${protocol}://${host}`;

  res.json({
    online: true,
    server_name: config.SERVER_NAME,
    server_url: serverUrl,
    member_count: memberCount.count,
    founder_set: !!(founderSet && founderSet.value === 'true'),
    requests_locked: isRequestsLocked()
  });
});

// POST /api/register — founder only, one-time
router.post('/register', (req, res) => {
  const { id, display_name, public_key, founder_key } = req.body;
  const result = registerFounder({ id, display_name, public_key, founder_key });
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

// GET /api/members — auth required
router.get('/members', requireAuth, (req, res) => {
  const members = getMembers();
  res.json({ members });
});

// POST /api/join-request — public
router.post('/join-request', (req, res) => {
  const { id, display_name, public_key } = req.body;
  const ip = getClientIp(req);
  const result = createJoinRequest({ id, display_name, public_key, ip });

  if (!result.success) {
    return res.status(400).json({ error: result.error, request_id: result.request_id });
  }

  broadcastAll(null, {
    type: 'JOIN_REQUEST',
    payload: {
      request_id: result.request_id,
      requester_id: id,
      requester_name: display_name,
      requester_public_key: public_key,
      expires_at: result.expires_at
    }
  });

  res.json({ request_id: result.request_id, expires_at: result.expires_at });
});

// GET /api/join-request/:request_id — public polling
router.get('/join-request/:request_id', (req, res) => {
  const request = getJoinRequest(req.params.request_id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  res.json({
    request_id: request.id,
    status: request.status,
    requester_name: request.requester_name,
    expires_at: request.expires_at
  });
});

// POST /api/approve/:request_id — auth required
router.post('/approve/:request_id', requireAuth, (req, res) => {
  const { approved } = req.body;
  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'approved must be a boolean' });
  }
  const result = processApproval(req.params.request_id, req.member.id, approved, broadcastAll);
  if (!result.success) return res.status(400).json({ error: result.error });
  res.json(result);
});

// GET /api/channels — auth required
router.get('/channels', requireAuth, (req, res) => {
  const channels = getChannelsForMember(req.member.id);
  res.json({ channels });
});

// POST /api/lock-requests — founder only
router.post('/lock-requests', requireAuth, (req, res) => {
  const db = getDb();
  const founderRow = db.prepare("SELECT value FROM server_info WHERE key = 'founder_id'").get();
  if (!founderRow || founderRow.value !== req.member.id) {
    return res.status(403).json({ error: 'Only the founder can lock or unlock join requests' });
  }

  const { locked } = req.body;
  if (typeof locked !== 'boolean') {
    return res.status(400).json({ error: 'locked must be a boolean' });
  }

  setRequestsLocked(locked);

  // Notify all online members of the change
  broadcastAll(null, {
    type: 'REQUESTS_LOCK_CHANGED',
    payload: { locked }
  });

  res.json({ success: true, requests_locked: locked });
});

module.exports = router;
