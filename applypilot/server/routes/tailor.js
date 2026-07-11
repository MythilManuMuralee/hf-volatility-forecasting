import express from 'express'
import fs from 'fs'
import { getDb } from '../db/database.js'
import { cvFilePath } from './cvs.js'
import { loadDocx, extractParagraphs, getSectionLayout, setMargins, replaceParagraphText, getParagraphNodes, saveDocx, estimatePageFill } from '../lib/docx.js'
import { evaluateCv, rewriteCv, stressTestCv } from '../lib/claude.js'

const router = express.Router()

function loadRow(db, applicationId, cvId) {
  return db.prepare('SELECT * FROM tailored_cvs WHERE application_id = ? AND cv_id = ?').get(applicationId, cvId)
}

async function getOrCreateTailored(applicationId, cvId) {
  const db = getDb()
  let row = loadRow(db, applicationId, cvId)
  if (!row) {
    const cv = db.prepare('SELECT * FROM cvs WHERE id = ?').get(cvId)
    if (!cv) { const e = new Error('CV not found.'); e.status = 404; throw e }
    const { doc } = await loadDocx(fs.readFileSync(cvFilePath(cv)))
    const paragraphs = extractParagraphs(doc)
    const layout = getSectionLayout(doc)
    db.prepare('INSERT INTO tailored_cvs (application_id, cv_id, paragraphs_json, margins_json) VALUES (?, ?, ?, ?)')
      .run(applicationId, cvId, JSON.stringify(paragraphs), JSON.stringify(layout))
    row = loadRow(db, applicationId, cvId)
  }
  return hydrate(row)
}

function hydrate(row) {
  return {
    ...row,
    paragraphs: JSON.parse(row.paragraphs_json),
    layout: JSON.parse(row.margins_json || 'null'),
    evaluation: JSON.parse(row.evaluation_json || 'null'),
    rewrite: JSON.parse(row.rewrite_json || 'null'),
    stress: JSON.parse(row.stress_json || 'null'),
    rescore: JSON.parse(row.rescore_json || 'null'),
  }
}

function persist(row, patch) {
  const db = getDb()
  const sets = []
  const values = []
  for (const [col, val] of Object.entries(patch)) {
    sets.push(`${col} = ?`)
    values.push(typeof val === 'string' || val === null ? val : JSON.stringify(val))
  }
  sets.push("updated_at = datetime('now')")
  values.push(row.id)
  db.prepare(`UPDATE tailored_cvs SET ${sets.join(', ')} WHERE id = ?`).run(...values)
}

function withPage(state) {
  const page = state.layout ? estimatePageFill(state.paragraphs, state.layout) : null
  return { ...state, page }
}

function getJd(applicationId) {
  const app = getDb().prepare('SELECT * FROM applications WHERE id = ?').get(applicationId)
  if (!app) { const e = new Error('Application not found.'); e.status = 404; throw e }
  if (!app.jd_text || app.jd_text.trim().length < 50) {
    const e = new Error('This application has no job description yet. Paste the JD first.')
    e.status = 400
    throw e
  }
  return app.jd_text
}

const cvText = paragraphs => paragraphs.map(p => p.text).join('\n')

// GET current tailored state (creates the working copy from the base CV on first touch)
router.get('/:applicationId/:cvId', async (req, res, next) => {
  try {
    res.json(withPage(await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)))
  } catch (err) { next(err) }
})

// Reset working copy back to the original CV
router.post('/:applicationId/:cvId/reset', async (req, res, next) => {
  try {
    const db = getDb()
    db.prepare('DELETE FROM tailored_cvs WHERE application_id = ? AND cv_id = ?').run(+req.params.applicationId, +req.params.cvId)
    res.json(withPage(await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)))
  } catch (err) { next(err) }
})

// STEP 1 — evaluate (also used for re-scoring after edits, stored separately)
router.post('/:applicationId/:cvId/evaluate', async (req, res, next) => {
  try {
    const state = await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)
    const jd = getJd(+req.params.applicationId)
    const evaluation = await evaluateCv(jd, cvText(state.paragraphs))
    const col = req.query.rescore === '1' ? 'rescore_json' : 'evaluation_json'
    persist(state, { [col]: evaluation })
    res.json({ evaluation })
  } catch (err) { next(err) }
})

// STEP 2 — rewrite: returns proposed edits; nothing is applied until /apply
router.post('/:applicationId/:cvId/rewrite', async (req, res, next) => {
  try {
    const state = await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)
    if (!state.evaluation) { const e = new Error('Run Step 1 (Evaluate) first.'); e.status = 400; throw e }
    const jd = getJd(+req.params.applicationId)
    const rewrite = await rewriteCv(jd, state.paragraphs, state.evaluation)
    persist(state, { rewrite_json: rewrite })
    res.json({ rewrite })
  } catch (err) { next(err) }
})

// STEP 3 — stress test the current working copy
router.post('/:applicationId/:cvId/stress', async (req, res, next) => {
  try {
    const state = await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)
    const jd = getJd(+req.params.applicationId)
    const stress = await stressTestCv(jd, state.paragraphs)
    persist(state, { stress_json: stress })
    res.json({ stress })
  } catch (err) { next(err) }
})

// Apply edits (from AI steps — after the user accepts them — or manual edits).
// Body: { edits: [{index, new_text}], margins?: {marginTopIn,...} }
router.post('/:applicationId/:cvId/apply', async (req, res, next) => {
  try {
    const state = await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)
    const { edits = [], margins } = req.body
    const byIndex = new Map(state.paragraphs.map(p => [p.index, p]))
    for (const edit of edits) {
      const para = byIndex.get(edit.index)
      if (para) para.text = String(edit.new_text)
    }
    const layout = margins ? { ...state.layout, ...margins } : state.layout
    persist(state, { paragraphs_json: state.paragraphs, margins_json: layout })
    res.json(withPage({ ...state, layout }))
  } catch (err) { next(err) }
})

// Export the tailored DOCX: original file + accumulated tweaks + margins.
router.get('/:applicationId/:cvId/export', async (req, res, next) => {
  try {
    const db = getDb()
    const state = await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)
    const cv = db.prepare('SELECT * FROM cvs WHERE id = ?').get(+req.params.cvId)
    const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(+req.params.applicationId)
    const { zip, doc } = await loadDocx(fs.readFileSync(cvFilePath(cv)))
    const nodes = getParagraphNodes(doc)
    const original = extractParagraphs(doc)
    for (const para of state.paragraphs) {
      if (nodes[para.index] != null && original[para.index] && original[para.index].text !== para.text) {
        replaceParagraphText(doc, nodes[para.index], para.text)
      }
    }
    if (state.layout) setMargins(doc, state.layout)
    const buffer = await saveDocx(zip, doc)
    const safe = s => (s || '').replace(/[^\w\- ]/g, '').trim().replace(/\s+/g, '_')
    const filename = `${safe(cv.name) || 'CV'}__${safe(app?.company) || safe(app?.title) || 'tailored'}.docx`
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(buffer)
  } catch (err) { next(err) }
})

export default router
