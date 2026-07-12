import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { fileURLToPath } from 'url'
import cvsRouter from './routes/cvs.js'
import applicationsRouter from './routes/applications.js'
import tailorRouter from './routes/tailor.js'
import githubRouter from './routes/github.js'
import { get, run } from './db/database.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 4000

app.use(cors()) // permissive: personal localhost app + browser extension POSTs
app.use(express.json({ limit: '5mb' }))

// Single-user lock. Set APP_PASSWORD in .env and every /api route (except
// health) requires it — so a tunnel or cloud deployment stays yours only.
const APP_PASSWORD = process.env.APP_PASSWORD
app.use('/api', (req, res, next) => {
  if (!APP_PASSWORD || req.path === '/health') return next()
  // ?key= is accepted too so <a download> links (DOCX export) work when locked
  const key = req.headers['x-applypilot-key'] || req.query.key || (req.headers.authorization || '').replace(/^Bearer /, '')
  if (key === APP_PASSWORD) return next()
  res.status(401).json({ error: 'Locked — enter the app password.' })
})

app.use('/api/cvs', cvsRouter)
app.use('/api/applications', applicationsRouter)
app.use('/api/tailor', tailorRouter)
app.use('/api/github', githubRouter)

// Endpoint the browser extension posts LinkedIn jobs to.
app.post('/api/import', async (req, res, next) => {
  try {
    const { title, company, location, url, jd_text } = req.body
    if (!title && !jd_text) return res.status(400).json({ error: 'Nothing to import.' })
    if (url) {
      const existing = await get('SELECT id FROM applications WHERE url = ?', [url])
      if (existing) {
        if (jd_text) await run("UPDATE applications SET jd_text = ? WHERE id = ? AND jd_text = ''", [jd_text, existing.id])
        return res.json({ id: existing.id, existing: true })
      }
    }
    const row = await get(
      'INSERT INTO applications (title, company, location, url, jd_text, source) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      [title || 'Imported job', company || '', location || '', url || '', jd_text || '', 'linkedin-extension']
    )
    res.json({ id: row.id })
  } catch (err) { next(err) }
})

app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY), locked: Boolean(APP_PASSWORD) })
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

function lanAddresses() {
  const out = []
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address)
    }
  }
  return out
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ApplyPilot server on http://localhost:${PORT}`)
  const built = fs.existsSync(dist)
  for (const addr of lanAddresses()) {
    console.log(`  on your phone (same Wi-Fi): http://${addr}:${built ? PORT : 5173}`)
  }
  if (!built) {
    console.log('  (dev mode — phone uses the Vite port 5173; run `npm run build` once to serve everything on one port)')
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('⚠  ANTHROPIC_API_KEY not set — AI steps will fail until you add it to server/.env')
  }
})
