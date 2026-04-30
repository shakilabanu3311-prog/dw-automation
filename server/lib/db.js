'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'hisab.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const raw = new Database(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL;');
raw.exec('PRAGMA foreign_keys = ON;');

raw.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'operator',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  label TEXT,
  expires_at TEXT NOT NULL,
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  meta TEXT
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  holder TEXT,
  acno TEXT,
  open_balance REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bank_txns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL,
  ts TEXT,
  bank_id INTEGER REFERENCES banks(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  amt REAL NOT NULL,
  detail TEXT,
  category TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  ext_ref TEXT UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bank_txns_date ON bank_txns(business_date);

CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  url TEXT,
  open_chips REAL DEFAULT 0,
  close_chips REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL,
  ts TEXT,
  panel_slug TEXT,
  type TEXT NOT NULL,
  amt REAL NOT NULL,
  name TEXT,
  chips REAL DEFAULT 0,
  utr TEXT,
  remark TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  ext_ref TEXT UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dw_date ON dw(business_date);

CREATE TABLE IF NOT EXISTS gpay (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL,
  ts TEXT,
  type TEXT NOT NULL,
  amt REAL NOT NULL,
  name TEXT,
  utr TEXT,
  panel_slug TEXT,
  bank_id INTEGER REFERENCES banks(id) ON DELETE SET NULL,
  remark TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  ext_ref TEXT UNIQUE,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_gpay_date ON gpay(business_date);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL,
  detail TEXT,
  amt REAL NOT NULL,
  category TEXT,          -- salary | atm | extra_payment | parking_in | parking_out | free_chips | other
  remark TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(business_date);

CREATE TABLE IF NOT EXISTS free_chips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL,
  panel_slug TEXT,
  amt REAL NOT NULL,
  remark TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fc_date ON free_chips(business_date);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Tombstones: when an operator deletes a scraped row (dw / gpay / bank_txns)
-- we record its ext_ref here so the next ingest cycle SKIPS it instead of
-- re-inserting the same row. Without this, deletes silently undo themselves
-- on the next scrape because ext_ref is the dedupe key — once the row is
-- gone, the dedupe check passes and the row is re-inserted.
CREATE TABLE IF NOT EXISTS deleted_ext_refs (
  ext_ref TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_by INTEGER REFERENCES users(id)
);

-- Daily sheet snapshots: at every 05:30 IST rollover (and on demand) we
-- save a frozen HTML render of each branch's Live Sheet for the just-
-- closed business date. Lets the operator scroll back through past days
-- even if the live data tables get trimmed. Auto-purge keeps only the
-- last 35 days so the DB doesn't grow forever.
CREATE TABLE IF NOT EXISTS sheet_snapshots (
  business_date TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'MAIN',
  html TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_date, branch)
);
CREATE INDEX IF NOT EXISTS idx_sheet_snapshots_date ON sheet_snapshots(business_date);

-- Manual cell overrides on the live sheet — lets the user type into any
-- cell in the Live Sheet and have it stick. (row,col) are 0-indexed grid
-- coordinates; business_date scopes the override to a specific day's sheet.
CREATE TABLE IF NOT EXISTS sheet_overrides (
  business_date TEXT NOT NULL,
  row INTEGER NOT NULL,
  col INTEGER NOT NULL,
  value TEXT,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_date, row, col)
);
CREATE INDEX IF NOT EXISTS idx_sheet_overrides_date ON sheet_overrides(business_date);
`);

// ── Idempotent column migrations (for DBs created before a column existed)
function ensureColumn(table, col, decl) {
  const info = raw.prepare(`PRAGMA table_info(${table})`).all();
  if (!info.find(r => r.name === col)) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }
}
ensureColumn('expenses', 'category', 'TEXT');
ensureColumn('expenses', 'remark', 'TEXT');
ensureColumn('expenses', 'employee', 'TEXT'); // for ATM withdrawals: who withdrew the cash
ensureColumn('bank_txns', 'balance', 'REAL');   // avl bal from SMS — used for gap detection
ensureColumn('bank_txns', 'mode', 'TEXT');      // UPI|IMPS|NEFT|RTGS|ATM|CARD|null

// ── Multi-branch support ───────────────────────────────────────────
// Each "branch" owns a set of panel slugs and a set of banks. The MAIN
// (aggregate) branch rolls everything up. branch_code lives as a string
// (B1/B2/B3/MAIN) so it survives reseeding without FK churn.
raw.exec(`
CREATE TABLE IF NOT EXISTS branches (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  panel_slugs TEXT NOT NULL DEFAULT '[]',
  is_aggregate INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
ensureColumn('banks', 'branch_code', 'TEXT');
ensureColumn('bank_txns', 'branch_code', 'TEXT');
ensureColumn('dw', 'branch_code', 'TEXT');
ensureColumn('gpay', 'branch_code', 'TEXT');
ensureColumn('expenses', 'branch_code', 'TEXT');

// ── Adapter to give better-sqlite3–like API on top of node:sqlite ──
function coerce(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}
function bindArgs(args) {
  return args.map(coerce);
}

function prepare(sql) {
  const stmt = raw.prepare(sql);
  return {
    all: (...args) => stmt.all(...bindArgs(args)),
    get: (...args) => stmt.get(...bindArgs(args)),
    run: (...args) => {
      const r = stmt.run(...bindArgs(args));
      return { changes: Number(r.changes || 0), lastInsertRowid: Number(r.lastInsertRowid || 0) };
    },
  };
}

function exec(sql) { raw.exec(sql); }

function transaction(fn) {
  return (...args) => {
    raw.exec('BEGIN');
    try { const out = fn(...args); raw.exec('COMMIT'); return out; }
    catch (e) { try { raw.exec('ROLLBACK'); } catch (_) {} throw e; }
  };
}

const db = { prepare, exec, transaction, raw };

function audit(userId, action, entity, entityId, meta) {
  try {
    db.prepare('INSERT INTO audit(user_id, action, entity, entity_id, meta) VALUES (?,?,?,?,?)')
      .run(userId || null, action, entity || null, entityId == null ? null : String(entityId), meta ? JSON.stringify(meta) : null);
  } catch (e) { /* ignore */ }
}

module.exports = { db, audit, DB_PATH };
