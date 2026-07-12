# ✈️ ApplyPilot

Personal job-application copilot. Paste a job link or JD (or send a job from
LinkedIn with one click via the bundled browser extension), pick one of your
existing CVs, and run the 3-step Claude pipeline to tailor it — **tweaks, not
rewrites** — while keeping it truthful and **under one page**. Track every
application from *Saved* to *Offer*.

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
#   → put your ANTHROPIC_API_KEY in server/.env

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

**Away from home (optional):** tunnel your local server with

```bash
cloudflared tunnel --url http://localhost:4000   # or: ngrok http 4000
```

and open the printed URL on your phone from anywhere. Only do this while you
need it — the tunnel URL is public (unguessable, but treat it like a secret,
since the app has no login).

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

React + Vite · Express · better-sqlite3 · JSZip + xmldom (in-place DOCX editing) · Anthropic SDK (Claude Opus 4.8, structured outputs) · Chrome MV3 extension.
