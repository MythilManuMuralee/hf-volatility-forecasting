import express from 'express'
import { getDb } from '../db/database.js'
import { fetchJobDescription } from '../lib/jd.js'

const router = express.Router()
const STATUSES = new Set(['Saved', 'Applied', 'Interview', 'Assessment', 'Offer', 'Rejected'])

router.get('/', (req, res) => {
  const db = getDb()
  const { status } = req.query
  let query = 'SELECT * FROM applications'
  const params = []
  if (status && status !== 'All') {
    query += ' WHERE status = ?'
    params.push(status)
  }
  query += ' ORDER BY created_at DESC'
  res.json(db.prepare(query).all(...params))
})

router.post('/', (req, res) => {
  const { title, company, location, url, jd_text, notes, deadline_date, source } = req.body
  if (!title) return res.status(400).json({ error: 'Title is required.' })
  const db = getDb()
  if (url) {
    const existing = db.prepare('SELECT id FROM applications WHERE url = ?').get(url)
    if (existing) return res.json({ id: existing.id, existing: true })
  }
  const result = db.prepare(`
    INSERT INTO applications (title, company, location, url, jd_text, notes, deadline_date, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, company || '', location || '', url || '', jd_text || '', notes || '', deadline_date || null, source || 'manual')
  res.json({ id: result.lastInsertRowid })
})

// Paste a job URL -> fetch and extract the JD server-side.
router.post('/from-url', async (req, res) => {
  try {
    const { url } = req.body
    if (!url) return res.status(400).json({ error: 'URL is required.' })
    const { title, text } = await fetchJobDescription(url)
    const db = getDb()
    const existing = db.prepare('SELECT id FROM applications WHERE url = ?').get(url)
    if (existing) {
      db.prepare('UPDATE applications SET jd_text = ? WHERE id = ? AND jd_text = \'\'').run(text, existing.id)
      return res.json({ id: existing.id, existing: true })
    }
    const result = db.prepare(
      'INSERT INTO applications (title, url, jd_text, source) VALUES (?, ?, ?, ?)'
    ).run(title || url, url, text, 'url')
    res.json({ id: result.lastInsertRowid })
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message })
  }
})

router.get('/:id', (req, res) => {
  const db = getDb()
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id)
  if (!app) return res.status(404).json({ error: 'Application not found.' })
  res.json(app)
})

router.patch('/:id', (req, res) => {
  const db = getDb()
  const fields = []
  const values = []
  const { status, notes, date_applied, deadline_date, jd_text, title, company, location, url } = req.body
  if (status !== undefined) {
    if (!STATUSES.has(status)) return res.status(400).json({ error: 'Unsupported status.' })
    fields.push('status = ?'); values.push(status)
    if (status === 'Applied' && !req.body.date_applied) {
      fields.push("date_applied = COALESCE(date_applied, date('now'))")
    }
  }
  for (const [key, val] of [['notes', notes], ['date_applied', date_applied], ['deadline_date', deadline_date], ['jd_text', jd_text], ['title', title], ['company', company], ['location', location], ['url', url]]) {
    if (val !== undefined) { fields.push(`${key} = ?`); values.push(val) }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' })
  values.push(req.params.id)
  const result = db.prepare(`UPDATE applications SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  if (!result.changes) return res.status(404).json({ error: 'Application not found.' })
  res.json(db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id))
})

router.delete('/:id', (req, res) => {
  getDb().prepare('DELETE FROM applications WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})

export default router
