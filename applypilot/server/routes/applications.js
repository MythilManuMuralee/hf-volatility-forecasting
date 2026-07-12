import express from 'express'
import { q, get, run, SQL_TODAY } from '../db/database.js'
import { fetchJobDescription } from '../lib/jd.js'

const router = express.Router()
const STATUSES = new Set(['Saved', 'Applied', 'Interview', 'Assessment', 'Offer', 'Rejected'])

router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query
    if (status && status !== 'All') {
      res.json(await q('SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC', [status]))
    } else {
      res.json(await q('SELECT * FROM applications ORDER BY created_at DESC'))
    }
  } catch (err) { next(err) }
})

router.post('/', async (req, res, next) => {
  try {
    const { title, company, location, url, jd_text, notes, deadline_date, source } = req.body
    if (!title) return res.status(400).json({ error: 'Title is required.' })
    if (url) {
      const existing = await get('SELECT id FROM applications WHERE url = ?', [url])
      if (existing) return res.json({ id: existing.id, existing: true })
    }
    const row = await get(`
      INSERT INTO applications (title, company, location, url, jd_text, notes, deadline_date, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `, [title, company || '', location || '', url || '', jd_text || '', notes || '', deadline_date || null, source || 'manual'])
    res.json({ id: row.id })
  } catch (err) { next(err) }
})

// Paste a job URL -> fetch and extract the JD server-side.
router.post('/from-url', async (req, res, next) => {
  try {
    const { url } = req.body
    if (!url) return res.status(400).json({ error: 'URL is required.' })
    const { title, text } = await fetchJobDescription(url)
    const existing = await get('SELECT id FROM applications WHERE url = ?', [url])
    if (existing) {
      await run("UPDATE applications SET jd_text = ? WHERE id = ? AND jd_text = ''", [text, existing.id])
      return res.json({ id: existing.id, existing: true })
    }
    const row = await get(
      'INSERT INTO applications (title, url, jd_text, source) VALUES (?, ?, ?, ?) RETURNING id',
      [title || url, url, text, 'url']
    )
    res.json({ id: row.id })
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const app = await get('SELECT * FROM applications WHERE id = ?', [req.params.id])
    if (!app) return res.status(404).json({ error: 'Application not found.' })
    res.json(app)
  } catch (err) { next(err) }
})

router.patch('/:id', async (req, res, next) => {
  try {
    const fields = []
    const values = []
    const { status, notes, date_applied, deadline_date, jd_text, title, company, location, url } = req.body
    if (status !== undefined) {
      if (!STATUSES.has(status)) return res.status(400).json({ error: 'Unsupported status.' })
      fields.push('status = ?'); values.push(status)
      if (status === 'Applied' && !req.body.date_applied) {
        fields.push(`date_applied = COALESCE(date_applied, ${SQL_TODAY})`)
      }
    }
    for (const [key, val] of [['notes', notes], ['date_applied', date_applied], ['deadline_date', deadline_date], ['jd_text', jd_text], ['title', title], ['company', company], ['location', location], ['url', url]]) {
      if (val !== undefined) { fields.push(`${key} = ?`); values.push(val) }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' })
    values.push(req.params.id)
    const result = await run(`UPDATE applications SET ${fields.join(', ')} WHERE id = ?`, values)
    if (!result.changes) return res.status(404).json({ error: 'Application not found.' })
    res.json(await get('SELECT * FROM applications WHERE id = ?', [req.params.id]))
  } catch (err) { next(err) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await run('DELETE FROM tailored_cvs WHERE application_id = ?', [req.params.id])
    await run('DELETE FROM applications WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

export default router
