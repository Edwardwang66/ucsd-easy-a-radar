#!/usr/bin/env node
// Refresh this term's instructors and meeting times from a TSS seat-sync export.
//
//   node merge-schedule.js ~/Downloads/ucsd-seats-2026-2.json --dry-run
//   node merge-schedule.js ~/Downloads/ucsd-seats-2026-2.json
//   node healthcheck.js && node build.js
//
// schedule.json comes from a third-party WebReg snapshot taken once, so it goes
// stale: by August the July snapshot had a whole lecture group of MATH 20D with
// no instructor at all (TSS says Michael Holst), which also kept him out of the
// rankings. TSS is the live source and now carries every section's instructor,
// so this reconciles four places against it:
//
//   schedule.json  section instructors (fills blanks, corrects changes)
//   data.fa        this term's instructor list per course — drives the "FA26"
//                  line and the ✓ match on ranking rows
//   data.recs      cur=1 for a professor teaching the course now; a src=2 row
//                  ("0×", no grade data) for one who has no row for it yet
//   data.newProf   instructors with no grade history anywhere
//
// Sections are matched on what both sources agree about — type + days + start
// time — since they number sections differently ("B00" vs "002-000-LE"). A
// section with no meeting time (async labs) inherits its group's instructor,
// the group being mapped by whichever of its sections did match. Anything that
// stays ambiguous is left alone. Idempotent. Zero dependencies.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data.json");
const SCHED = path.join(ROOT, "schedule.json");

const S_CODE = 0, S_TYPE = 1, S_DAYS = 2, S_START = 3, S_INSTR = 7;

// Independent study / research / internship course numbers — 198, 199, 298,
// 299, 500 and their lettered variants.
const UMBRELLA = /^[A-Z]+ (19[89]|29[89]|500)[A-Z]*$/;

function ck(subject, number) {
  return String(subject).toUpperCase() + " " +
    String(number).toUpperCase().replace(/[^0-9A-Z]/g, "");
}
function scraperCodeToKey(course) {
  const i = String(course).indexOf("-");
  if (i < 0) return null;
  return ck(course.slice(0, i), course.slice(i + 1).replace(/^0+(?=\d)/, ""));
}
// schedule.json stores "5:00p" / "11:00a"; TSS gives 24h "17:00".
function to24(t) {
  const m = /^(\d{1,2}):(\d{2})\s*([ap])?$/i.exec(String(t || "").trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if ((m[3] || "").toLowerCase() === "p") h += 12;
  return String(h).padStart(2, "0") + ":" + m[2];
}
const timeKey = (type, days, start) => `${type}|${days}|${start}`;

// Compound-surname-aware person matching (same approach as merge-rmp.js):
// both names are normalised to "given … surname" order and the surname is
// however much of the tail the two actually share, compared as joined text.
// Taking just the last word created 53 duplicate rows — "Soosai Raj, Adalbert
// Geral" vs "Adalbert Gerald Soosai Raj" never matched on surname "raj" vs
// "soosai raj". Sharing the tail is necessary but not sufficient: the names
// must also share a given name, unless one is wholly contained in the other.
const deacc = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const alnum = (s) => deacc(s).toLowerCase().replace(/[^a-z0-9]/g, "");
function nameTokens(name) {
  const n = deacc(name).replace(/\s+/g, " ").trim();
  if (!n) return [];
  if (n.includes(",")) {
    const i = n.indexOf(",");
    const surname = n.slice(0, i).trim().split(" ").map(alnum).filter(Boolean);
    const given = n.slice(i + 1).trim().split(" ").map(alnum).filter(Boolean);
    return [...given, ...surname];
  }
  return n.split(" ").map(alnum).filter(Boolean);
}
function sameName(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  let best = null;
  for (let ka = 1; ka <= ta.length; ka++) {
    const tail = ta.slice(ta.length - ka).join("");
    for (let kb = 1; kb <= tb.length; kb++) {
      if (tail === tb.slice(tb.length - kb).join("") && (!best || ka + kb > best[0] + best[1])) {
        best = [ka, kb];
      }
    }
  }
  if (!best) return false;
  const ga = ta.slice(0, ta.length - best[0]);
  const gb = tb.slice(0, tb.length - best[1]);
  if (!ga.length || !gb.length) return true;     // one name contains the other
  return ga.some((x) => gb.includes(x));
}

function main() {
  const src = process.argv[2];
  const dry = process.argv.includes("--dry-run");
  if (!src) {
    console.error("usage: node merge-schedule.js <ucsd-seats-*.json> [--dry-run]");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const sched = JSON.parse(fs.readFileSync(SCHED, "utf8"));
  const scrape = JSON.parse(fs.readFileSync(src, "utf8"));
  const C = {};
  data.cols.forEach((c, i) => (C[c] = i));

  // ---- index the scrape: course -> deduped sections ----
  const tss = new Map();
  for (const c of scrape.courses || []) {
    const key = scraperCodeToKey(c.course);
    if (!key) continue;
    const secs = new Map();
    for (const p of c.packages || []) {
      for (const s of p.sections || []) secs.set(s.sectionCode, s);
    }
    if (secs.size) tss.set(key, [...secs.values()]);
  }

  const stats = { filled: 0, corrected: 0, faAdded: 0, curSet: 0, rowsAdded: 0, newProf: 0,
    skipUmbrella: 0, skipNamesake: 0, skipIncompleteCourse: 0 };
  const review = [];
  const samples = { filled: [], corrected: [], rows: [] };

  // ---- 1. schedule.json instructors ----
  for (const [key, course] of Object.entries(sched.courses)) {
    const secs = tss.get(key);
    if (!secs) continue;

    // If the schedule lists more sections of some type than TSS knows about,
    // the scrape is missing modules for this course (special-topics courses
    // are several modules, and a lost module once turned ECE 285's Yang Zheng
    // into Parinaz Naghizadeh). Incomplete evidence — leave instructors alone.
    const tssTypeCount = {};
    for (const s of secs) if (s.type) tssTypeCount[s.type] = (tssTypeCount[s.type] || 0) + 1;
    const schedTypeCount = {};
    for (const x of course.sec) if (x[S_TYPE] !== "FI") schedTypeCount[x[S_TYPE]] = (schedTypeCount[x[S_TYPE]] || 0) + 1;
    if (Object.entries(schedTypeCount).some(([t, n]) => (tssTypeCount[t] || 0) < n)) {
      stats.skipIncompleteCourse++;
      continue;
    }

    // TSS group ("001") -> its instructor(s), and a lookup by meeting time
    const byTime = new Map();
    const groupInstr = new Map();
    const groupAll = new Map();          // g -> Set of every instructor in the group
    for (const s of secs) {
      const g = String(s.sectionCode || "").split("-")[0];
      if (s.instructor) {
        if (!groupInstr.has(g)) groupInstr.set(g, s.instructor);
        (groupAll.get(g) || groupAll.set(g, new Set()).get(g)).add(s.instructor);
      }
      if (s.days && s.start && s.instructor) {
        const k = timeKey(s.type, s.days, s.start);
        const prev = byTime.get(k);
        if (prev === undefined) byTime.set(k, s.instructor);
        else if (prev !== s.instructor) byTime.set(k, null);   // ambiguous
      }
    }

    // Map each schedule letter group to a TSS group, but only on evidence that
    // can't be read two ways: a section whose meeting time belongs to exactly
    // one TSS section, and a group that no other letter also claims. Courses
    // like CAT 125 run a dozen seminars at the same hour under different
    // instructors, and a loose mapping there silently reassigns them.
    const letterToGroup = new Map();
    const claimed = new Map();
    for (const x of course.sec) {
      if (x[S_TYPE] === "FI") continue;
      const letter = String(x[S_CODE] || "")[0];
      if (!letter) continue;
      const st = to24(x[S_START]);
      if (!st || !x[S_DAYS]) continue;
      const hits = secs.filter((s) =>
        s.days === x[S_DAYS] && s.start === st && s.type === x[S_TYPE]);
      if (hits.length !== 1) continue;
      const group = String(hits[0].sectionCode || "").split("-")[0];
      const prev = letterToGroup.get(letter);
      if (prev !== undefined && prev !== group) letterToGroup.set(letter, null);  // conflicting
      else letterToGroup.set(letter, group);
      claimed.set(group, (claimed.get(group) || new Set()).add(letter));
    }
    for (const [group, letters] of claimed) {
      if (letters.size > 1) for (const l of letters) letterToGroup.set(l, null);
    }

    for (const x of course.sec) {
      if (x[S_TYPE] === "FI") continue;
      const st = to24(x[S_START]);
      const exact = (st && x[S_DAYS]) ? byTime.get(timeKey(x[S_TYPE], x[S_DAYS], st)) : undefined;
      const viaGroup = groupInstr.get(letterToGroup.get(String(x[S_CODE] || "")[0]));
      const cur = String(x[S_INSTR] || "").trim();
      if (!cur) {
        // Two groups often run discussions at the same hour, so a time alone
        // can point at either instructor. Filling a blank is additive, so the
        // group is good enough evidence there; replacing a name is not.
        const want = exact || viaGroup;
        if (!want) continue;
        if (!dry) x[S_INSTR] = want;
        stats.filled++;
        if (samples.filled.length < 5) samples.filled.push(`${key} ${x[S_CODE]} -> ${want}`);
      } else {
        // A correction needs evidence that can't be read two ways: the exact
        // meeting time, or — when times collide across groups (four groups all
        // run a Th 5:00p discussion) — an unambiguously-mapped TSS group that
        // has exactly ONE instructor, so every section in it is that person.
        const g = letterToGroup.get(String(x[S_CODE] || "")[0]);
        const groupSole = g && groupAll.get(g) && groupAll.get(g).size === 1
          ? groupInstr.get(g) : null;
        const want = exact || groupSole;
        if (want && !sameName(cur, want)) {
          if (!dry) x[S_INSTR] = want;
          stats.corrected++;
          if (samples.corrected.length < 8) samples.corrected.push(`${key} ${x[S_CODE]}: ${cur} -> ${want}`);
        }
      }
    }
  }

  // ---- 2..4. data.fa / recs.cur / new rows / newProf ----
  const gradeNames = new Set();                       // anyone with a grade row anywhere
  for (const r of data.recs) if (r[C.i] && r[C.src] === 0) gradeNames.add(r[C.i]);
  const hasGradeHistory = (name) => [...gradeNames].some((g) => sameName(g, name));

  const rowsByCourse = new Map();
  for (const r of data.recs) {
    const k = ck(r[C.s], r[C.c]);
    if (!rowsByCourse.has(k)) rowsByCourse.set(k, []);
    rowsByCourse.get(k).push(r);
  }
  const titleOf = (key) => {
    const rows = rowsByCourse.get(key) || [];
    const withTitle = rows.find((r) => r[C.t] >= 0);
    return withTitle ? withTitle[C.t] : -1;
  };
  const fa = data.fa || (data.fa = {});
  const newProf = new Set(data.newProf || []);
  const added = [];

  for (const [key, secs] of tss) {
    // this term's instructors for the course, in first-seen order
    const names = [];
    for (const s of secs) {
      if (s.instructor && !names.some((n) => n === s.instructor)) names.push(s.instructor);
    }
    if (!names.length) continue;

    // `fa` is this term's instructor list and is meant to track schedule.json;
    // an entry for a course the schedule doesn't carry is unreachable in the UI
    // and just reads as drift.
    if (Object.prototype.hasOwnProperty.call(sched.courses, key)) {
      const list = fa[key] || [];
      for (const n of names) {
        if (!list.some((e) => sameName(e, n))) {
          if (!dry) list.push(n);
          stats.faAdded++;
        }
      }
      if (!dry && list.length) fa[key] = list;
    }

    const inSchedule = Object.prototype.hasOwnProperty.call(sched.courses, key);
    const rows = rowsByCourse.get(key) || [];
    for (const n of names) {
      const match = rows.find((r) => r[C.i] && sameName(r[C.i], n));
      if (match) {
        // "Teaching now" is read alongside the course's fa list, so only claim
        // it where that list exists — i.e. where the schedule carries the course
        if (inSchedule && match[C.cur] !== 1) { if (!dry) match[C.cur] = 1; stats.curSet++; }
        continue;
      }
      // Independent study, research and internship courses list every willing
      // advisor as an instructor — dozens per course. The site already presents
      // them as "Instructors vary / research", so a row per advisor would bury
      // the rankings without telling anyone anything.
      if (UMBRELLA.test(key)) { stats.skipUmbrella++; continue; }
      // Same surname, different first initial: nearly always one person under
      // two name forms ("Libby Butler" / "Butler, Elizabeth Annette"), which
      // belongs in `aka`, not in a second row. Collect for review instead.
      const tn = nameTokens(n);
      const lastWord = tn[tn.length - 1] || "";
      const namesake = rows.find((r) => {
        if (!r[C.i]) return false;
        const tr = nameTokens(r[C.i]);
        return tr.includes(lastWord) || tn.includes(tr[tr.length - 1] || "");
      });
      if (namesake) {
        stats.skipNamesake++;
        if (review.length < 40) review.push(`${key}: TSS "${n}" vs recs "${namesake[C.i]}"`);
        continue;
      }

      // no row for this professor on this course — add a "teaching now, no
      // grade data" row (src=2) so they're visible in the rankings
      const m = /^([A-Z]+)\s+(.+)$/.exec(key);
      if (!m) continue;
      const lv = parseInt(m[2], 10);
      if (!Number.isFinite(lv)) continue;
      const row = new Array(data.cols.length).fill(null);
      row[C.s] = m[1]; row[C.c] = m[2]; row[C.t] = titleOf(key); row[C.i] = n;
      // "Offered this term" gates the schedule builder and the time filter, so
      // only claim it for a course the schedule actually carries — TSS lists a
      // few the snapshot doesn't, and flagging those strands the row on
      // features that have no sections to work with.
      const offered = inSchedule ? 1 : 0;
      row[C.n] = 0; row[C.off] = offered; row[C.lv] = lv; row[C.src] = 2; row[C.cur] = offered;
      added.push(row);
      stats.rowsAdded++;
      if (samples.rows.length < 6) samples.rows.push(`${key} · ${n}`);
      if (!hasGradeHistory(n) && !newProf.has(n)) { newProf.add(n); stats.newProf++; }
    }
  }

  if (!dry) {
    data.recs.push(...added);
    data.newProf = [...newProf];
    sched.generated = new Date().toISOString().slice(0, 10);
    sched.source = (sched.source || "") + " + TSS refresh";
    fs.writeFileSync(SCHED, JSON.stringify(sched));
    fs.writeFileSync(DATA, JSON.stringify(data));
  }

  console.log(`${dry ? "[dry run] would change" : "changed"}:`);
  console.log(`  schedule.json instructors filled : ${stats.filled}`);
  console.log(`  schedule.json instructors fixed  : ${stats.corrected}`);
  console.log(`  data.fa names added              : ${stats.faAdded}`);
  console.log(`  recs rows marked teaching-now    : ${stats.curSet}`);
  console.log(`  recs rows added (src=2, 0x)      : ${stats.rowsAdded}`);
  console.log(`  newProf added                    : ${stats.newProf}`);
  console.log(`  skipped (umbrella research course): ${stats.skipUmbrella}`);
  console.log(`  skipped (TSS missing sections)     : ${stats.skipIncompleteCourse} course(s)`);
  console.log(`  skipped (same surname, review aka): ${stats.skipNamesake}`);
  for (const [label, list] of Object.entries(samples)) {
    if (list.length) console.log(`  e.g. ${label}: ` + list.join(" | "));
  }
  if (review.length) {
    console.log("\n  name-variant candidates for `aka` (not added as rows):");
    for (const r of review.slice(0, 20)) console.log("    " + r);
    if (review.length > 20) console.log(`    … and ${review.length - 20} more`);
  }
  if (dry) console.log("\nNothing written. Re-run without --dry-run to apply.");
  else console.log("\nNext: node healthcheck.js && node build.js");
}

main();
