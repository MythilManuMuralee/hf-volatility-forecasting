import React, { useEffect, useState } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import Tracker from './pages/Tracker.jsx'
import Cvs from './pages/Cvs.jsx'
import Studio from './pages/Studio.jsx'
import { api } from './lib/api.js'

export default function App() {
  const [health, setHealth] = useState(null)
  useEffect(() => { api.health().then(setHealth).catch(() => setHealth({ ok: false })) }, [])

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
