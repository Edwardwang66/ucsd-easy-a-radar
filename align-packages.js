#!/usr/bin/env node
// Align TSS seat packages to schedule sections, so the app can send each
// section group to ITS OWN package page instead of the course-level link.
//
//   node align-packages.js                       # annotate data.json in place
//   node align-packages.js --restore <old.json>  # first restore `p` maps that a
//                                                # previous cleanup dropped (only
//                                                # where the course-level url is
//                                                # unchanged), then annotate
//   node align-packages.js --dry-run             # report only, write nothing
//
// WHY. Seminar / special-topics courses (AWP 3's 60+ writing seminars, ECE 285's
// three lecture topics, MCWP/WCWP/CAT/SYN sections…) are one separately-enrollable
// TSS package PER SECTION GROUP, and several groups can meet at identical times
// under different instructors. The app's time-key match (type|days|start) cannot
// tell those apart, so every ambiguous group used to fall back to the course-level
// link — which is itself just the FIRST group's package, i.e. a different
// professor's section (#71).
//
// WHAT WE KNOW. The scraper walks TSS's module list in display order, and TSS
// lists packages in the same order WebReg lists section groups — verified against
// the data: for every one-package-per-group course, the ordered sequence of
// package time keys tracks the ordered sequence of schedule groups exactly, with
// occasional gaps where the scrape missed a module. So the two ORDERED sequences
// can be aligned like a diff, and a (group, package) pair is trusted only when it
// appears in EVERY maximum alignment — a package near a gap that could belong to
// either of two same-time groups matches nothing and stays link-less.
//
// WHAT IT WRITES (data.json `seats[key]`):
//   .x     = 1 on courses where sections map 1:1 to packages (or, with no `p` at
//            all, where several groups run under different instructors) — tells
//            the app the course-level url is a single group's package, so an
//            unidentified group must fall back to the TSS launchpad, never to it.
//   .p[].s = the aligned group's section codes (what the app matches picks on)
//   .p[].i = the aligned group's instructor names from schedule.json (lets a
//            professor's row in the rankings link straight to their section)
// Combo courses (one lecture × many labs, several packages per group) are left
// to the existing time-key matching and never annotated.
//
// Run it after merge-seats.js (fresh scrape) or merge-schedule.js (section /
// instructor refresh) — both invalidate the alignment. Zero dependencies.
"use strict";

const fs = require("fs");
const path = require("path");

const S = { CODE: 0, TYPE: 1, DAYS: 2, START: 3, INSTR: 7, CANC: 10 };

function parseMin(t) {
  const m = /^(\d{1,2}):(\d{2})\s*([ap])?/i.exec(String(t || ""));
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2], ap = (m[3] || "").toLowerCase();
  if (ap === "p" && h !== 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return h * 60 + mi;
}

// "LE|TuTh|12:30" — must mirror index.html's secTimeKey / merge-seats' sectionKey.
function secTimeKey(sec) {
  const ty = sec && sec[S.TYPE], days = sec && sec[S.DAYS], mins = parseMin(sec && sec[S.START]);
  if (!ty || !days || mins == null) return null;
  return ty + "|" + days + "|" +
    String(Math.floor(mins / 60)).padStart(2, "0") + ":" + String(mins % 60).padStart(2, "0");
}

// Ordered [groupChar, sections[]] pairs, grouped by the EXACT first character of
// the section code (WebReg's letters run past 'Z' into ASCII and lowercase on
// very large courses) — must mirror index.html's activeGroups.
function activeGroups(course) {
  const byChar = new Map();
  for (const sec of (course && course.sec) || []) {
    if (!Array.isArray(sec) || sec[S.CANC] || sec[S.TYPE] === "FI") continue;
    const code = String(sec[S.CODE] || "");
    const ch = code.charAt(0);
    if (!ch || /[0-9]/.test(ch)) continue; // date-coded rows
    if (!byChar.has(ch)) byChar.set(ch, []);
    byChar.get(ch).push(sec);
  }
  return [...byChar.entries()];
}

// A group's time keys as a Set. Empty when no section has a usable meeting time.
function groupKeySet(sections) {
  return new Set(sections.map(secTimeKey).filter(Boolean));
}

// Can this package belong to this group? The scrape sometimes records only one
// of a section's several weekly meetings (MAE 107's lectures meet Th AND MWF but
// the package key lists just one), so the package's keys must be a non-empty
// SUBSET of the group's keys — the certainty analysis rejects a package whose
// keys fit more than one group.
function pkgFitsGroup(pkg, keySet) {
  const keys = (pkg && pkg.k) || [];
  return keys.length > 0 && keys.every((k) => keySet.has(k));
}

// One package per group is only possible when no group carries a same-type
// CHOICE — several sections of one type with different codes (a group with LE +
// two LAs is several packages: a combo course). Repeated rows with the SAME
// code are one section's multiple weekly meetings, not a choice.
function onePackagePerGroup(groups) {
  return groups.length > 0 && groups.every(([, sections]) => {
    const codesByType = new Map();
    for (const sec of sections) {
      const ty = sec[S.TYPE];
      if (!codesByType.has(ty)) codesByType.set(ty, new Set());
      codesByType.get(ty).add(String(sec[S.CODE]));
    }
    return [...codesByType.values()].every((codes) => codes.size === 1);
  });
}

// Pairs present in EVERY maximum-length alignment of the two ordered sequences.
// eq(i, j) says whether groups[i] can match packages[j] at all. Returns a Map of
// packageIndex -> groupIndex containing only pairs that are forced: (i, j) lies
// on a maximum alignment AND neither i nor j has any other feasible partner.
function certainPairs(n, m, eq) {
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0)); // prefix LCS
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++)
    L[i][j] = eq(i - 1, j - 1) ? L[i - 1][j - 1] + 1 : Math.max(L[i - 1][j], L[i][j - 1]);
  const R = Array.from({ length: n + 2 }, () => new Array(m + 2).fill(0)); // suffix LCS
  for (let i = n; i >= 1; i--) for (let j = m; j >= 1; j--)
    R[i][j] = eq(i - 1, j - 1) ? R[i + 1][j + 1] + 1 : Math.max(R[i + 1][j], R[i][j + 1]);
  const total = L[n][m];
  if (!total) return new Map();
  const byGroup = new Map(), byPkg = new Map(); // index -> [feasible partners]
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    if (!eq(i, j)) continue;
    if (L[i][j] + 1 + R[i + 2][j + 2] !== total) continue; // not on any max alignment
    (byGroup.get(i) || byGroup.set(i, []).get(i)).push(j);
    (byPkg.get(j) || byPkg.set(j, []).get(j)).push(i);
  }
  const out = new Map();
  for (const [j, groupsFor] of byPkg) {
    if (groupsFor.length !== 1) continue;
    const i = groupsFor[0];
    if ((byGroup.get(i) || []).length === 1) out.set(j, i);
  }
  return out;
}

// Annotate one seats entry against its schedule course. Mutates `entry`.
// Returns a status string for reporting.
function annotateEntry(entry, course) {
  // start from a clean slate — a previous alignment is stale by definition
  const hadX = !!entry.x;
  delete entry.x;
  if (Array.isArray(entry.p)) for (const p of entry.p) { if (hadX) { delete p.s; delete p.i; } else delete p.s; }
  if (!course) return "no-schedule";

  const groups = activeGroups(course);
  if (!Array.isArray(entry.p) || !entry.p.length) {
    // No per-package links at all. When several groups run under different
    // instructors, the single course-level url is one group's package and the
    // app must not present it as everyone's — flag it.
    const instructors = new Set();
    for (const [, sections] of groups) for (const sec of sections) if (sec[S.INSTR]) instructors.add(sec[S.INSTR]);
    if (groups.length > 1 && instructors.size > 1) { entry.x = 1; return "flagged-ambiguous"; }
    return "skip";
  }

  if (!onePackagePerGroup(groups)) return "combo";
  if (groups.length < 2) return "skip";

  entry.x = 1;
  const keySets = groups.map(([, sections]) => groupKeySet(sections));
  const eq = (i, j) => pkgFitsGroup(entry.p[j], keySets[i]);
  const certain = certainPairs(groups.length, entry.p.length, eq);
  for (const [j, i] of certain) {
    const [, sections] = groups[i];
    entry.p[j].s = [...new Set(sections.map((sec) => String(sec[S.CODE])))];
    const instructors = [...new Set(sections.map((sec) => sec[S.INSTR]).filter(Boolean))];
    if (instructors.length) entry.p[j].i = instructors; else delete entry.p[j].i;
  }
  return certain.size === entry.p.length ? "aligned"
    : certain.size ? "aligned-partial" : "aligned-none";
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry-run");
  const ri = argv.indexOf("--restore");
  const restorePath = ri >= 0 ? argv[ri + 1] : null;
  if (ri >= 0 && !restorePath) {
    console.error("usage: node align-packages.js [--restore <old-data.json>] [--dry-run]");
    process.exit(1);
  }

  const ROOT = __dirname;
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
  const sched = JSON.parse(fs.readFileSync(path.join(ROOT, "schedule.json"), "utf8"));
  const seats = data.seats || {};
  const courses = (sched && sched.courses) || {};

  let restored = 0;
  if (restorePath) {
    const old = JSON.parse(fs.readFileSync(restorePath, "utf8"));
    for (const [key, oldEntry] of Object.entries((old && old.seats) || {})) {
      const cur = seats[key];
      if (!cur || cur.p || !Array.isArray(oldEntry.p) || !oldEntry.p.length) continue;
      if (cur.u !== oldEntry.u) continue; // different scrape — old package urls can't be trusted
      cur.p = oldEntry.p.map((p) => ({ u: p.u, k: [...(p.k || [])], ...(p.i ? { i: [...p.i] } : {}) }));
      restored++;
      console.log(`restored p: ${key} (${cur.p.length} packages)`);
    }
  }

  const stats = {};
  const partial = [];
  let sectionLinks = 0;
  for (const [key, entry] of Object.entries(seats)) {
    const status = annotateEntry(entry, courses[key]);
    stats[status] = (stats[status] || 0) + 1;
    if (Array.isArray(entry.p)) sectionLinks += entry.p.filter((p) => p.s).length;
    if (status === "aligned-partial" || status === "aligned-none") {
      const matched = entry.p.filter((p) => p.s).length;
      partial.push(`${key}: ${matched}/${entry.p.length} packages matched`);
    }
  }

  if (!dry) fs.writeFileSync(path.join(ROOT, "data.json"), JSON.stringify(data));

  console.log(`${dry ? "[dry run] " : ""}seats entries: ${Object.keys(seats).length}` +
    (restorePath ? `   restored p: ${restored}` : ""));
  for (const [status, n] of Object.entries(stats).sort()) console.log(`  ${status.padEnd(18)} ${n}`);
  console.log(`  section-level links written: ${sectionLinks}`);
  if (partial.length) {
    console.log("\nincomplete alignments (unmatched groups fall back to the TSS launchpad):");
    for (const line of partial) console.log("  - " + line);
  }
  console.log(dry ? "\nNothing written." : "\nNext: node healthcheck.js && node build.js");
}

if (require.main === module) main();

module.exports = { activeGroups, groupKeySet, pkgFitsGroup, onePackagePerGroup, certainPairs, annotateEntry, secTimeKey };
