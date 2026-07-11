import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { getDb, getDataDir } from '../db/database.js'
import { loadDocx, extractParagraphs, getSectionLayout, estimatePageFill } from '../lib/docx.js'

const router = express.Router()
const UPLOAD_DIR = path.join(getDataDir(), 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^\w.\- ]/g, '_')}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.originalname.toLowerCase().endsWith('.docx'))
  },
})

export function cvFilePath(cv) {
  return path.join(UPLOAD_DIR, cv.filename)
}

router.get('/', (req, res) => {
  const db = getDb()
  res.json(db.prepare('SELECT * FROM cvs ORDER BY created_at DESC').all())
})

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Upload a .docx file.' })
  try {
    const { doc } = await loadDocx(fs.readFileSync(req.file.path))
    const paragraphs = extractParagraphs(doc)
    const db = getDb()
    const result = db.prepare('INSERT INTO cvs (name, filename, target_role) VALUES (?, ?, ?)').run(
      req.body.name || req.file.originalname.replace(/\.docx$/i, ''),
      req.file.filename,
      req.body.target_role || ''
    )
    res.json({ id: result.lastInsertRowid, paragraphCount: paragraphs.length })
  } catch (err) {
    fs.unlinkSync(req.file.path)
    res.status(422).json({ error: `Could not parse that .docx: ${err.message}` })
  }
})

router.get('/:id', async (req, res) => {
  const db = getDb()
  const cv = db.prepare('SELECT * FROM cvs WHERE id = ?').get(req.params.id)
  if (!cv) return res.status(404).json({ error: 'CV not found.' })
  const { doc } = await loadDocx(fs.readFileSync(cvFilePath(cv)))
  const paragraphs = extractParagraphs(doc)
  const layout = getSectionLayout(doc)
  res.json({ ...cv, paragraphs, layout, page: estimatePageFill(paragraphs, layout) })
})

router.delete('/:id', (req, res) => {
  const db = getDb()
  const cv = db.prepare('SELECT * FROM cvs WHERE id = ?').get(req.params.id)
  if (cv) {
    try { fs.unlinkSync(cvFilePath(cv)) } catch {}
    db.prepare('DELETE FROM cvs WHERE id = ?').run(cv.id)
  }
  res.json({ success: true })
})

export default router
