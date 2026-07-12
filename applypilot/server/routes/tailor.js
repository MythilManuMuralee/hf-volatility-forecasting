import express from 'express'
import { q, get, run, SQL_NOW } from '../db/database.js'
import { getCvFile } from './cvs.js'
import { loadDocx, extractParagraphs, getSectionLayout, setMargins, replaceParagraphText, getParagraphNodes, saveDocx, estimatePageFill } from '../lib/docx.js'
import { evaluateCv, rewriteCv, stressTestCv, matchCvs } from '../lib/claude.js'

const router = express.Router()

async function getOrCreateTailored(applicationId, cvId) {
  let row = await get('SELECT * FROM tailored_cvs WHERE application_id = ? AND cv_id = ?', [applicationId, cvId])
  if (!row) {
    const cv = await getCvFile(cvId)
    const { doc } = await loadDocx(cv.buffer)
    const paragraphs = extractParagraphs(doc)
    const layout = getSectionLayout(doc)
    await run('INSERT INTO tailored_cvs (application_id, cv_id, paragraphs_json, margins_json) VALUES (?, ?, ?, ?)',
      [applicationId, cvId, JSON.stringify(paragraphs), JSON.stringify(layout)])
    row = await get('SELECT * FROM tailored_cvs WHERE application_id = ? AND cv_id = ?', [applicationId, cvId])
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

async function persist(row, patch) {
  const sets = []
  const values = []
  for (const [col, val] of Object.entries(patch)) {
    sets.push(`${col} = ?`)
    values.push(typeof val === 'string' || val === null ? val : JSON.stringify(val))
  }
  sets.push(`updated_at = ${SQL_NOW}`)
  values.push(row.id)
  await run(`UPDATE tailored_cvs SET ${sets.join(', ')} WHERE id = ?`, values)
}

function withPage(state) {
  const page = state.layout ? estimatePageFill(state.paragraphs, state.layout) : null
  return { ...state, page }
}

async function getJd(applicationId) {
  const app = await get('SELECT * FROM applications WHERE id = ?', [applicationId])
  if (!app) { const e = new Error('Application not found.'); e.status = 404; throw e }
  if (!app.jd_text || app.jd_text.trim().length < 50) {
    const e = new Error('This application has no job description yet. Paste the JD first.')
    e.status = 400
    throw e
  }
  return app.jd_text
}

const cvText = paragraphs => paragraphs.map(p => p.text).join('\n')

// Rank all uploaded CVs against this job's JD and recommend the best base CV.
router.post('/:applicationId/match', async (req, res, next) => {
  try {
    const jd = await getJd(+req.params.applicationId)
    const cvs = await q('SELECT id, name, target_role FROM cvs ORDER BY created_at DESC')
    if (!cvs.length) { const e = new Error('Upload at least one CV first.'); e.status = 400; throw e }
    if (cvs.length === 1) {
      return res.json({ match: {
        ranking: [{ cv_id: cvs[0].id, cv_name: cvs[0].name, score: 100, reason: 'Only CV in your library.' }],
        recommendation: `Only one CV uploaded (${cvs[0].name}) — using it. Upload more CVs and I'll pick the best fit per job.`,
      } })
    }
    const withText = []
    for (const cv of cvs) {
      const file = await getCvFile(cv.id)
      const { doc } = await loadDocx(file.buffer)
      withText.push({ ...cv, text: extractParagraphs(doc).map(p => p.text).join('\n') })
    }
    const match = await matchCvs(jd, withText)
    res.json({ match })
  } catch (err) { next(err) }
})

// GET current tailored state (creates the working copy from the base CV on first touch)
router.get('/:applicationId/:cvId', async (req, res, next) => {
  try {
    res.json(withPage(await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)))
  } catch (err) { next(err) }
})

// Reset working copy back to the original CV
router.post('/:applicationId/:cvId/reset', async (req, res, next) => {
  try {
    await run('DELETE FROM tailored_cvs WHERE application_id = ? AND cv_id = ?', [+req.params.applicationId, +req.params.cvId])
    res.json(withPage(await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)))
  } catch (err) { next(err) }
})

// STEP 1 — evaluate (also used for re-scoring after edits, stored separately)
router.post('/:applicationId/:cvId/evaluate', async (req, res, next) => {
  try {
    const state = await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)
    const jd = await getJd(+req.params.applicationId)
    const evaluation = await evaluateCv(jd, cvText(state.paragraphs))
    const col = req.query.rescore === '1' ? 'rescore_json' : 'evaluation_json'
    await persist(state, { [col]: evaluation })
    res.json({ evaluation })
  } catch (err) { next(err) }
})

// STEP 2 — rewrite: returns proposed edits; nothing is applied until /apply
router.post('/:applicationId/:cvId/rewrite', async (req, res, next) => {
  try {
    const state = await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)
    if (!state.evaluation) { const e = new Error('Run Step 1 (Evaluate) first.'); e.status = 400; throw e }
    const jd = await getJd(+req.params.applicationId)
    const rewrite = await rewriteCv(jd, state.paragraphs, state.evaluation)
    await persist(state, { rewrite_json: rewrite })
    res.json({ rewrite })
  } catch (err) { next(err) }
})

// STEP 3 — stress test the current working copy
router.post('/:applicationId/:cvId/stress', async (req, res, next) => {
  try {
    const state = await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)
    const jd = await getJd(+req.params.applicationId)
    const stress = await stressTestCv(jd, state.paragraphs)
    await persist(state, { stress_json: stress })
    res.json({ stress })
  } catch (err) { next(err) }
})

// Apply edits (accepted AI edits or manual edits) and/or margin overrides.
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
    await persist(state, { paragraphs_json: state.paragraphs, margins_json: layout })
    res.json(withPage({ ...state, layout }))
  } catch (err) { next(err) }
})

// Export the tailored DOCX: original file + accumulated tweaks + margins.
router.get('/:applicationId/:cvId/export', async (req, res, next) => {
  try {
    const state = await getOrCreateTailored(+req.params.applicationId, +req.params.cvId)
    const cv = await getCvFile(+req.params.cvId)
    const app = await get('SELECT * FROM applications WHERE id = ?', [+req.params.applicationId])
    const { zip, doc } = await loadDocx(cv.buffer)
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
