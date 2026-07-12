// Injects a floating "Send to ApplyPilot" button on LinkedIn job pages.
// You are logged in, viewing jobs you saved — the button just reads what's on
// screen and POSTs it to your own app running on localhost. No scraping,
// no automation of your account.

const SERVER = 'http://localhost:4000'

function text(sel) {
  const el = document.querySelector(sel)
  return el ? el.innerText.trim() : ''
}

function scrapeJob() {
  const title =
    text('.job-details-jobs-unified-top-card__job-title') ||
    text('.jobs-unified-top-card__job-title') ||
    text('h1')
  const company =
    text('.job-details-jobs-unified-top-card__company-name') ||
    text('.jobs-unified-top-card__company-name') ||
    text('a[href*="/company/"]')
  const location =
    text('.job-details-jobs-unified-top-card__primary-description-container .tvm__text') ||
    text('.jobs-unified-top-card__bullet')
  const jd =
    text('#job-details') ||
    text('.jobs-description__content') ||
    text('.jobs-box__html-content')

  const m = document.location.href.match(/currentJobId=(\d+)/)
  const url = m
    ? `https://www.linkedin.com/jobs/view/${m[1]}/`
    : document.location.href.split('?')[0]

  return { title, company, location, url, jd_text: jd }
}

function makeButton() {
  if (document.getElementById('applypilot-btn')) return
  const btn = document.createElement('button')
  btn.id = 'applypilot-btn'
  btn.textContent = '✈️ Send to ApplyPilot'
  Object.assign(btn.style, {
    position: 'fixed', bottom: '24px', right: '24px', zIndex: 99999,
    background: '#4f8cff', color: '#fff', border: 'none', borderRadius: '999px',
    padding: '12px 18px', fontSize: '14px', fontWeight: '700', cursor: 'pointer',
    boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
  })
  btn.onclick = async () => {
    const job = scrapeJob()
    if (!job.title || !job.jd_text) {
      btn.textContent = '⚠ Open a job first'
      setTimeout(() => (btn.textContent = '✈️ Send to ApplyPilot'), 2000)
      return
    }
    btn.textContent = 'Sending…'
    try {
      const send = () => fetch(`${SERVER}/api/import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(localStorage.getItem('applypilot_key') ? { 'x-applypilot-key': localStorage.getItem('applypilot_key') } : {}),
        },
        body: JSON.stringify(job),
      })
      let res = await send()
      if (res.status === 401) {
        const pw = window.prompt('ApplyPilot password:')
        if (pw) { localStorage.setItem('applypilot_key', pw); res = await send() }
      }
      const data = await res.json()
      btn.textContent = res.ok ? (data.existing ? '✓ Already saved' : '✓ Saved to ApplyPilot') : '✗ ' + (data.error || 'Failed')
    } catch {
      btn.textContent = '✗ Is ApplyPilot running?'
    }
    setTimeout(() => (btn.textContent = '✈️ Send to ApplyPilot'), 2500)
  }
  document.body.appendChild(btn)
}

makeButton()
// LinkedIn is a SPA — re-add the button as you navigate between jobs.
new MutationObserver(() => makeButton()).observe(document.body, { childList: true, subtree: true })
