import JSZip from 'jszip'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

// Surgical DOCX editing: we never rebuild the document, we only swap the text
// inside existing paragraphs (keeping the first run's formatting) and adjust
// section margins. That is what keeps the user's layout/fonts/one-page format
// intact — the AI and manual edits are "tweaks", not a regeneration.

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const TWIPS_PER_INCH = 1440

export async function loadDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer)
  const xml = await zip.file('word/document.xml').async('string')
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  return { zip, doc }
}

export async function saveDocx(zip, doc) {
  const xml = new XMLSerializer().serializeToString(doc)
  zip.file('word/document.xml', xml)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function childrenByTag(node, tag) {
  const out = []
  for (let n = node.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.localName === tag) out.push(n)
  }
  return out
}

function descendantsByTag(node, tag) {
  const out = []
  ;(function walk(n) {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) {
        if (c.localName === tag) out.push(c)
        walk(c)
      }
    }
  })(node)
  return out
}

function getBody(doc) {
  return descendantsByTag(doc.documentElement, 'body')[0] || doc.documentElement
}

export function getParagraphNodes(doc) {
  // Top-level paragraphs only (this CV format has no tables).
  return childrenByTag(getBody(doc), 'p')
}

function runText(run) {
  let text = ''
  for (let c = run.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue
    if (c.localName === 't') text += c.textContent
    else if (c.localName === 'tab') text += '\t'
    else if (c.localName === 'br') text += '\n'
  }
  return text
}

function paragraphRuns(p) {
  // Direct runs plus runs nested in hyperlinks, in document order.
  const runs = []
  for (let c = p.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue
    if (c.localName === 'r') runs.push(c)
    else if (c.localName === 'hyperlink') runs.push(...childrenByTag(c, 'r'))
  }
  return runs
}

export function paragraphText(p) {
  return paragraphRuns(p).map(runText).join('')
}

function halfPointsToPt(v) {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n / 2 : null
}

function runFontSize(run) {
  const rPr = childrenByTag(run, 'rPr')[0]
  if (!rPr) return null
  const sz = childrenByTag(rPr, 'sz')[0]
  return sz ? halfPointsToPt(sz.getAttributeNS(W, 'val') || sz.getAttribute('w:val')) : null
}

function runIsBold(run) {
  const rPr = childrenByTag(run, 'rPr')[0]
  if (!rPr) return false
  const b = childrenByTag(rPr, 'b')[0]
  if (!b) return false
  const val = b.getAttributeNS(W, 'val') || b.getAttribute('w:val')
  return val !== '0' && val !== 'false'
}

export function extractParagraphs(doc) {
  return getParagraphNodes(doc).map((p, index) => {
    const runs = paragraphRuns(p)
    const sizes = runs.map(runFontSize).filter(v => v != null)
    return {
      index,
      text: paragraphText(p),
      bold: runs.some(runIsBold),
      fontSize: sizes.length ? Math.max(...sizes) : null,
    }
  })
}

function attr(el, name) {
  return el.getAttributeNS(W, name) || el.getAttribute('w:' + name)
}

export function getSectionLayout(doc) {
  const sectPr = descendantsByTag(getBody(doc), 'sectPr')[0]
  const layout = {
    pageWidthIn: 8.5, pageHeightIn: 11,
    marginTopIn: 1, marginBottomIn: 1, marginLeftIn: 1, marginRightIn: 1,
  }
  if (!sectPr) return layout
  const pgSz = childrenByTag(sectPr, 'pgSz')[0]
  if (pgSz) {
    const w = parseInt(attr(pgSz, 'w'), 10)
    const h = parseInt(attr(pgSz, 'h'), 10)
    if (w) layout.pageWidthIn = w / TWIPS_PER_INCH
    if (h) layout.pageHeightIn = h / TWIPS_PER_INCH
  }
  const pgMar = childrenByTag(sectPr, 'pgMar')[0]
  if (pgMar) {
    for (const [key, prop] of [['top', 'marginTopIn'], ['bottom', 'marginBottomIn'], ['left', 'marginLeftIn'], ['right', 'marginRightIn']]) {
      const v = parseInt(attr(pgMar, key), 10)
      if (Number.isFinite(v)) layout[prop] = v / TWIPS_PER_INCH
    }
  }
  return layout
}

export function setMargins(doc, marginsIn) {
  const sectPr = descendantsByTag(getBody(doc), 'sectPr')[0]
  if (!sectPr) return
  const pgMar = childrenByTag(sectPr, 'pgMar')[0]
  if (!pgMar) return
  const map = { top: 'marginTopIn', bottom: 'marginBottomIn', left: 'marginLeftIn', right: 'marginRightIn' }
  for (const [key, prop] of Object.entries(map)) {
    const val = marginsIn[prop]
    if (val == null) continue
    const twips = String(Math.max(72, Math.round(val * TWIPS_PER_INCH)))
    if (pgMar.hasAttributeNS(W, key)) pgMar.setAttributeNS(W, 'w:' + key, twips)
    else pgMar.setAttribute('w:' + key, twips)
  }
}

export function replaceParagraphText(doc, p, newText) {
  const runs = paragraphRuns(p)
  if (!runs.length) {
    if (!newText) return
    const r = doc.createElementNS(W, 'w:r')
    const t = doc.createElementNS(W, 'w:t')
    t.setAttribute('xml:space', 'preserve')
    t.appendChild(doc.createTextNode(newText))
    r.appendChild(t)
    p.appendChild(r)
    return
  }

  const template = runs[0]
  const templateRPr = childrenByTag(template, 'rPr')[0] || null
  const anchor = template.parentNode.localName === 'hyperlink' ? template.parentNode : template
  const parent = p

  // Mark the insertion point with a placeholder (the anchor itself is about
  // to be removed), then strip every existing run / hyperlink.
  const placeholder = doc.createComment('applypilot')
  parent.insertBefore(placeholder, anchor)
  for (let c = parent.firstChild; c; ) {
    const next = c.nextSibling
    if (c.nodeType === 1 && (c.localName === 'r' || c.localName === 'hyperlink')) parent.removeChild(c)
    c = next
  }

  const makeRun = () => {
    const r = doc.createElementNS(W, 'w:r')
    if (templateRPr) r.appendChild(templateRPr.cloneNode(true))
    return r
  }

  // Rebuild runs, preserving tab stops (headings use "text\tright-aligned text").
  const segments = String(newText).split('\t')
  const newNodes = []
  segments.forEach((seg, i) => {
    if (i > 0) {
      const r = makeRun()
      r.appendChild(doc.createElementNS(W, 'w:tab'))
      newNodes.push(r)
    }
    if (seg.length) {
      const r = makeRun()
      const t = doc.createElementNS(W, 'w:t')
      t.setAttribute('xml:space', 'preserve')
      t.appendChild(doc.createTextNode(seg))
      r.appendChild(t)
      newNodes.push(r)
    }
  })
  for (const node of newNodes) parent.insertBefore(node, placeholder)
  parent.removeChild(placeholder)
}

// Heuristic single-page estimator. Not typographically exact, but stable and
// monotonic — good enough to warn "you just went over one page" and to show
// how a margin tweak buys room.
export function estimatePageFill(paragraphs, layout) {
  const usableWidthPt = (layout.pageWidthIn - layout.marginLeftIn - layout.marginRightIn) * 72
  const usableHeightPt = (layout.pageHeightIn - layout.marginTopIn - layout.marginBottomIn) * 72
  // Calibrated against a known-good dense one-page CV (~97% fill).
  const AVG_CHAR_WIDTH_EM = 0.44
  const LINE_HEIGHT = 1.12
  const PARA_SPACING_PT = 0.5

  let heightPt = 0
  for (const para of paragraphs) {
    const fontPt = para.fontSize || 10
    const text = para.text || ''
    const charsPerLine = Math.max(20, Math.floor(usableWidthPt / (fontPt * AVG_CHAR_WIDTH_EM)))
    // Tab-separated segments share one line unless they overflow together.
    const effectiveLen = text.replace(/\t/g, '    ').length
    const lines = Math.max(1, Math.ceil(effectiveLen / charsPerLine))
    heightPt += lines * fontPt * LINE_HEIGHT + PARA_SPACING_PT
  }
  return {
    usedPt: Math.round(heightPt),
    availablePt: Math.round(usableHeightPt),
    fillRatio: heightPt / usableHeightPt,
    fitsOnePage: heightPt <= usableHeightPt,
  }
}
