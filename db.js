const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'prospectpro.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sequences (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    steps_json  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS templates (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    subject  TEXT NOT NULL,
    body     TEXT NOT NULL,
    category TEXT
  );

  CREATE TABLE IF NOT EXISTS contacts (
    key        TEXT PRIMARY KEY,
    first_name TEXT,
    last_name  TEXT,
    entity     TEXT,
    email      TEXT,
    phone      TEXT,
    mail       TEXT,
    list_id    TEXT
  );

  CREATE TABLE IF NOT EXISTS enrollments (
    contact_key     TEXT PRIMARY KEY,
    sequence_id     TEXT NOT NULL,
    enrolled_at     TEXT NOT NULL,
    current_step    INTEGER NOT NULL DEFAULT 0,
    next_due_at     TEXT NOT NULL,
    next_due_time   TEXT NOT NULL DEFAULT '09:00',
    completed_steps TEXT NOT NULL DEFAULT '[]',
    status          TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS send_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_key  TEXT NOT NULL,
    sequence_id  TEXT NOT NULL,
    step_index   INTEGER NOT NULL,
    template_id  TEXT NOT NULL,
    sent_at      TEXT NOT NULL,
    status       TEXT NOT NULL,
    error        TEXT
  );
`);

module.exports = db;
