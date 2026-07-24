# UCSD Easy-A Radar

A single-page tool that ranks UCSD courses by how GPA-friendly they've been, from real
2015–2026 grade distributions, joined with RateMyProfessors.

**Live:** https://easy-a-radar.vercel.app
**Repo:** https://github.com/Edwardwang66/ucsd-easy-a-radar

## Deploy to Vercel

This is a **static site** (no build step). Three files matter:

- `index.html` — the app (fetches `data.json`, and `schedule.json` on demand)
- `data.json` — the ranking dataset (grades × professors × RMP, + FA26 current instructors)
- `schedule.json` — the Fall 2026 section catalog (times, rooms, instructors, building coords) used by the schedule builder

**Option A — Vercel CLI**
```bash
cd easy-a-radar
vercel        # first run links/creates the project
vercel --prod # deploy to production
```

**Option B — Git + Vercel dashboard**
Push this folder to a repo, "Import Project" on vercel.com, framework preset **Other**,
leave build & output settings empty (it serves the folder as static files).

The **site itself** needs no build, no server, and no environment variables —
`fetch('data.json')` is same-origin, so it just works. The one exception is the
optional feedback button, backed by a single serverless function (`api/feedback.js`)
that files GitHub issues; it reads one env var on Vercel. See **Run locally** below.

## Run locally

**Just the site (no feedback button)** — any static server works, no setup:

```bash
cd easy-a-radar
python3 -m http.server 8000   # then open http://localhost:8000
```

Rankings, the schedule builder, and the Leaflet map all work. Two things 404
locally, both harmless and expected:

- **The feedback button** POSTs to `/api/feedback`, which a plain static server
  doesn't route — so filing feedback fails (use `vercel dev` below if you need it).
- **`/_vercel/insights/script.js` and `/_vercel/speed-insights/script.js`** — Vercel's
  Web Analytics / Speed Insights, served only from Vercel's edge once enabled. They're
  loaded with `defer` and fail silently, so the 404s in your terminal log change nothing.

**Full stack incl. the feedback API** — use the Vercel CLI so `/api/feedback` runs:

```bash
vercel dev    # serves the static files AND the serverless function
```

`api/feedback.js` needs one environment variable:

- `GH_FEEDBACK_TOKEN` — a GitHub **fine-grained PAT scoped to this repo only**,
  with **Issues: Read and write** (nothing else). Optional: `FEEDBACK_REPO`
  (`owner/name`, defaults to `Edwardwang66/ucsd-easy-a-radar`).

Put it in a local `.env.local` (git-ignored — never commit it):

```
GH_FEEDBACK_TOKEN=github_pat_xxx
```

> **Note on `.env.local` from `vercel`/`vercel env pull`:** if you link this folder
> to the Vercel project, the CLI writes a `.env.local` for you — but `GH_FEEDBACK_TOKEN`
> comes down **empty** (`GH_FEEDBACK_TOKEN=`). That's not a bug: the token is stored as a
> **Sensitive** var on Vercel, which the CLI can only list by name, never read back. Fill in
> your own PAT locally. Without it, `/api/feedback` returns `500 Server not configured` and
> the rest of the site is unaffected.

## Deploy to any static host

Because the app is just `index.html` + the JSON data files, you can host it on **any**
static platform — GitHub Pages, Netlify, Cloudflare Pages, an S3 bucket, or your own
web server. No build, no Node, no config.

**What to upload:** everything except the dev-only files. Ship these —
```
index.html  data.json  schedule.json  hist.json  schedule-instructor.js  vercel.json
```
and skip `README.md`, `.git*`, `api/`, `tests/`, `.vercel/`, `node_modules/`. (`vercel.json`
only sets cache headers; harmless to include or drop on other hosts.)

**GitHub Pages** — push this folder to a repo, then Settings → Pages → *Deploy from a branch*,
pick `main` / root. Your site goes live at `https://<user>.github.io/<repo>/`.

**Netlify / Cloudflare Pages** — "Add site" → connect the repo (or drag-and-drop the folder),
framework preset **None/Other**, **leave the build command empty** and set the publish/output
directory to `easy-a-radar` (or `.` if the repo root *is* this folder).

**Plain web server (nginx/Apache/S3)** — just copy the files into the web root. Any server that
returns `index.html` and serves `*.json` as static files works.

> ⚠️ **Feedback button on static-only hosts:** static hosting can't run `api/feedback.js`
> (that's a serverless function), so the feedback button won't file issues there — the entire
> rest of the site works normally. If you need feedback, deploy on **Vercel** (above), which
> serves the static files *and* the function together. The Leaflet map still needs internet
> for its CDN tiles but degrades gracefully if blocked.

## Data notes (important, keep honest)

- **Grades** — official UCSD grade distributions, aggregated per *course × professor* across
  2015–2026. Bar shows A/B/C/D/F, W (withdraw), and P/NP. `Avg GPA` is the historical mean.
- **"Offered" tag** — a course flagged `Offered` runs in **Fall 2026** (matched against the live
  WebReg catalog). The professor shown in each row is a **past instructor** of that course.
- **FA26 current instructor** — each offered course now carries its **actual Fall 2026 instructor(s)**,
  sourced from the [WebReg Course Planner](https://github.com/SahirSSharma/WebReg-Course-Planner)
  catalog. When a row's past instructor is teaching the course again this term, the row is tagged
  `Teaching now` — so its grade history is directly relevant. The `fa` map in `data.json` holds
  `"SUBJ NUM" → [current instructors]`; the `cur` column flags matching rows. Neither source carries
  a stable instructor id, so catalog names are matched to grade-history names by a **precision-first
  ladder**: normalise accents/order → try both the last token and the full compound surname
  (*Massimiliano Di Ventra* ↔ *Di Ventra, Massimiliano*) → despace Mc/apostrophe spellings
  (*McCulloch* ↔ *Mc Culloch*) → match on the first **or a middle** initial (*Ryan Wagner* ↔
  *Wagner, Timothy Ryan*) → and, for genuine renames, **alias by course overlap** (*Paul Cao* teaches
  CSE 12/100 and *Cao, Yingjun* has CSE 12/100 grade history → same person). The resolved `alias` map
  lives in `data.json`. Every offered course (the `fa` map is rebuilt from `schedule.json`) appears in
  the rankings, not just ones with grade history: a course × professor with no grade data is a `src:2`
  row marked **0×** (an established professor keeps their RMP; someone new to UCSD is a first-timer,
  listed in `newProf`), a course with no assigned instructor or a research/independent-study course is
  a `src:3` **TBA** row, and all of these sort last.
- **Schedule builder** — the **My Schedule** tab lets you add offered courses, pick lecture/discussion/lab
  sections, and see them on a weekly calendar (with conflict detection) and a Leaflet campus map. All
  section times, rooms, instructors and building coordinates come from `schedule.json`. Leaflet + OSM
  tiles load from a CDN at runtime; if that's blocked the calendar still works and the map degrades
  gracefully. Selections persist in `localStorage`.
- **RMP** — RateMyProfessors school 1079, matched by name (~81% of rows). Difficulty lower = easier.
  FA26 instructors the original name-join missed are recovered by matching against UCSD's full RMP
  roster — order-agnostic (RMP sometimes stores first/last swapped, e.g. *Bellare Mihir*),
  variant-aware (accents, hyphens, compound surnames, nicknames like *Yeshaiahu → Shaya Fainman*),
  and department-corroborated.
- **Grad backfill** — 200+ courses with no grade data are filled from professors' RMP course
  history (`RMP only` rows); those scores are the professor's overall rating, not course-specific.

## Regenerating data.json / schedule.json

`data.json` is produced by joining grade JSONs, RMP professors, and the FA26 catalog. The
current-term instructor columns (`fa` map + `cur` flag) and `schedule.json` are both derived from the
[WebReg Course Planner](https://github.com/SahirSSharma/WebReg-Course-Planner) `data/catalog.json`
and `data/buildings.json` (MIT-licensed, © Sahir Sharma). To refresh, pull a newer catalog snapshot
and re-run the join. The schemas (`cols` / `titles` / `recs` / `fa` / `alias` / `newProf`, and
`secCols` / `courses` / `buildings`) are self-describing.

Credit: Fall 2026 section + instructor + building data comes from the **WebReg Course Planner** by
Sahir Sharma — this project joins it with historical grade distributions and RateMyProfessors.
