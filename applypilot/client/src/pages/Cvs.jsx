import React, { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'

export default function Cvs() {
  const [cvs, setCvs] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const fileRef = useRef()
  const [name, setName] = useState('')
  const [role, setRole] = useState('')

  const load = () => api.listCvs().then(setCvs).catch(e => setError(e.message))
  useEffect(() => { load() }, [])

  async function upload(e) {
    e.preventDefault()
    const file = fileRef.current.files[0]
    if (!file) return setError('Choose a .docx file.')
    setBusy(true); setError('')
    try {
      await api.uploadCv(file, name, role)
      fileRef.current.value = ''
      setName(''); setRole('')
      load()
    } catch (err) { setError(err.message) } finally { setBusy(false) }
  }

  async function show(cv) {
    setPreview({ loading: true, name: cv.name })
    try {
      setPreview(await api.getCv(cv.id))
    } catch (err) { setError(err.message); setPreview(null) }
  }

  async function remove(cv) {
    if (!window.confirm(`Delete CV "${cv.name}"? Tailored versions based on it will also go.`)) return
    await api.deleteCv(cv.id)
    if (preview?.id === cv.id) setPreview(null)
    load()
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>My CVs</h1>
          <p className="muted">Upload the resumes you already have (.docx). The app never rebuilds them — it only tweaks the wording, so your one-page layout survives.</p>
        </div>
      </div>

      {error && <div className="error" onClick={() => setError('')}>{error}</div>}

      <form className="upload-row" onSubmit={upload}>
        <input type="file" ref={fileRef} accept=".docx" />
        <input placeholder="Name (e.g. Quant CV)" value={name} onChange={e => setName(e.target.value)} />
        <input placeholder="Target role (e.g. AI Engineer)" value={role} onChange={e => setRole(e.target.value)} />
        <button className="primary" disabled={busy}>{busy ? 'Uploading…' : 'Upload CV'}</button>
      </form>

      <div className="cards">
        {cvs.map(cv => (
          <div key={cv.id} className="card">
            <div className="card-main">
              <strong>{cv.name}</strong>
              <div className="muted small">
                {cv.target_role && <span className="tag">{cv.target_role}</span>}
                <span className="tag">{cv.filename}</span>
              </div>
            </div>
            <div className="card-actions">
              <button className="button" onClick={() => show(cv)}>Preview</button>
              <button className="ghost danger" onClick={() => remove(cv)}>✕</button>
            </div>
          </div>
        ))}
        {cvs.length === 0 && <div className="empty">No CVs yet — upload your first .docx above.</div>}
      </div>

      {preview && (
        <div className="panel">
          <div className="panel-head">
            <h2>{preview.name}</h2>
            {preview.page && (
              <span className={`badge ${preview.page.fitsOnePage ? 'ok' : 'warn'}`}>
                page fill ~{Math.round(preview.page.fillRatio * 100)}%
              </span>
            )}
            <button className="ghost" onClick={() => setPreview(null)}>close</button>
          </div>
          {preview.loading ? 'Parsing…' : (
            <div className="cv-preview">
              {preview.paragraphs.map(p => (
                <p key={p.index} className={p.bold ? 'bold' : ''}>{p.text || ' '}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
