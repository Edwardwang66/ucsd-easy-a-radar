# UCSD Easy-A Radar

A single-page tool that ranks UCSD courses by how GPA-friendly they've been, from real
2015–2026 grade distributions, joined with RateMyProfessors.

## Deploy to Vercel

This is a **static site** (no build step). Two files matter:

- `index.html` — the app (fetches `data.json` at runtime)
- `data.json` — the dataset (~1.4 MB)

**Option A — Vercel CLI**
```bash
cd easy-a-radar
vercel        # first run links/creates the project
vercel --prod # deploy to production
```

**Option B — Git + Vercel dashboard**
Push this folder to a repo, "Import Project" on vercel.com, framework preset **Other**,
leave build & output settings empty (it serves the folder as static files).

No environment variables, no server. `fetch('data.json')` is same-origin, so it just works.

## Data notes (important, keep honest)

- **Grades** — official UCSD grade distributions, aggregated per *course × professor* across
  2015–2026. Bar shows A/B/C/D/F, W (withdraw), and P/NP. `Avg GPA` is the historical mean.
- **"Offered" tag** — the schedule snapshot (`ucsd-schedule-*.json`) contains **course codes only,
  no instructor names**. So the tag means the course runs this term; it does **not** tell us the
  current instructor. The professor shown in each row is a **past instructor** of that course.
- **RMP** — RateMyProfessors school 1079, matched by name (~80% of rows). Difficulty lower = easier.
- **Grad backfill** — 200+ courses with no grade data are filled from professors' RMP course
  history (`RMP only` rows); those scores are the professor's overall rating, not course-specific.

## Regenerating data.json

`data.json` is produced by joining three sources (grade JSONs, RMP professors, schedule snapshot).
See the parent project folder for the source files. To refresh, re-run the aggregation pipeline
and overwrite `data.json` — the schema (`cols` / `titles` / `recs`) is self-describing.
