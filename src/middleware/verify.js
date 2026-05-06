const forge = require('node-forge');
const { getDb } = require('../db/database');

const TIMESTAMP_TOLERANCE_MS = 60000; // 60 seconds

/**
 * Verifies: base64(sign(member_id + timestamp, private_key))
 * The signature payload is: member_id + timestamp (as string)
 *
 * Client sends:
 *   x-member-id: <member_id>
 *   x-signature: <base64(sign(member_id + timestamp_ms_string, privateKey))>
 *   x-timestamp: <timestamp_ms>
 */
function verifySignature(memberId, signatureB64, timestamp, publicKeyPem) {
  try {
    const now = Date.now();
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(now - ts) > TIMESTAMP_TOLERANCE_MS) {
      return { valid: false, reason: 'Timestamp out of range' };
    }

    const payload = memberId + ts.toString();
    const signatureBytes = forge.util.decode64(signatureB64);
    const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
    const md = forge.md.sha256.create();
    md.update(payload, 'utf8');

    const valid = publicKey.verify(md.digest().bytes(), signatureBytes);
    return { valid, reason: valid ? null : 'Signature mismatch' };
  } catch (err) {
    return { valid: false, reason: 'Signature verification error: ' + err.message };
  }
}

function requireAuth(req, res, next) {
  const memberId = req.headers['x-member-id'];
  const signature = req.headers['x-signature'];
  const timestamp = req.headers['x-timestamp'];

  if (!memberId || !signature || !timestamp) {
    return res.status(401).json({ error: 'Missing auth headers' });
  }

  const db = getDb();
  const member = db.prepare('SELECT * FROM members WHERE id = ? AND status = ?').get(memberId, 'active');
  if (!member) {
    return res.status(401).json({ error: 'Member not found' });
  }

  const result = verifySignature(memberId, signature, timestamp, member.public_key);
  if (!result.valid) {
    return res.status(401).json({ error: result.reason });
  }

  req.member = member;
  next();
}

function verifyWsAuth(memberId, signatureB64, timestamp) {
  const db = getDb();
  const member = db.prepare('SELECT * FROM members WHERE id = ? AND status = ?').get(memberId, 'active');
  if (!member) return { valid: false, reason: 'Member not found' };

  return verifySignature(memberId, signatureB64, timestamp, member.public_key);
}

module.exports = { requireAuth, verifyWsAuth };
