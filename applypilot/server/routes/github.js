import express from 'express'

const router = express.Router()

// Pull public repos for the linked GitHub profile so the Projects section can
// reference real, verifiable work. Unauthenticated GitHub API: 60 req/hr,
// plenty for one person. Set GITHUB_USERNAME in .env or pass ?username=.
router.get('/repos', async (req, res) => {
  const username = req.query.username || process.env.GITHUB_USERNAME
  if (!username) return res.status(400).json({ error: 'Set GITHUB_USERNAME in .env or pass ?username=' })
  try {
    const r = await fetch(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=pushed&per_page=30`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'applypilot' },
    })
    if (!r.ok) return res.status(r.status).json({ error: `GitHub API returned ${r.status}` })
    const repos = await r.json()
    res.json(repos.map(repo => ({
      name: repo.name,
      description: repo.description,
      language: repo.language,
      stars: repo.stargazers_count,
      url: repo.html_url,
      pushed_at: repo.pushed_at,
      topics: repo.topics || [],
    })))
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

export default router
