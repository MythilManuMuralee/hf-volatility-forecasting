async function request(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...options,
  })
  let data = null
  try { data = await res.json() } catch {}
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data
}

export const api = {
  health: () => request('/api/health'),

  listCvs: () => request('/api/cvs'),
  getCv: id => request(`/api/cvs/${id}`),
  uploadCv: (file, name, targetRole) => {
    const form = new FormData()
    form.append('file', file)
    if (name) form.append('name', name)
    if (targetRole) form.append('target_role', targetRole)
    return request('/api/cvs', { method: 'POST', body: form })
  },
  deleteCv: id => request(`/api/cvs/${id}`, { method: 'DELETE' }),

  listApplications: status => request(`/api/applications${status && status !== 'All' ? `?status=${status}` : ''}`),
  getApplication: id => request(`/api/applications/${id}`),
  createApplication: body => request('/api/applications', { method: 'POST', body: JSON.stringify(body) }),
  createFromUrl: url => request('/api/applications/from-url', { method: 'POST', body: JSON.stringify({ url }) }),
  updateApplication: (id, patch) => request(`/api/applications/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteApplication: id => request(`/api/applications/${id}`, { method: 'DELETE' }),

  getTailored: (appId, cvId) => request(`/api/tailor/${appId}/${cvId}`),
  resetTailored: (appId, cvId) => request(`/api/tailor/${appId}/${cvId}/reset`, { method: 'POST' }),
  evaluate: (appId, cvId, rescore) => request(`/api/tailor/${appId}/${cvId}/evaluate${rescore ? '?rescore=1' : ''}`, { method: 'POST' }),
  rewrite: (appId, cvId) => request(`/api/tailor/${appId}/${cvId}/rewrite`, { method: 'POST' }),
  stress: (appId, cvId) => request(`/api/tailor/${appId}/${cvId}/stress`, { method: 'POST' }),
  applyEdits: (appId, cvId, edits, margins) =>
    request(`/api/tailor/${appId}/${cvId}/apply`, { method: 'POST', body: JSON.stringify({ edits, margins }) }),
  exportUrl: (appId, cvId) => `/api/tailor/${appId}/${cvId}/export`,

  githubRepos: username => request(`/api/github/repos${username ? `?username=${encodeURIComponent(username)}` : ''}`),
}
