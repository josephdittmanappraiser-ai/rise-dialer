// SQLite database (built into Node 22). On Railway, mount a volume and the file survives deploys.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'dialer.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',          -- admin | agent
  identity TEXT NOT NULL UNIQUE,               -- Twilio client identity for the browser phone
  default_number_id INTEGER,                   -- caller ID used for this user's outbound calls/texts
  cell_phone TEXT,                             -- used for click-to-call and as a ring fallback
  ring_cell INTEGER NOT NULL DEFAULT 0,        -- also ring their cell on inbound calls
  status TEXT NOT NULL DEFAULT 'available',    -- available | away
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  friendly_name TEXT,
  twilio_sid TEXT,
  inbound_mode TEXT NOT NULL DEFAULT 'ring_all', -- user | ring_all | ai
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ai_agent_id INTEGER,                           -- answers when mode = ai, or after hours / no answer
  ai_on_no_answer INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  company TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  greeting TEXT,
  instructions TEXT NOT NULL,
  voice TEXT,
  transfer_number TEXT,          -- E.164 number, or blank = ring the team in the browser
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_sid TEXT UNIQUE,
  direction TEXT NOT NULL,        -- inbound | outbound
  kind TEXT NOT NULL DEFAULT 'human', -- human | ai | click_to_call
  from_number TEXT,
  to_number TEXT,
  our_number TEXT,
  other_number TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ai_agent_id INTEGER,
  ai_context TEXT,                -- extra instructions for this one AI call (who, why, goal)
  status TEXT,
  duration INTEGER,
  recording_sid TEXT,
  recording_url TEXT,
  voicemail INTEGER NOT NULL DEFAULT 0,
  transcript TEXT,                -- JSON array of {role, text}
  summary TEXT,
  outcome TEXT,
  notes TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_calls_other ON calls(other_number);
CREATE INDEX IF NOT EXISTS idx_calls_started ON calls(started_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sid TEXT UNIQUE,
  direction TEXT NOT NULL,        -- inbound | outbound
  our_number TEXT NOT NULL,
  other_number TEXT NOT NULL,
  body TEXT,
  media TEXT,                     -- JSON array of media URLs
  status TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sent_by TEXT,                   -- name of person / 'Claude' / 'AI agent'
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(other_number, our_number, created_at);
`);

// ---- migrations for databases created by earlier versions ---------------
function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
// Ring groups: ring several teammates (and optionally their cells / extra numbers) at once.
addColumn('phone_numbers', 'ring_group_enabled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('phone_numbers', 'ring_group_user_ids', "TEXT NOT NULL DEFAULT '[]'");
addColumn('phone_numbers', 'ring_group_cells', 'INTEGER NOT NULL DEFAULT 0');
addColumn('phone_numbers', 'ring_group_extra', "TEXT NOT NULL DEFAULT '[]'");

// ---- tiny helpers -------------------------------------------------------
const stmtCache = new Map();
function prep(sql) {
  let s = stmtCache.get(sql);
  if (!s) { s = db.prepare(sql); stmtCache.set(sql, s); }
  return s;
}
const all = (sql, ...p) => prep(sql).all(...p);
const get = (sql, ...p) => prep(sql).get(...p);
const run = (sql, ...p) => prep(sql).run(...p);

function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

// Build an UPDATE from an object of allowed columns.
function update(table, id, fields, allowed) {
  const keys = Object.keys(fields).filter((k) => allowed.includes(k) && fields[k] !== undefined);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}

module.exports = { db, all, get, run, getSetting, setSetting, update };
