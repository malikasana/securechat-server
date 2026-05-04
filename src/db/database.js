const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/securechat.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(schema);

    // Migrations — safe to run every time
    const migrations = [
      "ALTER TABLE join_requests ADD COLUMN requester_ip TEXT"
    ];

    for (const migration of migrations) {
      try {
        db.prepare(migration).run();
      } catch (e) {
        // Column already exists — ignore
      }
    }
  }
  return db;
}

module.exports = { getDb };
