// Small word-level diff (LCS) for showing exactly which words the AI tweaked.
export function wordDiff(oldText, newText) {
  const a = String(oldText).split(/(\s+)/).filter(s => s !== '')
  const b = String(newText).split(/(\s+)/).filter(s => s !== '')
  const n = a.length, m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const parts = []
  let i = 0, j = 0
  const push = (type, text) => {
    const last = parts[parts.length - 1]
    if (last && last.type === type) last.text += text
    else parts.push({ type, text })
  }
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++ }
    else { push('add', b[j]); j++ }
  }
  while (i < n) { push('del', a[i]); i++ }
  while (j < m) { push('add', b[j]); j++ }
  return parts
}
