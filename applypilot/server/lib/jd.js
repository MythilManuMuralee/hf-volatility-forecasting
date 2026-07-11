// Fetch a job posting URL and extract readable text. Works on public job
// pages (Greenhouse, Lever, Workable, company sites...). LinkedIn usually
// sits behind a login wall — for those the browser extension or manual
// paste is the reliable path, and we say so in the error.

function stripHtml(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
  s = s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  return s
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return m ? stripHtml(m[1]).slice(0, 200) : ''
}

export async function fetchJobDescription(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    const err = new Error('That does not look like a valid URL.')
    err.status = 400
    throw err
  }

  const res = await fetch(parsed.toString(), {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en',
    },
  })

  const isLinkedIn = /linkedin\.com/i.test(parsed.hostname)
  if (!res.ok) {
    const err = new Error(
      isLinkedIn
        ? `LinkedIn blocked the fetch (HTTP ${res.status}). Use the browser extension while viewing the job, or paste the job description text.`
        : `Could not fetch the page (HTTP ${res.status}). Paste the job description text instead.`
    )
    err.status = 422
    throw err
  }

  const html = await res.text()
  const text = stripHtml(html)
  if (isLinkedIn && (text.length < 400 || /sign in|join now/i.test(text.slice(0, 600)))) {
    const err = new Error('LinkedIn returned a login wall instead of the job. Use the browser extension while viewing the job, or paste the JD text.')
    err.status = 422
    throw err
  }
  if (text.length < 200) {
    const err = new Error('The page had almost no readable text (likely rendered by JavaScript). Paste the job description text instead.')
    err.status = 422
    throw err
  }
  return { title: extractTitle(html), text: text.slice(0, 30000) }
}
