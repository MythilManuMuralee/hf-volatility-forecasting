import { GoogleGenAI } from '@google/genai'

// The 3-step pipeline from the "UK Jobs Insider — Claude 3-step prompt" guide,
// adapted for programmatic use, run on Gemini (free-tier friendly for a
// personal, low-volume tool):
//   Step 1 EVALUATE    — recruiter/hiring-manager scoring + missing keywords
//   Step 2 REWRITE     — targeted tweaks to Summary / Experience / Skills / Projects
//   Step 3 STRESS TEST — 6-second recruiter scan; rewrite only failing sections
// Every rewrite is constrained to be a *tweak* (similar length, same jobs,
// same chronology, truthful) so the document stays one page and stays honest.

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

let client
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    const err = new Error('GEMINI_API_KEY is not set. Add it to applypilot/server/.env (get a free key at aistudio.google.com/apikey)')
    err.status = 400
    throw err
  }
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  return client
}

// Gemini's responseSchema is a restricted OpenAPI-3.0 subset — it rejects
// unknown keywords like `additionalProperties`, so strip those before
// sending a schema written for full JSON Schema.
function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(node)) {
      if (key === 'additionalProperties') continue
      out[key] = toGeminiSchema(val)
    }
    return out
  }
  return node
}

async function structuredCall({ system, user, schema }) {
  const response = await getClient().models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [{ text: user }] }],
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(schema),
    },
  })
  const text = response.text
  if (!text) {
    const reason = response.candidates?.[0]?.finishReason
    const err = new Error(reason ? `The model stopped without output (${reason}).` : 'The model returned no output.')
    err.status = 502
    throw err
  }
  return JSON.parse(text)
}

function numberedCv(paragraphs) {
  return paragraphs.map(p => `[${p.index}]${p.bold ? ' (bold)' : ''} ${p.text}`).join('\n')
}

const EVALUATION_SCHEMA = {
  type: 'object',
  properties: {
    ats_score: { type: 'integer' },
    hiring_manager_score: { type: 'integer' },
    missing_keywords: { type: 'array', items: { type: 'string' } },
    red_flags: { type: 'array', items: { type: 'string' } },
    strengths: { type: 'array', items: { type: 'string' } },
    weak_sections: { type: 'array', items: { type: 'string' } },
    interview_probability: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['ats_score', 'hiring_manager_score', 'missing_keywords', 'red_flags', 'strengths', 'weak_sections', 'interview_probability', 'summary'],
}

export async function evaluateCv(jdText, cvText) {
  return structuredCall({
    system: `You are a Senior Recruiter and Hiring Manager at the company posting this job. Analyze the resume against the job description. Be brutally honest. Scores are out of 100. "missing_keywords" is the top 20 keywords, skills and phrases from the job description that are missing or underrepresented in the resume. "red_flags" is the 3 biggest red flags that would make a recruiter hesitate. "strengths" is the 3 strongest selling points. "weak_sections" lists sections that are weak, vague, repetitive, or wasting space. "interview_probability" is how likely an interview is if applied today (short phrase with a percentage). "summary" is 2-3 sentences of overall assessment.`,
    user: `JOB DESCRIPTION:\n${jdText}\n\nRESUME:\n${cvText}`,
    schema: EVALUATION_SCHEMA,
  })
}

const EDITS_SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          new_text: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['index', 'new_text', 'reason'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['edits', 'notes'],
}

const TWEAK_RULES = `
HARD RULES for every edit:
1. TWEAK, do not rework. Adjust wording, swap in missing keywords naturally, sharpen verbs. Keep each paragraph recognizably the same accomplishment.
2. Stay truthful. Never invent skills, employers, titles, dates, metrics or tools. Only rephrase what is already there.
3. Keep the same jobs and chronology. Never edit company names, job titles, date ranges, education institutions, degrees, or the contact/header lines.
4. Only edit paragraphs in the Professional Summary, Professional Experience (bullet lines only), Projects, and Skills sections.
5. Length discipline: the CV must stay under ONE PAGE. Each new_text must be within ±10% of the original paragraph's character count. Never add new paragraphs.
6. Use Google's XYZ formula for experience/project bullets: "Accomplished X as measured by Y by doing Z." Start with a strong action verb. Be measurable where possible. Sound like a top-5% candidate without exaggeration.
7. Preserve any TAB characters (\\t) in a paragraph exactly — they control layout.
8. Return an edit ONLY for paragraphs you actually improve. Unchanged paragraphs must not appear in the output.`

export async function rewriteCv(jdText, paragraphs, evaluation) {
  return structuredCall({
    system: `You are an elite resume writer tailoring an existing one-page CV to a specific job. You receive the CV as numbered paragraphs and must return surgical edits by paragraph index.\n${TWEAK_RULES}\n"notes" is a 1-3 sentence summary of what you changed and which missing keywords you worked in.`,
    user: `JOB DESCRIPTION:\n${jdText}\n\nEVALUATION OF CURRENT CV (fix these):\nMissing keywords: ${evaluation.missing_keywords.join(', ')}\nRed flags: ${evaluation.red_flags.join(' | ')}\nWeak sections: ${evaluation.weak_sections.join(' | ')}\n\nCV PARAGRAPHS (edit by index):\n${numberedCv(paragraphs)}`,
    schema: EDITS_SCHEMA,
  })
}

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          cv_id: { type: 'integer' },
          cv_name: { type: 'string' },
          score: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['cv_id', 'cv_name', 'score', 'reason'],
      },
    },
    recommendation: { type: 'string' },
  },
  required: ['ranking', 'recommendation'],
}

// Rank the user's CV library against one JD — powers auto-selecting the
// best base CV before the tweak pipeline runs.
export async function matchCvs(jdText, cvs) {
  const blocks = cvs.map(cv =>
    `=== CV id=${cv.id} name="${cv.name}"${cv.target_role ? ` target_role="${cv.target_role}"` : ''} ===\n${cv.text}`
  ).join('\n\n')
  return structuredCall({
    system: `You are a Senior Recruiter. The candidate has several versions of their CV (same person, different emphasis). Rank ALL of them as starting points for this specific job. "score" is fit out of 100 before any tailoring. "reason" is one concrete sentence (which sections/keywords make it the best or worse fit). "ranking" must be ordered best-first and include every CV exactly once. "recommendation" is 1-2 sentences: which CV to use and the single biggest tweak that would improve it for this role.`,
    user: `JOB DESCRIPTION:\n${jdText}\n\nCANDIDATE'S CVS:\n${blocks}`,
    schema: MATCH_SCHEMA,
  })
}

const STRESS_SCHEMA = {
  type: 'object',
  properties: {
    attention_sections: { type: 'array', items: { type: 'string' } },
    skipped_sections: { type: 'array', items: { type: 'string' } },
    forgettable_bullets: { type: 'array', items: { type: 'string' } },
    generic_parts: { type: 'array', items: { type: 'string' } },
    curiosity_sections: { type: 'array', items: { type: 'string' } },
    shortlist_reasons: { type: 'array', items: { type: 'string' } },
    reject_reasons: { type: 'array', items: { type: 'string' } },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          new_text: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['index', 'new_text', 'reason'],
      },
    },
    verdict: { type: 'string' },
  },
  required: ['attention_sections', 'skipped_sections', 'forgettable_bullets', 'generic_parts', 'curiosity_sections', 'shortlist_reasons', 'reject_reasons', 'edits', 'verdict'],
}

export async function stressTestCv(jdText, paragraphs) {
  return structuredCall({
    system: `Act as two people at once: (1) an ATS system filtering thousands of resumes, and (2) an overworked Hiring Manager reading 200 resumes late at night with 6 seconds to decide whether to interview. Scan the resume top to bottom exactly as a recruiter would. Then rewrite ONLY the paragraphs that fail the "stop the scroll" test, as edits by paragraph index. The goal: make this resume impossible to ignore while remaining truthful.\n${TWEAK_RULES}\n"verdict" is one sentence: shortlist or reject, and why.`,
    user: `JOB DESCRIPTION:\n${jdText}\n\nCV PARAGRAPHS:\n${numberedCv(paragraphs)}`,
    schema: STRESS_SCHEMA,
  })
}
