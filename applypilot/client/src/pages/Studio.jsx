import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { api } from '../lib/api.js'
import { wordDiff } from '../lib/diff.js'

export default function Studio() {
  const { appId } = useParams()
  const [app, setApp] = useState(null)
  const [cvs, setCvs] = useState([])
  const [cvId, setCvId] = useState(null)
  const [state, setState] = useState(null) // tailored state: paragraphs, layout, page, evaluation...
  const [pending, setPending] = useState([]) // proposed AI edits awaiting accept/reject
  const [pendingSource, setPendingSource] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [editingIndex, setEditingIndex] = useState(null)
  const [editText, setEditText] = useState('')
  const [showJd, setShowJd] = useState(false)
  const [jdDraft, setJdDraft] = useState('')
  const [repos, setRepos] = useState(null)
  const [match, setMatch] = useState(null)

  useEffect(() => {
    api.getApplication(appId).then(a => { setApp(a); setJdDraft(a.jd_text || '') }).catch(e => setError(e.message))
    api.listCvs().then(list => {
      setCvs(list)
      if (list.length) setCvId(prev => prev ?? list[0].id)
    }).catch(e => setError(e.message))
  }, [appId])

  const loadState = useCallback(() => {
    if (!cvId) return
    api.getTailored(appId, cvId).then(setState).catch(e => setError(e.message))
  }, [appId, cvId])
  useEffect(() => { setPending([]); setPendingSource(''); loadState() }, [loadState])

  async function run(step) {
    setBusy(step); setError('')
    try {
      if (step === 'evaluate') {
        await api.evaluate(appId, cvId)
      } else if (step === 'rewrite') {
        const { rewrite } = await api.rewrite(appId, cvId)
        setPending(rewrite.edits.map(e => ({ ...e, accepted: true })))
        setPendingSource('Step 2 · Rewrite')
      } else if (step === 'stress') {
        const { stress } = await api.stress(appId, cvId)
        if (stress.edits?.length) {
          setPending(stress.edits.map(e => ({ ...e, accepted: true })))
          setPendingSource('Step 3 · Stress test')
        }
      } else if (step === 'rescore') {
        await api.evaluate(appId, cvId, true)
      }
      loadState()
    } catch (err) { setError(err.message) } finally { setBusy('') }
  }

  async function applyPending() {
    const accepted = pending.filter(p => p.accepted).map(({ index, new_text }) => ({ index, new_text }))
    if (accepted.length) {
      setBusy('apply')
      try {
        setState(await api.applyEdits(appId, cvId, accepted))
      } catch (err) { setError(err.message) } finally { setBusy('') }
    }
    setPending([]); setPendingSource('')
  }

  async function saveManualEdit() {
    setBusy('apply')
    try {
      setState(await api.applyEdits(appId, cvId, [{ index: editingIndex, new_text: editText }]))
      setEditingIndex(null)
    } catch (err) { setError(err.message) } finally { setBusy('') }
  }

  async function nudgeMargins(deltaIn) {
    if (!state?.layout) return
    const l = state.layout
    const margins = {
      marginTopIn: Math.max(0.1, l.marginTopIn + deltaIn),
      marginBottomIn: Math.max(0.1, l.marginBottomIn + deltaIn),
      marginLeftIn: Math.max(0.15, l.marginLeftIn + deltaIn),
      marginRightIn: Math.max(0.15, l.marginRightIn + deltaIn),
    }
    setBusy('apply')
    try { setState(await api.applyEdits(appId, cvId, [], margins)) }
    catch (err) { setError(err.message) } finally { setBusy('') }
  }

  async function saveJd() {
    setBusy('jd')
    try {
      const updated = await api.updateApplication(appId, { jd_text: jdDraft })
      setApp(updated); setShowJd(false)
    } catch (err) { setError(err.message) } finally { setBusy('') }
  }

  async function pickBestCv() {
    setBusy('match'); setError('')
    try {
      const { match } = await api.matchCvs(appId)
      setMatch(match)
      if (match.ranking?.length) setCvId(match.ranking[0].cv_id)
    } catch (err) { setError(err.message) } finally { setBusy('') }
  }

  async function loadRepos() {
    setBusy('repos')
    try { setRepos(await api.githubRepos()) }
    catch (err) { setError(err.message) } finally { setBusy('') }
  }

  const pendingByIndex = useMemo(() => new Map(pending.map(p => [p.index, p])), [pending])
  const paragraphs = state?.paragraphs || []
  const evalData = state?.evaluation
  const rescore = state?.rescore

  if (!app) return <div className="page">Loading…</div>

  return (
    <div className="page studio">
      <div className="page-head">
        <div>
          <Link to="/" className="muted small">← Tracker</Link>
          <h1>{app.title}</h1>
          <p className="muted">{[app.company, app.location].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="head-actions">
          <button className="ghost" onClick={() => setShowJd(v => !v)}>
            {app.jd_text ? 'Edit JD' : '⚠ Paste JD'}
          </button>
          {cvId && (
            <a className="button primary" href={api.exportUrl(appId, cvId)}>⬇ Download tailored .docx</a>
          )}
        </div>
      </div>

      {error && <div className="error" onClick={() => setError('')}>{error}</div>}

      {showJd && (
        <div className="panel">
          <h2>Job description</h2>
          <textarea rows={12} value={jdDraft} onChange={e => setJdDraft(e.target.value)} placeholder="Paste the job description…" />
          <div className="modal-actions">
            <button className="ghost" onClick={() => setShowJd(false)}>Cancel</button>
            <button className="primary" onClick={saveJd} disabled={busy === 'jd'}>Save JD</button>
          </div>
        </div>
      )}

      <div className="toolbar">
        <label className="inline">Base CV:
          <select value={cvId ?? ''} onChange={e => setCvId(+e.target.value)}>
            {cvs.map(cv => <option key={cv.id} value={cv.id}>{cv.name}{cv.target_role ? ` (${cv.target_role})` : ''}</option>)}
          </select>
        </label>
        <button className="step" disabled={!!busy || !cvs.length} onClick={pickBestCv} title="Score every uploaded CV against this JD and select the best fit">
          {busy === 'match' ? 'Matching…' : '★ Pick best CV'}
        </button>
        <div className="spacer" />
        <button className="step" disabled={!!busy || !cvId} onClick={() => run('evaluate')}>
          {busy === 'evaluate' ? 'Scoring…' : '① Evaluate'}
        </button>
        <button className="step" disabled={!!busy || !cvId || !evalData} onClick={() => run('rewrite')}>
          {busy === 'rewrite' ? 'Rewriting…' : '② Rewrite'}
        </button>
        <button className="step" disabled={!!busy || !cvId} onClick={() => run('stress')}>
          {busy === 'stress' ? 'Testing…' : '③ Stress test'}
        </button>
        <button className="step" disabled={!!busy || !cvId || !evalData} onClick={() => run('rescore')}>
          {busy === 'rescore' ? 'Scoring…' : '↻ Re-score'}
        </button>
        <button className="ghost" disabled={!!busy || !cvId} onClick={async () => {
          if (window.confirm('Reset all tweaks back to the original CV?')) { setState(await api.resetTailored(appId, cvId)); setPending([]) }
        }}>Reset</button>
      </div>

      {match && (
        <div className="panel highlight">
          <div className="panel-head">
            <h2>★ Best CV for this job</h2>
            <button className="ghost" onClick={() => setMatch(null)}>close</button>
          </div>
          <p className="small">{match.recommendation}</p>
          <div className="match-list">
            {match.ranking.map((r, i) => (
              <button
                key={r.cv_id}
                className={`match-row ${r.cv_id === cvId ? 'selected' : ''}`}
                onClick={() => setCvId(r.cv_id)}
                title="Use this CV"
              >
                <span className="match-rank">{i === 0 ? '🏆' : `#${i + 1}`}</span>
                <strong>{r.cv_name}</strong>
                <span className="match-score">{r.score}/100</span>
                <span className="muted small match-reason">{r.reason}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(evalData || rescore) && (
        <div className="score-row">
          {evalData && <ScoreCard title="ATS score" before={evalData.ats_score} after={rescore?.ats_score} />}
          {evalData && <ScoreCard title="Hiring manager" before={evalData.hiring_manager_score} after={rescore?.hiring_manager_score} />}
          {evalData && (
            <div className="score-card wide">
              <div className="score-title">Interview probability</div>
              <div className="score-value small-text">{(rescore || evalData).interview_probability}</div>
            </div>
          )}
        </div>
      )}

      <div className="columns">
        <div className="col">
          <div className="panel">
            <div className="panel-head">
              <h2>CV — click any line to edit</h2>
              {state?.page && (
                <span className={`badge ${state.page.fitsOnePage ? 'ok' : 'warn'}`}>
                  {state.page.fitsOnePage ? 'fits one page' : 'OVER one page'} · ~{Math.round(state.page.fillRatio * 100)}%
                </span>
              )}
            </div>
            {state?.page && !state.page.fitsOnePage && (
              <div className="hint">Over a page — trim a bullet or squeeze the margins below.</div>
            )}
            <div className="margin-row muted small">
              Margins: {state?.layout ? `${state.layout.marginTopIn.toFixed(2)}" / ${state.layout.marginLeftIn.toFixed(2)}"` : '—'}
              <button className="chip" disabled={!!busy} onClick={() => nudgeMargins(-0.05)}>squeeze −0.05"</button>
              <button className="chip" disabled={!!busy} onClick={() => nudgeMargins(+0.05)}>relax +0.05"</button>
            </div>
            <div className="cv-preview">
              {paragraphs.map(p => {
                const prop = pendingByIndex.get(p.index)
                if (editingIndex === p.index) {
                  return (
                    <div key={p.index} className="editing">
                      <textarea rows={3} value={editText} onChange={e => setEditText(e.target.value)} autoFocus />
                      <div className="modal-actions">
                        <button className="ghost" onClick={() => setEditingIndex(null)}>Cancel</button>
                        <button className="primary" onClick={saveManualEdit} disabled={busy === 'apply'}>Save line</button>
                      </div>
                    </div>
                  )
                }
                return (
                  <p
                    key={p.index}
                    className={`${p.bold ? 'bold' : ''} ${prop ? 'has-pending' : ''} editable`}
                    title="Click to edit"
                    onClick={() => { setEditingIndex(p.index); setEditText(p.text) }}
                  >
                    {p.text || <span className="muted"> </span>}
                  </p>
                )
              })}
            </div>
          </div>
        </div>

        <div className="col">
          {pending.length > 0 && (
            <div className="panel highlight">
              <div className="panel-head">
                <h2>{pendingSource} — {pending.filter(p => p.accepted).length}/{pending.length} accepted</h2>
                <button className="primary" onClick={applyPending} disabled={busy === 'apply'}>Apply accepted</button>
              </div>
              {pending.map((edit, i) => {
                const original = paragraphs.find(p => p.index === edit.index)
                return (
                  <div key={i} className={`edit-proposal ${edit.accepted ? '' : 'rejected'}`}>
                    <label className="inline small">
                      <input
                        type="checkbox"
                        checked={edit.accepted}
                        onChange={() => setPending(list => list.map((e, j) => j === i ? { ...e, accepted: !e.accepted } : e))}
                      />
                      <span className="muted">line {edit.index} — {edit.reason}</span>
                    </label>
                    <div className="diff">
                      {wordDiff(original?.text || '', edit.new_text).map((part, k) => (
                        <span key={k} className={`diff-${part.type}`}>{part.text}</span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {evalData && (
            <div className="panel">
              <h2>Step 1 · Evaluation</h2>
              <p className="small">{evalData.summary}</p>
              <Facts label="Missing keywords" items={evalData.missing_keywords} chips />
              <Facts label="Red flags" items={evalData.red_flags} />
              <Facts label="Strengths" items={evalData.strengths} />
              <Facts label="Weak sections" items={evalData.weak_sections} />
            </div>
          )}

          {state?.stress && (
            <div className="panel">
              <h2>Step 3 · 6-second recruiter scan</h2>
              <p className="small"><strong>Verdict:</strong> {state.stress.verdict}</p>
              <Facts label="Gets attention" items={state.stress.attention_sections} />
              <Facts label="Skipped" items={state.stress.skipped_sections} />
              <Facts label="Feels generic" items={state.stress.generic_parts} />
              <Facts label="Would shortlist because" items={state.stress.shortlist_reasons} />
              <Facts label="Would reject because" items={state.stress.reject_reasons} />
            </div>
          )}

          <div className="panel">
            <div className="panel-head">
              <h2>GitHub projects</h2>
              <button className="ghost" onClick={loadRepos} disabled={busy === 'repos'}>{repos ? 'refresh' : 'load'}</button>
            </div>
            <p className="muted small">Real repos to reference in the Projects section — keeps every claim verifiable.</p>
            {repos && repos.map(r => (
              <div key={r.name} className="repo">
                <a href={r.url} target="_blank" rel="noreferrer"><strong>{r.name}</strong></a>
                {r.language && <span className="tag">{r.language}</span>}
                {r.stars > 0 && <span className="tag">★ {r.stars}</span>}
                <div className="muted small">{r.description}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ScoreCard({ title, before, after }) {
  const improved = after != null && after !== before
  return (
    <div className="score-card">
      <div className="score-title">{title}</div>
      <div className="score-value">
        {after != null ? (
          <>
            <span className="muted strike">{before}</span> {after}
            {improved && <span className={after > before ? 'delta up' : 'delta down'}>{after > before ? '▲' : '▼'}{Math.abs(after - before)}</span>}
          </>
        ) : before}
        <span className="outof">/100</span>
      </div>
    </div>
  )
}

function Facts({ label, items, chips }) {
  if (!items?.length) return null
  return (
    <div className="facts">
      <div className="facts-label">{label}</div>
      {chips ? (
        <div className="chip-wrap">{items.map((it, i) => <span key={i} className="tag">{it}</span>)}</div>
      ) : (
        <ul>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
      )}
    </div>
  )
}
