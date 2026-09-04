#!/usr/bin/env node
// sync-current.js — reconcile "who is teaching FA26" across data.json (recs cur / fa)
// using BOTH schedule.json and the latest TSS scrape as ground truth.
//
// Why: merge-schedule.js only iterates courses present in schedule.json (the classic
// SoC scrape). TSS covers more — med-school courses and courses added after the SoC
// scrape — so src=2 "new instructor" rows for those courses never receive cur=1 or an
// fa entry, while replaced instructors leave ghost src=2 rows behind. This pass makes
// the derived state a function of (schedule ∪ TSS):
// For every "covered" course (TSS lists instructors, or schedule.json is fully
// filled), with teaching := schedule names ∪ TSS names:
//   1. cur := 1 on rows matching a teaching name (any src, incl. SET), 0 otherwise.
//      Matching = sameName (compound/hyphenated-surname aware) or the reviewed
//      `aka` map. A row that merely shares a surname token with a teaching name
//      is an unreviewed variant: left exactly as it was (see the aka review list
//      merge-schedule prints).
//   2. src=2 rows (no grade history) that match nothing → deleted (ghosts);
//      src=2 rows duplicating a real row of the same person → folded into it.
//   3. fa[course] := previous fa minus names no longer teaching (same unreviewed-
//      variant caveat), plus teaching names not yet represented; created from
//      the teaching set for courses that had no fa but do have a matching row.
// Never reads the old fa as evidence of who teaches — fa is output, not input.
// Umbrella courses (198/199/298/299/500) and uncovered courses are untouched.
//
// Usage: node sync-current.js /tmp/seatsN.json
// Pipeline: merge-schedule → merge-seats → align-packages → sync-current → healthcheck → build

const fs = require("fs");
const path = require("path");

const seatsPath = process.argv[2];
if (!seatsPath) { console.error("usage: node sync-current.js <tss-scrape.json>"); process.exit(1); }

const ROOT = __dirname;
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const sched = JSON.parse(fs.readFileSync(path.join(ROOT, "schedule.json"), "utf8"));
const seats = JSON.parse(fs.readFileSync(seatsPath, "utf8"));

// Reuse merge-schedule's compound-surname-aware name matching (single source of truth).
const msSrc = fs.readFileSync(path.join(ROOT, "merge-schedule.js"), "utf8");
eval(msSrc.slice(msSrc.indexOf("const deacc"), msSrc.indexOf("function main")));

const C = {}; data.cols.forEach((c, i) => (C[c] = i));
const UMBRELLA = /^[A-Z]+ (19[89]|29[89]|500)[A-Z]*$/;

// TSS: "MATH-020B" → "MATH 20B", collect section-level instructor names.
const tss = {};
for (const c of seats.courses || []) {
  const m = (c.course || "").match(/^([A-Z]+)-0*(\d+[A-Z]*)$/);
  if (!m) continue;
  const key = `${m[1]} ${m[2]}`;
  const set = tss[key] || (tss[key] = new Set());
  for (const p of c.packages || [])
    for (const s of p.sections || [])
      if (s.instructor && s.instructor.trim()) set.add(s.instructor.trim());
}

// schedule.json: per-course instructor names + whether every section is filled.
const schedNames = {}, schedFilled = {};
for (const [key, c] of Object.entries(sched.courses || {})) {
  const rows = c.sec.filter((x) => x[1] !== "FI");
  schedNames[key] = [...new Set(rows.map((x) => (x[7] || "").trim()).filter(Boolean))];
  schedFilled[key] = rows.length > 0 && rows.every((x) => (x[7] || "").trim());
}

const aka = data.aka || (data.aka = {});
// A match that needed the nickname/truncation/compound-surname rules (not just a
// reordering) is a genuine name variant: record it so the site shows "aka …" on
// the row and search finds either spelling. Keyed by the row's spelling.
const noteAka = (rowName, teachName) => {
  if (rowName === teachName || sameNameStrict(rowName, teachName)) return;
  const list = aka[rowName] || (aka[rowName] = []);
  if (!list.includes(teachName)) { list.push(teachName); stats.akaNoted++; }
};
// aka: display name → known variants (human-reviewed). Either direction counts.
const akaEq = (a, b) => a === b || (aka[a] || []).includes(b) || (aka[b] || []).includes(a);
const related = (a, b) => akaEq(a, b) || sameName(a, b);
// Same surname token but not provably the same person ("Libby Butler" vs
// "Butler, Elizabeth Annette") — an unreviewed aka candidate. We neither badge
// nor un-badge on such evidence; the prior state stands until a human decides.
const namesake = (a, b) => {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  return tb.includes(ta[ta.length - 1]) || ta.includes(tb[tb.length - 1]);
};

const stats = { akaNoted: 0, badged: 0, unbadged: 0, faAdded: 0, faPruned: 0, faCreated: 0, deleted: 0, merged: 0, uncovered: 0 };
const teachingOf = (key) => {
  const names = new Set(schedNames[key] || []);
  for (const n of tss[key] || []) names.add(n);
  return [...names];
};
const coveredKeys = new Set();
for (const key of new Set([...Object.keys(schedNames), ...Object.keys(tss)])) {
  if (UMBRELLA.test(key)) continue;
  if ((tss[key] && tss[key].size) || schedFilled[key]) coveredKeys.add(key);
}

const rowsByCourse = new Map();
for (const r of data.recs) {
  const key = `${r[C.s]} ${r[C.c]}`;
  if (!rowsByCourse.has(key)) rowsByCourse.set(key, []);
  rowsByCourse.get(key).push(r);
}

const drop = new Set();
for (const key of coveredKeys) {
  const teaching = teachingOf(key);
  const rows = rowsByCourse.get(key) || [];

  // 1. Rows: cur is a pure function of the teaching set.
  let anyMatch = false;
  for (const r of rows) {
    if (!r[C.i]) continue;
    const hit = teaching.find((n) => related(n, r[C.i]));
    if (hit) {
      anyMatch = true;
      noteAka(r[C.i], hit);
      if (r[C.cur] !== 1) { r[C.cur] = 1; stats.badged++; }
      // Teaching now ⇒ offered this term (healthcheck's offered-join expects one flagged row).
      if (C.off != null && schedNames[key] && r[C.off] !== 1) r[C.off] = 1;
      continue;
    }
    if (teaching.some((n) => namesake(n, r[C.i]))) continue; // unreviewed variant — leave as is
    if (r[C.src] === 2) { drop.add(r); stats.deleted++; continue; } // ghost: nothing to preserve
    if (r[C.cur] === 1) { r[C.cur] = 0; stats.unbadged++; }
  }
  // 1b. A src=2 row duplicating a real row of the same person (created before
  //     the matcher learned their spelling) is folded into that row.
  for (const r of rows) {
    if (r[C.src] !== 2 || drop.has(r)) continue;
    const twin = rows.find((o) => o !== r && o[C.src] !== 2 && !drop.has(o) && o[C.i] && related(o[C.i], r[C.i]));
    if (twin) {
      noteAka(twin[C.i], r[C.i]);
      // The RMP link is a property of the person; keep it when the duplicate goes.
      for (const f of ["rq", "rd", "rw", "rn", "rid"]) if (C[f] != null && twin[C[f]] == null && r[C[f]] != null) twin[C[f]] = r[C[f]];
      if (r[C.cur] === 1 && twin[C.cur] !== 1) { twin[C.cur] = 1; stats.badged++; }
      if (C.off != null && r[C.off] === 1) twin[C.off] = 1;
      drop.add(r); stats.merged++;
    }
  }

  // 2. fa: the course's current-term roster, derived from the same teaching set.
  const fa = data.fa[key];
  if (!fa) {
    if (anyMatch && teaching.length) { data.fa[key] = teaching.slice().sort(); stats.faCreated++; }
    continue;
  }
  const kept = fa.filter((f) => {
    if (teaching.some((n) => related(n, f))) return true;
    if (teaching.some((n) => namesake(n, f))) return true; // unreviewed variant — keep
    stats.faPruned++; return false;
  });
  for (const n of teaching) if (!kept.some((f) => related(f, n))) { kept.push(n); stats.faAdded++; }
  if (kept.length) data.fa[key] = kept; else delete data.fa[key];
}
for (const r of data.recs) {
  const key = `${r[C.s]} ${r[C.c]}`;
  if (r[C.src] === 2 && r[C.cur] !== 1 && !UMBRELLA.test(key) && !coveredKeys.has(key)) stats.uncovered++;
}
data.recs = data.recs.filter((r) => !drop.has(r));

fs.writeFileSync(path.join(ROOT, "data.json"), JSON.stringify(data));
console.log(
  `sync-current: aka noted ${stats.akaNoted}; cur badged +${stats.badged} / unbadged -${stats.unbadged}; ` +
  `fa created ${stats.faCreated}, names added ${stats.faAdded}, pruned ${stats.faPruned}; ` +
  `deleted ${stats.deleted} ghost src=2 rows, folded ${stats.merged} duplicate src=2 rows; ` +
  `${stats.uncovered} src=2 rows on uncovered courses left alone.`
);
