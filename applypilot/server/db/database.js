import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

let db

export function getDataDir() {
  return DATA_DIR
}

export function getDb() {
  if (db) return db
  db = new Database(path.join(DATA_DIR, 'applypilot.db'))
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS cvs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      target_role TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      company TEXT DEFAULT '',
      location TEXT DEFAULT '',
      url TEXT DEFAULT '',
      jd_text TEXT DEFAULT '',
      source TEXT DEFAULT 'manual',
      status TEXT DEFAULT 'Saved',
      notes TEXT DEFAULT '',
      deadline_date TEXT,
      date_applied TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- One tailored CV per (application, base cv). Holds the working copy of
    -- paragraph texts plus margin overrides so manual + AI edits accumulate.
    CREATE TABLE IF NOT EXISTS tailored_cvs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      cv_id INTEGER NOT NULL REFERENCES cvs(id) ON DELETE CASCADE,
      paragraphs_json TEXT NOT NULL,
      margins_json TEXT,
      evaluation_json TEXT,
      rewrite_json TEXT,
      stress_json TEXT,
      rescore_json TEXT,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(application_id, cv_id)
    );
  `)
  return db
}
