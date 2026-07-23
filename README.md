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
  `"SUBJ NUM" → [current instructors]`; the `cur` column flags matching rows. Neither source carries
  a stable instructor id, so catalog names are matched to grade-history names by a **precision-first
  ladder** (`tools/relink_fa26.py`, mirrored in `index.html`): normalise accents/order → try both the
  last token and the full compound surname (*Massimiliano Di Ventra* ↔ *Di Ventra, Massimiliano*) →
  despace Mc/apostrophe spellings (*McCulloch* ↔ *Mc Culloch*) → match on the first **or a middle**
  initial (*Ryan Wagner* ↔ *Wagner, Timothy Ryan*) → and, for genuine renames, **auto-alias by course
  overlap** (*Paul Cao* teaches CSE 12/100 and *Cao, Yingjun* has CSE 12/100 grade history → same
  person). Of the 27 professors listed under a different name than their grades, 23 resolve
  automatically; the `alias` map in `data.json` is generated, and only 4 hand-confirmed entries remain
  (`MANUAL_ALIAS`). Professors teaching at UCSD for the first time have no grade history; they're
  collected in `newProf`, shown as `src:2` rows marked **0×**, and sorted last. See
  [`docs/name-matching.md`](docs/name-matching.md) for the full design.
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

To re-link the current-term instructors after any data refresh, run
`python3 tools/relink_fa26.py` (add `--dry-run` to preview). It recomputes the `cur` flags, the
`alias` map and the `newProf` list, appends the `0×` first-term rows, and prints any ambiguous
name matches for review. See [`docs/name-matching.md`](docs/name-matching.md).

Credit: Fall 2026 section + instructor + building data comes from the **WebReg Course Planner** by
Sahir Sharma — this project joins it with historical grade distributions and RateMyProfessors.
