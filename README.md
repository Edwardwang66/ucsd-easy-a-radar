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

No environment variables, no server. `fetch('data.json')` is same-origin, so it just works.

## Data notes (important, keep honest)

- **Grades** — official UCSD grade distributions, aggregated per *course × professor* across
  2015–2026. Bar shows A/B/C/D/F, W (withdraw), and P/NP. `Avg GPA` is the historical mean.
- **"Offered" tag** — a course flagged `Offered` runs in **Fall 2026** (matched against the live
  WebReg catalog). The professor shown in each row is a **past instructor** of that course.
- **FA26 current instructor** — each offered course now carries its **actual Fall 2026 instructor(s)**,
  sourced from the [WebReg Course Planner](https://github.com/SahirSSharma/WebReg-Course-Planner)
  catalog. When a row's past instructor is teaching the course again this term, the row is tagged
  `Teaching now` — so its grade history is directly relevant. The `fa` map in `data.json` holds
  `"SUBJ NUM" → [current instructors]`; the `cur` column flags matching rows. Match is by surname +
  first initial (accent-insensitive). Compound surnames are handled on both sides (e.g. catalog
  *Massimiliano Di Ventra* ↔ grades *Di Ventra, Massimiliano*), and an `alias` map in `data.json`
  covers professors listed under a different name in the catalog than in the grade records — a
  nickname or given/legal-name swap such as *Paul Cao* = *Cao, Yingjun*, *Libby Butler* =
  *Butler, Elizabeth*, *Peggy Lott* = *Lott, Margaret*. Professors teaching at UCSD for the first
  time have no grade history; they're collected in the `newProf` list, marked **0×** in the UI, and
  sorted after the returning instructors.
- **Schedule builder** — the **My Schedule** tab lets you add offered courses, pick lecture/discussion/lab
  sections, and see them on a weekly calendar (with conflict detection) and a Leaflet campus map. All
  section times, rooms, instructors and building coordinates come from `schedule.json`. Leaflet + OSM
  tiles load from a CDN at runtime; if that's blocked the calendar still works and the map degrades
  gracefully. Selections persist in `localStorage`.
- **RMP** — RateMyProfessors school 1079, matched by name (~80% of rows). Difficulty lower = easier.
- **Grad backfill** — 200+ courses with no grade data are filled from professors' RMP course
  history (`RMP only` rows); those scores are the professor's overall rating, not course-specific.

## Regenerating data.json / schedule.json

`data.json` is produced by joining grade JSONs, RMP professors, and the FA26 catalog. The
current-term instructor columns (`fa` map + `cur` flag) and `schedule.json` are both derived from the
[WebReg Course Planner](https://github.com/SahirSSharma/WebReg-Course-Planner) `data/catalog.json`
and `data/buildings.json` (MIT-licensed, © Sahir Sharma). To refresh, pull a newer catalog snapshot
and re-run the join. The schemas (`cols` / `titles` / `recs` / `fa`, and `secCols` / `courses` /
`buildings`) are self-describing.

Credit: Fall 2026 section + instructor + building data comes from the **WebReg Course Planner** by
Sahir Sharma — this project joins it with historical grade distributions and RateMyProfessors.
