# Professor name matching — how we link catalog names to grade history

*How the "same professor, two different names" problem is solved at scale, and why.*

## The problem

Every Fall-2026 course carries a **current instructor** from the WebReg catalog
(`data/catalog.json` → the `fa` map). Every historical grade row carries a **past
instructor** from the UCSD grade distributions. To tag a course "Teaching now" —
and to know which professors are teaching for the **first time** — we have to
decide when a catalog name and a grade-history name are *the same person*.

That would be trivial if either source carried a stable id. **Neither does.**
The catalog gives a display string (`"Paul Cao"`); the grade file gives a
registrar string (`"Cao, Yingjun"`). The only identifier anywhere in the pipeline
is the **RateMyProfessors professor id**, and it's present on just ~80% of grade
rows and is itself name-matched. So the join is unavoidably **name-string against
name-string**, across ~907 catalog instructors and ~6,000 grade-history names,
refreshed every term.

Naïve "surname + first initial" gets most of them and quietly mangles the rest.
The failures fall into clean buckets:

| Bucket | Catalog | Grade history | Why naïve matching fails |
|---|---|---|---|
| Name order | `Massimiliano Di Ventra` | `Di Ventra, Massimiliano` | "First Last" vs "Last, First" |
| **Compound surname** | `Nayeli Jiménez Cano` | `Jimenez Cano, Nayeli` | last token `cano` ≠ `jimenez cano` |
| Short vs long surname | `Stacy Ochoa` | `Ochoa Mikrut, Stacy` | catalog dropped a family name |
| Mc / punctuation | `Andrew McCulloch` | `Mc Culloch, Andrew` | space/apostrophe spelling differs |
| **Goes by middle name** | `Ryan Wagner` | `Wagner, Timothy Ryan` | first initial `r` ≠ `t` |
| **Nickname / rename** | `Paul Cao` | `Cao, Yingjun` | different given name entirely |
| Transliteration | `Yiorgos Makris` | `Makris, Georgios V` | `Yiorgos` = `Georgios` |
| Accents | `Daphne Taylor García` | `Garcia, ...` | `í` vs `i` |
| **First time teaching** | `Des McAnuff` | *(absent)* | genuinely no history |

The last bucket is not an error to fix — it's a fact to surface (the `0×`
first-term rows).

## The tension: precision vs recall

The trap is that being *more* aggressive to catch renames (bucket 6) also merges
**different people who share a surname**. UCSD has 15 professors named `Zhang`,
9 named `Davis`, 4 named `Garcia`. Merging `Ruobing Zhang` (new) into
`Zhang, Yuming` (a Math lecturer) would be a confident, wrong, GPA-attributing
lie. So the design rule is **precision first**: never merge on a weak signal, and
when a signal is ambiguous, *route it to a human* instead of guessing.

## The matching ladder

Matching is done in `tools/relink_fa26.py`, and the identical key logic is mirrored
in `index.html` (so the live ✓ display and the baked `cur` flag never disagree —
this is asserted in testing: 0 mismatches across all 11k rows).

A name becomes a set of `(surname, initial)` **keys**; two names match if their key
sets intersect. Each rung widens *recall* without spending *precision*:

- **L1 — Normalise.** Strip accents, collapse whitespace, unify `"Last, First"` and
  `"First Last"`. (Handles order + accents.)
- **L2 — Compound surname.** On the catalog side emit *both* the last token and the
  whole trailing surname: `Massimiliano Di Ventra` → `{ventra, di ventra}`. (Handles
  compound surnames without having to guess token boundaries.)
- **L2′ — Despace.** Also emit a punctuation/space-stripped surname, so
  `Mc Culloch` = `McCulloch` = `mcculloch` and `O'Connor` = `O Connor`.
- **L3 — Initials.** Key on the first **or any middle** initial. `Wagner, Timothy Ryan`
  emits `(wagner,t)` **and** `(wagner,r)`, so `Ryan Wagner` links automatically. This
  alone resolves the entire "goes by their middle name" bucket with zero curation.
- **L4 — Auto-alias by course overlap.** For a name L1–L3 still can't place, look for a
  same-surname grade professor who **taught the exact course now assigned**. Course
  overlap is a very strong disambiguator: `Paul Cao` teaches CSE 12/100, and
  `Cao, Yingjun` has CSE 12/100 grade history → same person. Applied automatically,
  every application logged. This resolves the nickname/rename bucket **without a
  hand-written list**.
- **L5 — Manual residue.** The irreducible remainder: a rename with *no* shared course
  to lean on (e.g. `Yiorgos Makris` teaches a grad seminar; his grades are under
  `Georgios Makris` on a different course). These live in a tiny, commented
  `MANUAL_ALIAS` dict — currently **4 entries**.
- **L6 — Namesake blocks.** The inverse hazard: two *different* people who share a
  surname and initial (`Michael McKay` teaches MGT 18; `Mary McKay` taught it before).
  L3 would happily link them and falsely tag Mary "Teaching now." Confirmed namesakes go
  in a `MANUAL_BLOCK` set that vetoes the link — currently **1 entry**. The generator
  prints every initial-only match (`VERIFY namesakes …`) so new ones are easy to spot;
  the overwhelming majority are legitimate nicknames (`Tim`↔`Timothy`, `Geoff`↔`Geoffrey`)
  and are left alone.

Anything matched by surname **and subject** but *not* by an exact course is **not**
applied. It's printed as a `REVIEW` line for a human to confirm or reject. That, plus a
glance at the `VERIFY namesakes` list, is the only recurring manual step, and it is small.

## Why this scales

The whole point is that curation does **not** grow with the catalog. On the current
FA26 snapshot:

- **27** professors are linked under a different name than their grade history.
- **23 of 27** are resolved *automatically* (L1–L4). Only **4** are hand-written aliases
  (renames with no shared course), plus **1** hand-confirmed namesake block.
- The human review queue for the entire term is **2 alias candidates** — both correctly
  *different* people (`Ruobing Zhang ≠ Zhang, Yuming`; `Laura Acosta Gonzalez ≠
  Roman Gonzalez, Betsabe`), which the course-overlap gate declined to auto-merge — plus
  a short `VERIFY namesakes` list to eyeball.
- The JS re-derivation of `cur` matches the Python-baked flag on all rows (0 mismatches),
  so the live ✓ display and the stored flag can never drift apart.

Each term you drop in a fresh catalog and rerun `python3 tools/relink_fa26.py`.
L1–L4 re-resolve everything derivable from the data; the script prints any new
`REVIEW` candidates; you glance at a handful and, at most, add a line to
`MANUAL_ALIAS`. Curation is O(genuinely-ambiguous renames), not O(professors).

## First-time instructors (`0×`)

A catalog instructor whose key set intersects **no** grade key is teaching at UCSD
for the first time — there is simply no history to show. Rather than hide them, the
script emits a synthetic row per (professor, course) with `src = 2`, no GPA, and a
`0×` marker. In the UI these always sort to the **bottom** of the table and are
listed **after** returning instructors in every course's instructor list, so they
never crowd out rows that actually carry grade signal. Currently **22** first-time
instructors → **26** first-term rows.

They have no grade rows for the normal RMP join to ride, so `tools/fetch_rmp_firsttime.py`
queries RateMyProfessors (UCSD, school 1079) for them directly and caches strict matches
(surname must match; first name must be compatible) to `tools/rmp_firsttime.json`, which
the generator writes onto the `0×` rows. Most first-timers aren't on RMP yet — currently
**2 of 22** match — so a `0×` row can still show a rating even with no grade history.

## What we deliberately did *not* build

- **An RMP-id bridge.** Resolving every catalog name to an RMP id once, then joining
  on the id, is the theoretical endgame (it would also fix the ~20% of grade rows
  with no RMP match). We skipped it because RMP has the *same* name-variance problem
  on its own search, needs scraping/rate-limiting, and L1–L4 already reach 20/22
  automatically. It's the natural next step if the manual residue ever grows.
- **A generic nickname dictionary** (Peggy→Margaret, Bill→William …). It would help the
  anglophone slice of bucket 6, but course-overlap (L4) already catches those *and*
  the non-anglophone ones (Yingjun→Paul, Gholamreza→Reza) that a dictionary never
  would. Less code, wider coverage.
- **Fuzzy string distance** (Levenshtein/Jaro on whole names). High recall, poor
  precision on a name set this dense with shared surnames — exactly the merges we most
  want to avoid. Course overlap is a categorical signal; edit distance is a guess.

## Files

- `tools/relink_fa26.py` — the regenerator. Reads `data.json` (+ `schedule.json` for
  titles, + `rmp_firsttime.json` for first-timer RMP), rewrites `cur`, `alias`, `block`,
  `newProf`, and the `src = 2` rows. Idempotent; `--dry-run` reports without writing.
- `tools/fetch_rmp_firsttime.py` — refreshes `rmp_firsttime.json` by querying RMP for the
  current first-time instructors. Run it when the first-timer set changes.
- `index.html` — `ourKeysJS` / `catKeysJS` / `orderFa` mirror the ladder for the live
  ✓ display and first-timer ordering.
- `data.json` — `alias` (catalog-name → `[surname, initial]`) and `newProf` (first-time
  instructor names) are consumed by the front end.
