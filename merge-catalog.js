#!/usr/bin/env node
// Merge catalog.ucsd.edu course data into data.json.
//
//   node merge-catalog.js ../ucsd-course-prereqs.json
//   node build.js            # then re-hash data.json + rewrite index.html
//
// Two jobs, both driven by the catalog scrape (7,500 courses with full titles,
// units and prerequisites):
//
//  1. TITLES. UCSD's grade-distribution export abbreviates course titles to a
//     30-character field ("Probablty Stats/Bioinformatics"). Wherever a course's
//     stored title is one of those 30-char stubs and the catalog has a longer
//     official title, we swap in the catalog title.
//
//  2. CATALOG-ONLY COURSES (src=4). The site is built from grade distributions,
//     so a course that has never had a recorded distribution — many grad
//     seminars, directed-study and research courses — simply didn't exist here
//     (e.g. BENG 223). We add a single reference row per missing catalog course
//     so it is at least findable, with no GPA/instructor data. These rows carry
//     off=0, so the default "Offered this term only" filter hides them; they
//     surface when that toggle is off, and the app points users there when a
//     search only matches catalog rows.
//
// Prerequisite text from the catalog is merged into `pre` for any course that
// lacks it. Idempotent: re-running with the same input is a no-op. Zero deps.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data.json");
const catPath = process.argv[2] || path.join(ROOT, "..", "ucsd-course-prereqs.json");

if (!fs.existsSync(catPath)) {
  console.error("merge-catalog.js: catalog file not found: " + catPath);
  process.exit(1);
}

const d = JSON.parse(fs.readFileSync(DATA, "utf8"));
const cat = JSON.parse(fs.readFileSync(catPath, "utf8"));
const courses = cat.courses || [];
if (!courses.length) { console.error("merge-catalog.js: no courses in catalog file"); process.exit(1); }

const C = {};
d.cols.forEach((name, i) => { C[name] = i; });
const titles = d.titles;

// "SUBJ NUM" exactly as the app keys courses.
const CK = (s, c) => String(s).toUpperCase() + " " + String(c).toUpperCase().replace(/[^0-9A-Z]/g, "");

// ---- catalog map ----
const catMap = new Map();
for (const c of courses) {
  if (!c.subject || !c.num || !c.title) continue;
  catMap.set(CK(c.subject, c.num), c);
}

// ---- title interning ----
const titleIdx = new Map();
titles.forEach((t, i) => { if (!titleIdx.has(t)) titleIdx.set(t, i); });
function internTitle(t) {
  if (titleIdx.has(t)) return titleIdx.get(t);
  const i = titles.push(t) - 1;
  titleIdx.set(t, i);
  return i;
}

// ---- 1. fix 30-char abbreviated titles ----
// The grade export's field width is 30; anything shorter was never truncated.
let titlesFixed = 0;
const fixedCourses = new Set();
for (const r of d.recs) {
  const cur = titles[r[C.t]];
  if (!cur || cur.length !== 30) continue;
  const hit = catMap.get(CK(r[C.s], r[C.c]));
  if (!hit || !hit.title || hit.title.length <= cur.length) continue;
  r[C.t] = internTitle(hit.title);
  if (!fixedCourses.has(CK(r[C.s], r[C.c]))) { fixedCourses.add(CK(r[C.s], r[C.c])); titlesFixed++; }
}

// ---- 2. add catalog-only courses as src=4 reference rows ----
const present = new Set(d.recs.map(r => CK(r[C.s], r[C.c])));
const NCOL = d.cols.length;
let added = 0;
for (const [key, c] of catMap) {
  if (present.has(key)) continue;
  const row = new Array(NCOL).fill(null);
  row[C.s] = String(c.subject).toUpperCase();
  row[C.c] = String(c.num).toUpperCase();
  row[C.t] = internTitle(c.title);
  row[C.i] = "";                                   // no instructor
  row[C.n] = 0;                                    // never recorded as taught
  row[C.off] = 0;                                  // not on the FA26 schedule
  const lv = parseInt(String(c.num).replace(/[^0-9]/g, ""), 10);
  row[C.lv] = isNaN(lv) ? 0 : lv;
  row[C.src] = 4;                                  // catalog-only
  row[C.cur] = 0;
  d.recs.push(row);
  present.add(key);
  added++;
}

// ---- prerequisites: fill any gaps from the catalog ----
d.pre = d.pre || {};
let preAdded = 0;
for (const [key, c] of catMap) {
  if (!c.prereq) continue;
  if (d.pre[key]) continue;
  d.pre[key] = c.prereq;
  preAdded++;
}

// ---- meta ----
d.meta = d.meta || {};
d.meta.catalog = {
  source: cat.source || "catalog.ucsd.edu",
  retrieved: cat.retrieved || null,
  courses: catMap.size,
  titlesFixed,
  catalogOnlyRows: d.recs.filter(r => r[C.src] === 4).length,
};

fs.writeFileSync(DATA, JSON.stringify(d));
const mb = n => (n / 1024 / 1024).toFixed(2) + " MB";
console.log("merge-catalog.js");
console.log("  catalog courses read : " + catMap.size);
console.log("  titles de-abbreviated: " + titlesFixed);
console.log("  catalog-only rows add: " + added);
console.log("  prerequisites added  : " + preAdded);
console.log("  total rows           : " + d.recs.length);
console.log("  data.json            : " + mb(fs.statSync(DATA).size));
console.log("\nNext: node build.js");
