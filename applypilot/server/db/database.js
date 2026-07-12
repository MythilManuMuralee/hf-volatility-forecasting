import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

// Dual-backend storage:
//   - No DATABASE_URL  -> local SQLite file (zero config, laptop use)
//   - DATABASE_URL set -> Postgres (Neon/Render/Supabase) — survives restarts
//     on cloud hosts with ephemeral disks. CV files are stored as blobs in
//     the DB either way, so nothing depends on the local filesystem.
//
// API (all async): q(sql, params) -> rows · get(sql, params) -> row|undefined
//                  run(sql, params) -> {changes} · use RETURNING id via get()
// SQL is written in SQLite style with `?` placeholders; the pg backend
// converts placeholders to $1..$n and the few dialect differences live in
// the DDL + the NOW/TODAY constants below.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')

const IS_PG = Boolean(process.env.DATABASE_URL)
export const SQL_NOW = IS_PG ? 'now()' : "datetime('now')"
export const SQL_TODAY = IS_PG ? 'CURRENT_DATE::text' : "date('now')"

let ready

const SCHEMA_SQLITE = `
  CREATE TABLE IF NOT EXISTS cvs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    target_role TEXT DEFAULT '',
    file BLOB NOT NULL,
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
`

const SCHEMA_PG = `
  CREATE TABLE IF NOT EXISTS cvs (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    target_role TEXT DEFAULT '',
    file BYTEA NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS applications (
    id SERIAL PRIMARY KEY,
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
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS tailored_cvs (
    id SERIAL PRIMARY KEY,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    cv_id INTEGER NOT NULL REFERENCES cvs(id) ON DELETE CASCADE,
    paragraphs_json TEXT NOT NULL,
    margins_json TEXT,
    evaluation_json TEXT,
    rewrite_json TEXT,
    stress_json TEXT,
    rescore_json TEXT,
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(application_id, cv_id)
  );
`

let backend

async function initSqlite() {
  const { default: Database } = await import('better-sqlite3')
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  const db = new Database(path.join(DATA_DIR, 'applypilot.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQLITE)
  return {
    async q(sql, params = []) { return db.prepare(sql).all(...params) },
    async get(sql, params = []) { return db.prepare(sql).get(...params) },
    async run(sql, params = []) {
      const info = db.prepare(sql).run(...params)
      return { changes: info.changes }
    },
  }
}

async function initPg() {
  const { default: pg } = await import('pg')
  const url = process.env.DATABASE_URL
  const pool = new pg.Pool({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    max: 5,
  })
  await pool.query(SCHEMA_PG)
  const convert = sql => {
    let n = 0
    return sql.replace(/\?/g, () => `$${++n}`)
  }
  return {
    async q(sql, params = []) { return (await pool.query(convert(sql), params)).rows },
    async get(sql, params = []) { return (await pool.query(convert(sql), params)).rows[0] },
    async run(sql, params = []) {
      const result = await pool.query(convert(sql), params)
      return { changes: result.rowCount }
    },
  }
}

async function getBackend() {
  if (!ready) ready = IS_PG ? initPg() : initSqlite()
  backend = await ready
  return backend
}

export async function q(sql, params) { return (await getBackend()).q(sql, params) }
export async function get(sql, params) { return (await getBackend()).get(sql, params) }
export async function run(sql, params) { return (await getBackend()).run(sql, params) }
export const isPostgres = () => IS_PG
