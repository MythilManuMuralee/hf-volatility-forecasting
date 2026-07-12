import express from 'express'
import multer from 'multer'
import { q, get, run } from '../db/database.js'
import { loadDocx, extractParagraphs, getSectionLayout, estimatePageFill } from '../lib/docx.js'

const router = express.Router()

// CV files live as blobs in the database (not on disk) so the app keeps its
// data on cloud hosts with ephemeral filesystems (e.g. Render free tier).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.originalname.toLowerCase().endsWith('.docx')),
})

export async function getCvFile(cvId) {
  const row = await get('SELECT * FROM cvs WHERE id = ?', [cvId])
  if (!row) { const e = new Error('CV not found.'); e.status = 404; throw e }
  return { ...row, buffer: Buffer.from(row.file) }
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await q('SELECT id, name, filename, target_role, created_at FROM cvs ORDER BY created_at DESC'))
  } catch (err) { next(err) }
})

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload a .docx file.' })
    let paragraphs
    try {
      const { doc } = await loadDocx(req.file.buffer)
      paragraphs = extractParagraphs(doc)
    } catch (err) {
      return res.status(422).json({ error: `Could not parse that .docx: ${err.message}` })
    }
    const row = await get(
      'INSERT INTO cvs (name, filename, target_role, file) VALUES (?, ?, ?, ?) RETURNING id',
      [req.body.name || req.file.originalname.replace(/\.docx$/i, ''), req.file.originalname, req.body.target_role || '', req.file.buffer]
    )
    res.json({ id: row.id, paragraphCount: paragraphs.length })
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const cv = await getCvFile(req.params.id)
    const { doc } = await loadDocx(cv.buffer)
    const paragraphs = extractParagraphs(doc)
    const layout = getSectionLayout(doc)
    const { file, buffer, ...meta } = cv
    res.json({ ...meta, paragraphs, layout, page: estimatePageFill(paragraphs, layout) })
  } catch (err) { next(err) }
})

router.delete('/:id', async (req, res, next) => {
  try {
    await run('DELETE FROM tailored_cvs WHERE cv_id = ?', [req.params.id])
    await run('DELETE FROM cvs WHERE id = ?', [req.params.id])
    res.json({ success: true })
  } catch (err) { next(err) }
})

export default router
