import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import cvsRouter from './routes/cvs.js'
import applicationsRouter from './routes/applications.js'
import tailorRouter from './routes/tailor.js'
import githubRouter from './routes/github.js'
import { getDb } from './db/database.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 4000

app.use(cors()) // permissive: personal localhost app + browser extension POSTs
app.use(express.json({ limit: '5mb' }))

app.use('/api/cvs', cvsRouter)
app.use('/api/applications', applicationsRouter)
app.use('/api/tailor', tailorRouter)
app.use('/api/github', githubRouter)

// Endpoint the browser extension posts LinkedIn jobs to.
app.post('/api/import', (req, res) => {
  const { title, company, location, url, jd_text } = req.body
  if (!title && !jd_text) return res.status(400).json({ error: 'Nothing to import.' })
  const db = getDb()
  if (url) {
    const existing = db.prepare('SELECT id FROM applications WHERE url = ?').get(url)
    if (existing) {
      if (jd_text) db.prepare("UPDATE applications SET jd_text = ? WHERE id = ? AND jd_text = ''").run(jd_text, existing.id)
      return res.json({ id: existing.id, existing: true })
    }
  }
  const result = db.prepare(
    'INSERT INTO applications (title, company, location, url, jd_text, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title || 'Imported job', company || '', location || '', url || '', jd_text || '', 'linkedin-extension')
  res.json({ id: result.lastInsertRowid })
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY) })
})

// Serve the built client in production-style runs.
const dist = path.join(__dirname, '..', 'client', 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')))
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) ? err.status : 500
  res.status(status).json({ error: err.message || 'Something went wrong.' })
})

app.listen(PORT, () => {
  console.log(`ApplyPilot server on http://localhost:${PORT}`)
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠  ANTHROPIC_API_KEY not set — AI steps will fail until you add it to server/.env')
  }
})
