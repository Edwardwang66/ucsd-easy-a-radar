#!/usr/bin/env node
// Merge a SET public export (set-public-courses-*.json) into data.json's `set` map.
//
//   node merge-set.js ~/Downloads/set-public-courses-344.json
//   node build.js            # then re-hash data.json + rewrite index.html
//
// The site's only source of official UCSD course-evaluation deep-links for
// GRADUATE courses (≥200, which have no published grade distribution) is
// data.json `set["SUBJ NUM"] = [{ i, t, sec, sid, u }]` — one entry per
// section, newest term first. The app looks them up with CK(s,c) ("ECE 203")
// in the row-expansion, and renders "term · instructor · SET report ↗".
//
// Only the deep-link is stored (JSON①, public & legal): no grades / eval
// content — students click through to academicaffairs.ucsd.edu to view the
// report themselves. Course-keyed on purpose: SET instructor names don't
// reliably match the recs rows (many grad rows are catalog rows with no
// instructor, or use a different name format), so we attach at the course
// level and list every section. Zero dependencies (Node built-ins only).
"use strict";

const fs = require("fs");
const path = require("path");

// Chronological sort key for a UCSD term code like "FA24" / "WI25" / "SP26".
// Fall opens the academic year but comes first chronologically within it.
const QOFF = { WI: 0.0, SP: 0.25, S1: 0.45, SU: 0.5, S2: 0.55, S3: 0.6, FA: 0.75 };
function chrono(term) {
  const m = /^([A-Z]{2})(\d{2})$/.exec(term || "");
  if (!m) return 0;
  return 2000 + Number(m[2]) + (QOFF[m[1]] ?? 0);
}

function courseKey(code) {
  // "ECE 203" / "ECE203" / "ece  203a" -> "ECE 203A"
  return String(code).toUpperCase().replace(/\s+/g, " ").trim();
}

function main() {
  const src = process.argv[2];
  if (!src) {
    console.error("usage: node merge-set.js <set-public-courses-*.json>");
    process.exit(1);
  }
  const ROOT = __dirname;
  const dataPath = path.join(ROOT, "data.json");
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const pub = JSON.parse(fs.readFileSync(src, "utf8"));
  const sections = pub.sections || pub;

  const map = {};
  let skipped = 0;
  for (const s of sections) {
    if (!s.courseCode || !s.sid) { skipped++; continue; }
    const key = courseKey(s.courseCode);
    const u = s.reportUrl ||
      ("https://academicaffairs.ucsd.edu/Modules/Evals/SET/Reports/SETSummary.aspx?sid=" + s.sid);
    (map[key] || (map[key] = [])).push({
      i: s.instructor || "", t: s.term || "", sec: s.section || null,
      sid: String(s.sid), u,
    });
  }

  let courses = 0, entries = 0;
  for (const k of Object.keys(map)) {
    const seen = new Set();
    const arr = map[k].filter((e) => !seen.has(e.sid) && seen.add(e.sid));
    arr.sort((a, b) => chrono(b.t) - chrono(a.t) || String(a.i).localeCompare(String(b.i)));
    map[k] = arr;
    courses++; entries += arr.length;
  }

  data.set = map;
  fs.writeFileSync(dataPath, JSON.stringify(data));

  console.log(`set: ${courses} courses, ${entries} section reports (skipped ${skipped} without code/sid)`);
  console.log("Next: node build.js");
}

main();
