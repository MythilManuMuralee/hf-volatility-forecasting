import React, { useEffect, useState } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import Tracker from './pages/Tracker.jsx'
import Cvs from './pages/Cvs.jsx'
import Studio from './pages/Studio.jsx'
import { api, getAppKey, setAppKey } from './lib/api.js'

export default function App() {
  const [health, setHealth] = useState(null)
  const [unlocked, setUnlocked] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    ;(async () => {
      try {
        const h = await api.health()
        setHealth(h)
        if (!h.locked) { setUnlocked(true); return }
        if (getAppKey()) {
          try { await api.listCvs(); setUnlocked(true) } catch {}
        }
      } catch { setHealth({ ok: false }) }
      finally { setChecking(false) }
    })()
  }, [])

  if (health?.locked && !unlocked) {
    return checking ? null : <LockScreen onUnlocked={() => setUnlocked(true)} />
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">✈️ ApplyPilot</div>
        <nav>
          <NavLink to="/" end>Tracker</NavLink>
          <NavLink to="/cvs">My CVs</NavLink>
        </nav>
        {health && !health.hasApiKey && (
          <span className="badge warn" title="Add ANTHROPIC_API_KEY to applypilot/server/.env">
            API key missing — AI steps disabled
          </span>
        )}
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Tracker />} />
          <Route path="/cvs" element={<Cvs />} />
          <Route path="/studio/:appId" element={<Studio />} />
        </Routes>
      </main>
    </div>
  )
}

function LockScreen({ onUnlocked }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    setAppKey(password)
    try {
      await api.listCvs()
      onUnlocked()
    } catch {
      setAppKey('')
      setError('Wrong password.')
    } finally { setBusy(false) }
  }

  return (
    <div className="lock-screen">
      <form className="panel lock-panel" onSubmit={submit}>
        <div className="brand">✈️ ApplyPilot</div>
        <p className="muted small">This app is password-protected.</p>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="App password"
          autoFocus
        />
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy || !password}>{busy ? 'Checking…' : 'Unlock'}</button>
      </form>
    </div>
  )
}
