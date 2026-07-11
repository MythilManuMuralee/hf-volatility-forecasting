import React, { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'

const STATUSES = ['Saved', 'Applied', 'Interview', 'Assessment', 'Offer', 'Rejected']
const ALL = ['All', ...STATUSES]

export default function Tracker() {
  const [status, setStatus] = useState('All')
  const [apps, setApps] = useState([])
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)

  const load = useCallback(() => {
    api.listApplications(status).then(setApps).catch(e => setError(e.message))
  }, [status])
  useEffect(load, [load])

  async function setAppStatus(app, newStatus) {
    try {
      await api.updateApplication(app.id, { status: newStatus })
      load()
    } catch (e) { setError(e.message) }
  }

  async function remove(app) {
    if (!window.confirm(`Delete "${app.title}"?`)) return
    await api.deleteApplication(app.id)
    load()
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Application Tracker</h1>
          <p className="muted">Jobs from pasted links, pasted JDs, or the LinkedIn extension. Move each one from Saved to a final outcome.</p>
        </div>
        <button className="primary" onClick={() => setShowAdd(true)}>+ Add job</button>
      </div>

      {error && <div className="error" onClick={() => setError('')}>{error}</div>}

      <div className="filter-row">
        {ALL.map(s => (
          <button key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>{s}</button>
        ))}
      </div>

      {apps.length === 0 ? (
        <div className="empty">No applications here yet. Add a job with a link, a pasted JD, or from LinkedIn via the extension.</div>
      ) : (
        <div className="cards">
          {apps.map(app => (
            <div key={app.id} className="card">
              <div className="card-main">
                <div className="card-title-row">
                  <strong>{app.title}</strong>
                  <span className={`status status-${app.status.toLowerCase()}`}>{app.status}</span>
                </div>
                <div className="muted small">
                  {[app.company, app.location].filter(Boolean).join(' · ')}
                  {app.source !== 'manual' && <span className="tag">{app.source}</span>}
                  {app.deadline_date && <span className="tag">⏰ {app.deadline_date}</span>}
                  {!app.jd_text && <span className="tag warn-tag">no JD yet</span>}
                </div>
              </div>
              <div className="card-actions">
                <select value={app.status} onChange={e => setAppStatus(app, e.target.value)}>
                  {STATUSES.map(s => <option key={s}>{s}</option>)}
                </select>
                <Link className="button" to={`/studio/${app.id}`}>Tailor CV →</Link>
                {app.url && <a className="button ghost" href={app.url} target="_blank" rel="noreferrer">Job page</a>}
                <button className="ghost danger" onClick={() => remove(app)}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && <AddJobModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load() }} />}
    </div>
  )
}

function AddJobModal({ onClose, onSaved }) {
  const [mode, setMode] = useState('url')
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [company, setCompany] = useState('')
  const [location, setLocation] = useState('')
  const [jd, setJd] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (mode === 'url') {
        await api.createFromUrl(url)
      } else {
        if (!title) throw new Error('Give the job a title.')
        await api.createApplication({ title, company, location, url, jd_text: jd })
      }
      onSaved()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>Add a job</h2>
        <div className="filter-row">
          <button className={`chip ${mode === 'url' ? 'active' : ''}`} onClick={() => setMode('url')}>Paste a link</button>
          <button className={`chip ${mode === 'jd' ? 'active' : ''}`} onClick={() => setMode('jd')}>Paste the JD</button>
        </div>
        <form onSubmit={submit}>
          {mode === 'url' ? (
            <>
              <label>Job posting URL
                <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." required />
              </label>
              <p className="muted small">Works on public job pages. LinkedIn links usually need login — use the browser extension on the job page, or switch to "Paste the JD".</p>
            </>
          ) : (
            <>
              <label>Job title
                <input value={title} onChange={e => setTitle(e.target.value)} placeholder="AI Engineer" required />
              </label>
              <div className="two-col">
                <label>Company <input value={company} onChange={e => setCompany(e.target.value)} /></label>
                <label>Location <input value={location} onChange={e => setLocation(e.target.value)} /></label>
              </div>
              <label>Job link (optional) <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." /></label>
              <label>Job description
                <textarea rows={10} value={jd} onChange={e => setJd(e.target.value)} placeholder="Paste the full job description here…" required />
              </label>
            </>
          )}
          {error && <div className="error">{error}</div>}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={onClose}>Cancel</button>
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Adding…' : 'Add job'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
