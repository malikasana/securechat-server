CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS join_requests (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  requester_public_key TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approvals TEXT DEFAULT '[]',
  rejections TEXT DEFAULT '[]',
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  member_ids TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS server_info (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Tracks IPs that have submitted a join request, cleared when request resolves
CREATE TABLE IF NOT EXISTS ip_cooldowns (
  ip TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
