# ✈️ ApplyPilot

Personal job-application copilot. Paste a job link or JD (or send a job from
LinkedIn with one click via the bundled browser extension), auto-pick the
best-fit CV from your library (or choose one), and run the 3-step Gemini
pipeline to tailor it — **tweaks, not rewrites** — while keeping it truthful
and **under one page**. Track every application from *Saved* to *Offer*.

Runs on the **Gemini API** (`gemini-2.5-flash`), which has a free tier —
plenty for personal, low-volume use. Get a key at
[aistudio.google.com/apikey](https://aistudio.google.com/apikey).

The tailoring pipeline is the "UK Jobs Insider 3-step prompt" method:

| Step | What it does |
|---|---|
| ① Evaluate | ATS score /100, Hiring-Manager score /100, top-20 missing keywords, 3 red flags, 3 strengths, weak sections, interview probability |
| ② Rewrite | Surgical word-level tweaks to **Professional Summary, Experience, Skills, Projects** — XYZ formula, missing keywords woven in, same jobs & chronology, ±10% length so the page doesn't grow |
| ③ Stress test | The "6-second overworked recruiter" scan — rewrites only sections that fail the stop-the-scroll test |

Then **Re-score** to see the before → after ATS jump, hand-edit any line, and
download the tailored `.docx`. The original file's fonts, margins and layout
are preserved because the app edits the DOCX XML in place — it never rebuilds
the document. A live page-fill meter warns if you go over one page, and the
margin nudge buttons (±0.05") buy room without touching your content.

## Honesty & platform-safety by design

- Edits are constrained to **rephrase what's already true** — never invent skills, titles, dates or metrics.
- The GitHub panel pulls your **real public repos** so the Projects section stays verifiable.
- The extension only reads the job page **you are looking at** and sends it to your own localhost — no account automation, no background scraping, no auto-submit (that would violate LinkedIn's ToS and risk your account). You always click "Apply" yourself, armed with a tailored CV.

## Setup

```bash
cd applypilot
npm install

cp server/.env.example server/.env
#   → put your GEMINI_API_KEY in server/.env (free key: aistudio.google.com/apikey)

npm run dev
# client:  http://localhost:5173
# server:  http://localhost:4000
```

Production-style run: `npm run build && npm start` (server serves the built client).

### Use it on your phone 📱

The app is fully responsive and installable like a native app.

**Same Wi-Fi (recommended, zero setup):**

```bash
npm run build && npm start
```

The server prints a `on your phone (same Wi-Fi): http://192.168.x.x:4000` line —
open that URL in your phone's browser. Then use **Add to Home Screen**
(Safari: Share → Add to Home Screen · Chrome: ⋮ → Add to Home screen) and
ApplyPilot opens full-screen with its own icon, like an installed app.
`npm run dev` works too — the phone URL is then port `5173`.

**Away from home:** deploy to Render (below) for a permanent URL, or tunnel
your local server temporarily with
`cloudflared tunnel --url http://localhost:4000`. Either way, set
`APP_PASSWORD` so only you can get in.

### Deploy to Render (free, runs 24/7 without your laptop)

The repo ships a `render.yaml` blueprint. Render's free tier has an
**ephemeral disk**, so the app stores everything (including CV files) in a
Postgres database when `DATABASE_URL` is set. Get a free permanent Postgres
from [Neon](https://neon.tech) (sign in with GitHub → create project → copy
the connection string).

1. Push this repo to GitHub (private is fine — Render connects via your GitHub account).
2. Render dashboard → **New +** → **Blueprint** → select the repo → Apply.
3. Fill the env vars when prompted:
   - `GEMINI_API_KEY` — your free Gemini key
   - `APP_PASSWORD` — pick a strong password (this is your login, required on a public URL)
   - `DATABASE_URL` — the Neon connection string
4. Open `https://applypilot-xxxx.onrender.com`, enter your password, and Add to
   Home Screen on your phone.

Free-tier notes: the service sleeps after ~15 min idle — the first request
after a pause takes ~30–60 s to wake (fine for personal use). Without
`DATABASE_URL` the app still runs but data resets when the service restarts,
so do set it. If you use the LinkedIn extension with a deployed app, change
`SERVER` at the top of `extension/content.js` to your Render URL.

### Browser extension (LinkedIn one-click import)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `applypilot/extension` folder.
3. Browse any LinkedIn job (including your Saved jobs list → open a job) and click the floating **✈️ Send to ApplyPilot** button. The job appears in the Tracker with its JD attached. The app must be running locally.

## Using it

1. **My CVs** → upload your existing `.docx` CVs (one per target role works great).
2. **Tracker** → **+ Add job**: paste a link (public job pages are fetched & parsed automatically) or paste the JD text. LinkedIn jobs come in via the extension.
3. Open a job → **Tailor CV**: pick the base CV, run ① ② ③, review each proposed edit as a red/green word diff, tick/untick, **Apply accepted**, hand-edit any line by clicking it, **Re-score**, and **Download tailored .docx**.
4. Apply on the job site, then flip the status to **Applied** — the applied date is stamped automatically.

## Notes & limits

- **DOCX only** (that's what keeps in-place editing lossless). PDF export: open the downloaded file in Word/Google Docs → Save as PDF.
- The one-page meter is a good heuristic, not a typesetter — always eyeball the final file once.
- LinkedIn URL fetching from the server usually hits a login wall; that's what the extension and JD-paste are for.
- `server/data/` (your CVs + database) stays on your machine and is git-ignored.

## Stack

React + Vite · Express · better-sqlite3 / Postgres · JSZip + xmldom (in-place DOCX editing) · Google Gen AI SDK (Gemini 2.5 Flash, structured outputs) · Chrome MV3 extension.
