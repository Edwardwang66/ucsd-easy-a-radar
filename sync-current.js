#!/usr/bin/env node
// sync-current.js — reconcile "who is teaching FA26" across data.json (recs cur / fa)
// using BOTH schedule.json and the latest TSS scrape as ground truth.
//
// Why: merge-schedule.js only iterates courses present in schedule.json (the classic
// SoC scrape). TSS covers more — med-school courses and courses added after the SoC
// scrape — so src=2 "new instructor" rows for those courses never receive cur=1 or an
// fa entry, while replaced instructors leave ghost src=2 rows behind. This pass makes
// the derived state a function of (schedule ∪ TSS):
//   1. src=2 row whose person matches schedule/TSS/fa for the course → cur=1,
//      and the course's fa gains the person (TSS spelling) if missing.
//   2. Courses absent from schedule.json but covered by TSS, with at least one
//      matching row → fa[course] := TSS instructor list (so the site shows the
//      "This course in FA26" line consistently).
//   3. src=2 row (no grade history — nothing to preserve) whose person is in
//      NEITHER source, for a course that IS covered by TSS or fully-filled
//      schedule → deleted. Courses covered by neither source are left untouched.
//   4. Any row (any src, incl. SET) matching a teaching name → cur=1.
// Umbrella courses (198/199/298/299/500) are skipped entirely, as elsewhere.
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

const stats = { badged: 0, faAdded: 0, faCreated: 0, deleted: 0, leftUncovered: 0 };
const teachingOf = (key) => {
  const names = new Set(schedNames[key] || []);
  for (const n of tss[key] || []) names.add(n);
  return names;
};

const keep = [];
for (const r of data.recs) {
  const key = `${r[C.s]} ${r[C.c]}`;
  if (UMBRELLA.test(key) || !r[C.i]) { keep.push(r); continue; }
  const teaching = [...teachingOf(key)];
  const fa = data.fa[key];
  const matchTeach = teaching.find((n) => sameName(n, r[C.i]));
  const matchFa = (fa || []).find((f) => sameName(f, r[C.i]));

  if (matchTeach || matchFa) {
    if (r[C.cur] !== 1) { r[C.cur] = 1; stats.badged++; }
    if (matchTeach && !matchFa) {
      if (!fa) {
        // Course new to fa (e.g. med school): publish the full TSS/schedule roster.
        data.fa[key] = teaching.slice().sort();
        stats.faCreated++;
      } else {
        fa.push(matchTeach);
        stats.faAdded++;
      }
    }
    keep.push(r);
    continue;
  }

  if (r[C.src] === 2 && r[C.cur] !== 1) {
    // No grade history to preserve; delete only when a source actually covers the course.
    const covered = (tss[key] && tss[key].size) || schedFilled[key];
    if (covered) { stats.deleted++; continue; }
    stats.leftUncovered++;
  }
  keep.push(r);
}
data.recs = keep;

fs.writeFileSync(path.join(ROOT, "data.json"), JSON.stringify(data));
console.log(
  `sync-current: badged cur=1 on ${stats.badged} rows, deleted ${stats.deleted} ghost src=2 rows, ` +
  `fa lists created ${stats.faCreated} / appended ${stats.faAdded}, left ${stats.leftUncovered} uncovered src=2 rows.`
);
