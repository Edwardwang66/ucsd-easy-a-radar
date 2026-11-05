#!/usr/bin/env node
// new-term.js — switch the site to a new quarter from a TSS Schedule-of-Classes scrape.
//
//   node new-term.js soc_2026_3.json --dry-run     # report only
//   node new-term.js soc_2026_3.json               # rebuild schedule.json, reset data.json's
//                                                  # term-derived state, flip index.html's TERM_CODE,
//                                                  # and write ucsd-seats-<year>-<period>.json
//   then:  node merge-schedule.js ucsd-seats-2026-3.json
//          node merge-seats.js    ucsd-seats-2026-3.json
//          node align-packages.js
//          node sync-current.js   ucsd-seats-2026-3.json
//          node healthcheck.js && node build.js
//
// The scrape is the raw SAP module dump (term, modules[] with _sections / _schedule /
// _instructor). Everything the old WebReg snapshot gave us is in there — building and
// room, final-exam date/time and the delivery mode are embedded in each section's
// `Sched` text, meeting days/times are structured rows in `_schedule`.
//
// What changes with the term (and so is rebuilt here):
//   schedule.json   whole file: one course per module, WebReg-style section codes
//                   ("001-000-LE" -> "A00"), meeting rows, FI rows, buildings carried over
//   data.json       off := course is in the new schedule; cur := 0; fa / newProf / seats
//                   emptied (merge-schedule / merge-seats / sync-current refill them);
//                   src=2 ("0x, teaching now") and src=3 (TBA) rows dropped — they were
//                   derived from the previous term — then src=3 rows re-added for offered
//                   courses that would otherwise have no row at all (no instructor, or an
//                   independent-study umbrella, which also gets its advisor list in fa)
//   index.html      TERM_CODE flipped (the quarter must already be in the TERMS table)
// Grade history, titles, aliases, prerequisites, SET and RMP data are untouched.
// Zero dependencies.
"use strict";

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const src = argv.find((a) => !a.startsWith("--"));
const dry = argv.includes("--dry-run");
const noFlip = argv.includes("--no-flip");
const rootArg = argv.indexOf("--root");
const ROOT = rootArg >= 0 ? path.resolve(argv[rootArg + 1]) : __dirname;
if (!src) {
  console.error("usage: node new-term.js <soc_<year>_<period>.json> [--dry-run] [--no-flip] [--root DIR]");
  process.exit(1);
}
const P = (f) => path.join(ROOT, f);

// ---------------------------------------------------------------- helpers
const UMBRELLA = /^[A-Z]+ (19[89]|29[89]|500)[A-Z]*$/;
const DOW = { 1: "M", 2: "Tu", 3: "W", 4: "Th", 5: "F", 6: "Sa", 7: "Su" };
const DAY_ORDER = ["M", "Tu", "W", "Th", "F", "Sa", "Su"];
const ck = (subject, number) => String(subject).toUpperCase() + " " + String(number).toUpperCase().replace(/[^0-9A-Z]/g, "");
function keyOf(abbr) {                                  // "MATH-020A" -> "MATH 20A"
  const m = /^([A-Z]+)-0*(\d+[A-Z]*)$/.exec(String(abbr || "").trim());
  return m ? ck(m[1], m[2]) : null;
}
function t12(hms) {                                      // "16:00:00" -> "4:00p"   (schedule.json style)
  const m = /^(\d{1,2}):(\d{2})/.exec(hms || "");
  if (!m) return "";
  const h = +m[1], mi = m[2];
  return `${h % 12 || 12}:${mi}${h < 12 ? "a" : "p"}`;
}
function t24(ampm) {                                     // "02:00 PM" -> "14:00"   (TSS export style)
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(String(ampm || "").trim());
  if (!m) return null;
  let h = +m[1] % 12; if (/p/i.test(m[3])) h += 12;
  return String(h).padStart(2, "0") + ":" + m[2];
}
const to24FromHms = (hms) => (hms || "").slice(0, 5);   // "16:00:00" -> "16:00"
function daysStr(set) { return DAY_ORDER.filter((d) => set.has(d)).join(""); }
// "001-000-LE" -> ["A00", "A"]. WebReg's group letter is simply ASCII 64+n, and it keeps
// going past 'Z' into "[ \ ] ^ _ ` a … z { | } ~" (FA26's AWP 3 had 66 groups) — the app
// groups sections by that first character, so mirror it exactly rather than wrapping.
function groupCode(abbr) {
  const m = /^(\d{3})-(\d{3})-([A-Z]{2})$/.exec(abbr || "");
  if (!m) return [String(abbr || ""), String(abbr || "").charAt(0)];
  const letter = String.fromCharCode(64 + +m[1]);
  return [letter + m[2].slice(-2), letter];
}
// One `Sched` line: "Tu, Th 02:00 PM - 03:20 PM In Person @ Peterson Hall Room 104"
const LINE = /^((?:M|Tu|W|Th|F|Sa|Su)(?:,\s*(?:M|Tu|W|Th|F|Sa|Su))*)?\s*(\d{1,2}:\d{2} [AP]M)\s*-\s*(\d{1,2}:\d{2} [AP]M)\s*(.*?)\s*$/;
const FINAL = /^Final Examination\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d{1,2}:\d{2} [AP]M)\s*-\s*(\d{1,2}:\d{2} [AP]M)\s*(.*?)\s*$/;
function splitLoc(tail) {                                // "In Person @ Peterson Hall Room 104" -> {mode, building, room}
  const at = tail.indexOf("@");
  const mode = (at >= 0 ? tail.slice(0, at) : tail).trim();
  const loc = at >= 0 ? tail.slice(at + 1).trim() : "";
  let building = "", room = "";
  if (loc) {
    const r = /^(.*?)\s+Room\s+(\S+)\s*$/.exec(loc);
    if (r) { building = r[1].trim(); room = r[2].replace(/^0+(?=\d)/, ""); } else building = loc;
  } else if (/online/i.test(mode)) building = "RCLAS";    // the WebReg snapshot's code for remote classes
  return { mode, building, room };
}
function parseSched(text) {
  const meets = [], finals = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || /^Schedule Not Defined/i.test(line)) continue;
    let m = FINAL.exec(line);
    if (m) { finals.push({ date: `${m[1]}/${m[2]}/${m[3]}`, start: m[4], end: m[5], ...splitLoc(m[6]) }); continue; }
    m = LINE.exec(line);
    if (!m) continue;
    if (!m[1] && /^12:00 AM$/.test(m[2]) && /^12:00 AM$/.test(m[3])) continue;   // placeholder, not a meeting
    meets.push({ days: m[1] ? m[1].split(/,\s*/) : [], start: m[2], end: m[3], ...splitLoc(m[4]) });
  }
  return { meets, finals };
}

// ---------------------------------------------------------------- load
const soc = JSON.parse(fs.readFileSync(src, "utf8"));
const year = String((soc.term || {}).AcademicYear || (soc.modules[0] || {}).AcademicYear || "");
const period = String((soc.term || {}).AcademicPeriod || (soc.modules[0] || {}).AcademicPeriod || "");
const sample = soc.modules.find((m) => m.Persl) || {};
const pm = /^(\d{2})(FA|WI|SP|SU|S1|S2)$/.exec(sample.Persl || "");         // "27WI"
const code = pm ? pm[2] + pm[1] : null;                                      // "WI27"
const qname = (sample.AcademicPeriod_Text || "").replace(/\s*Quarter$/i, "");  // "Winter"
const calYear = pm ? 2000 + +pm[1] : +year;
const termName = qname && pm ? `${qname} ${calYear}` : `${year}/${period}`;
if (!year || !period || !code) { console.error("could not read the term (AcademicYear / AcademicPeriod / Persl) from the scrape"); process.exit(1); }
console.log(`scrape: ${soc.modules.length} modules, term ${year}/${period} = ${code} (${termName}), scraped ${soc.scrapedAt || "?"}`);

const old = JSON.parse(fs.readFileSync(P("schedule.json"), "utf8"));
const data = JSON.parse(fs.readFileSync(P("data.json"), "utf8"));
const C = {}; data.cols.forEach((c, i) => (C[c] = i));

// Building names in `Sched` are cut at 40 characters ("Computer Science and Engineering Buildin")
// and a complex's wings get suffixes ("Extended Studies and Public Programs - G"); the walk /
// bike matrix is keyed by the exact names in the coordinates map, so resolve to those.
const BLD_KEYS = Object.keys(old.buildings);
const bldCache = new Map();
function resolveBuilding(name) {
  if (!name || name === "RCLAS") return name || "";
  if (old.buildings[name]) return name;
  if (bldCache.has(name)) return bldCache.get(name);
  let out = name;
  if (/placeholder/i.test(name)) out = "";
  else {
    const pre = BLD_KEYS.filter((k) => k.startsWith(name));          // truncated scrape name
    const suf = BLD_KEYS.filter((k) => name.startsWith(k));          // scrape name carries a wing suffix
    if (pre.length === 1) out = pre[0];
    else if (suf.length) out = suf.sort((a, b) => b.length - a.length)[0];
    else if (pre.length > 1) out = pre.sort((a, b) => a.length - b.length)[0];
  }
  bldCache.set(name, out);
  return out;
}

// ---------------------------------------------------------------- schedule.json
const courses = {}, legacy = [];
const stats = { courses: 0, sections: 0, meetingRows: 0, tbaRows: 0, fiRows: 0, online: 0, withInstructor: 0,
  unknownBuilding: new Map(), unparsedSched: 0, dupKeys: [], skippedNoAbbr: 0, groupWrap: 0, recoded: 0 };
const bookingUrl = (moduleId, pkgObjid) =>
  `https://tss.ucsd.edu/fiori#ZUSModule-display?TileType=MYMOD&/Detail/EventPackage/SM/${moduleId}/00000000/0/0/0/00000000-0000-0000-0000-000000000000/${pkgObjid}/${year}/${period}/?`;

for (const mod of soc.modules) {
  const key = keyOf(mod.CourseAbbr);
  if (!key) { stats.skippedNoAbbr++; continue; }
  if (courses[key]) { stats.dupKeys.push(key); continue; }
  const [sub, num] = key.split(" ");
  // meeting rows per section id, grouped by time slot
  const slots = new Map();                                  // EventObjid -> Map("16:00:00|16:50:00" -> Set(days))
  for (const r of mod._schedule || []) {
    const k = `${r.BeginTime}|${r.EndTime}`;
    if (!slots.has(r.SectionId)) slots.set(r.SectionId, new Map());
    const bySlot = slots.get(r.SectionId);
    if (!bySlot.has(k)) bySlot.set(k, new Set());
    if (DOW[r.DoW]) bySlot.get(k).add(DOW[r.DoW]);
  }
  // sections, grouped the way WebReg groups them (A00 lecture, A01.. discussions, then the group's final)
  const groups = new Map();                                 // letter -> {rows:[], finals:Map, hasNonLE}
  const pkgs = new Map();                                   // EventPkgObjid -> {sections:[]}
  const seenSec = new Set(), usedCodes = new Set();
  for (const s of mod._sections || []) {
    if (seenSec.has(s.EventObjid)) continue;
    seenSec.add(s.EventObjid);
    let [codeStr, letter] = groupCode(s.EventAbbr);
    // TSS numbers a lecture and its co-scheduled lab/other "001-000-LE" / "001-000-LA" —
    // the same number with a different type. The app keys sections by code within a
    // course (WebReg never reused one), so give the second one the group's next free number.
    if (usedCodes.has(codeStr)) {
      const stem = codeStr.slice(0, -2);
      let n = Math.max(...[...usedCodes].filter((c) => c.startsWith(stem) && c.length === codeStr.length).map((c) => +c.slice(-2))) + 1;
      while (usedCodes.has(stem + String(n).padStart(2, "0"))) n++;
      codeStr = stem + String(n).padStart(2, "0");
      stats.recoded++;
    }
    usedCodes.add(codeStr);
    if (letter > "Z") stats.groupWrap++;
    const g = groups.get(letter) || { rows: [], finals: new Map(), hasNonLE: false, order: groups.size };
    groups.set(letter, g);
    if (s.TeachingMethod !== "LE") g.hasNonLE = true;
    const { meets, finals } = parseSched(s.Sched);
    const instr = (s.InstructorName || "").trim();
    if (instr) stats.withInstructor++;
    const seatsA = Number.isFinite(+s.EventPkgSeatsAvailable) && s.EventPkgSeatsAvailable !== "" ? +s.EventPkgSeatsAvailable : null;
    const seatsL = Number.isFinite(+s.EventPkgLimit) && s.EventPkgLimit !== "" ? +s.EventPkgLimit : null;
    const rowsOut = [];
    const bySlot = slots.get(s.EventObjid);
    if (bySlot && bySlot.size) {
      for (const [slot, daySet] of bySlot) {
        const [b, e] = slot.split("|");
        const start24 = to24FromHms(b);
        const meet = meets.find((x) => t24(x.start) === start24 && t24(x.end) === to24FromHms(e)) || meets.find((x) => t24(x.start) === start24) || meets[0] || {};
        if (meet.building === "RCLAS") stats.online++;
        rowsOut.push({ code: codeStr, type: s.TeachingMethod, days: daysStr(daySet), start: t12(b), end: t12(e),
          building: resolveBuilding(meet.building || ""), room: meet.room || "", start24, days24: daysStr(daySet) });
        stats.meetingRows++;
      }
    } else if (meets.length) {                                // no structured rows but the text has a meeting
      for (const x of meets) {
        rowsOut.push({ code: codeStr, type: s.TeachingMethod, days: daysStr(new Set(x.days)), start: t12(t24(x.start) + ":00"), end: t12(t24(x.end) + ":00"),
          building: resolveBuilding(x.building), room: x.room, start24: t24(x.start), days24: daysStr(new Set(x.days)) });
        stats.meetingRows++; stats.unparsedSched++;
      }
    } else {
      rowsOut.push({ code: codeStr, type: s.TeachingMethod, days: "", start: "", end: "", building: "", room: "", start24: null, days24: "" });
      stats.tbaRows++;
    }
    for (const r of rowsOut) {
      if (r.building && r.building !== "RCLAS" && !old.buildings[r.building]) stats.unknownBuilding.set(r.building, (stats.unknownBuilding.get(r.building) || 0) + 1);
      g.rows.push({ ...r, instr, seatsA, seatsL, isLE: s.TeachingMethod === "LE" });
    }
    for (const f of finals) {
      const fk = `${f.date}|${f.start}|${f.end}`;
      if (!g.finals.has(fk)) g.finals.set(fk, f);
    }
    const pk = s.EventPkgObjid || s.EventPkgOtjid || codeStr;
    if (!pkgs.has(pk)) pkgs.set(pk, { id: String(pk), bookingUrl: bookingUrl(mod.ModuleID, s.EventPkgObjid || "0"), sections: [] });
    for (const r of rowsOut) {
      pkgs.get(pk).sections.push({ sectionCode: r.code, type: r.type, days: r.days24, start: r.start24, end: r.end ? t24(r.end.replace(/([ap])$/, " $1m").toUpperCase()) : null,
        building: r.building, room: r.room, instructor: instr, seatsAvail: seatsA, seatsLimit: seatsL });
    }
    stats.sections++;
  }
  const sec = [];
  for (const [, g] of [...groups.entries()].sort((a, b) => a[1].order - b[1].order)) {
    g.rows.sort((a, b) => a.code.localeCompare(b.code) || (a.start24 || "").localeCompare(b.start24 || ""));
    for (const r of g.rows) {
      const showSeats = !(r.isLE && g.hasNonLE);            // WebReg showed seats on the enrollable section, not the lecture
      sec.push([r.code, r.type, r.days, r.start, r.end, r.building, r.room, r.instr, showSeats ? r.seatsA : null, showSeats ? r.seatsL : null, 0]);
    }
    for (const f of g.finals.values()) {
      sec.push([f.date, "FI", f.date, t12(t24(f.start) + ":00"), t12(t24(f.end) + ":00"), f.building === "RCLAS" ? "" : resolveBuilding(f.building), f.room, "", null, null, 0]);
      stats.fiRows++;
    }
  }
  courses[key] = { t: mod.CourseTitle || mod.Description || "", u: mod.CreditsDisplay || "", sub, num, sec };
  stats.courses++;
  const pkgList = [...pkgs.values()];
  legacy.push({ course: mod.CourseAbbr, moduleId: mod.ModuleID, title: courses[key].t, units: courses[key].u,
    bookingUrl: pkgList.length ? pkgList[0].bookingUrl : null, packages: pkgList });
}

const schedule = {
  term: code, termName, generated: new Date().toISOString().slice(0, 10),
  source: `TSS Schedule of Classes scrape (${path.basename(src)}, ${(soc.scrapedAt || "").slice(0, 10)})`,
  secCols: old.secCols, buildings: old.buildings, courses,
};

// ---------------------------------------------------------------- data.json
const titleIdx = new Map(data.titles.map((t, i) => [t, i]));
const titleOf = (t) => { if (!t) return -1; if (!titleIdx.has(t)) { titleIdx.set(t, data.titles.length); data.titles.push(t); } return titleIdx.get(t); };
const before = { rows: data.recs.length, off: data.recs.filter((r) => r[C.off]).length, cur: data.recs.filter((r) => r[C.cur] === 1).length,
  src2: data.recs.filter((r) => r[C.src] === 2).length, src3: data.recs.filter((r) => r[C.src] === 3).length, fa: Object.keys(data.fa || {}).length, seats: Object.keys(data.seats || {}).length };
// src=4 is "in the catalog, not offered this term" — the page renders it as "Not offered"
// regardless of flags — so a catalog-only course that IS offered now loses that row and
// gets a real one below (src=3 here, or src=2 per instructor from merge-schedule).
let dropped4 = 0;
let recs = data.recs.filter((r) => {
  if (r[C.src] === 2 || r[C.src] === 3) return false;
  if (r[C.src] === 4 && courses[ck(r[C.s], r[C.c])]) { dropped4++; return false; }
  return true;
});
let offOn = 0, offOff = 0;
for (const r of recs) {
  const was = r[C.off] ? 1 : 0, now = courses[ck(r[C.s], r[C.c])] ? 1 : 0;
  if (now && !was) offOn++; if (was && !now) offOff++;
  r[C.off] = now; r[C.cur] = 0;
}
const byCourse = new Map();
for (const r of recs) { const k = ck(r[C.s], r[C.c]); if (!byCourse.has(k)) byCourse.set(k, []); byCourse.get(k).push(r); }
// RMP-backfill rows (src=1) were shipped untitled; the schedule knows the title now.
let titled1 = 0;
for (const r of recs) {
  if (r[C.t] >= 0) continue;
  const c = courses[ck(r[C.s], r[C.c])];
  if (c && c.t) { r[C.t] = titleOf(c.t); titled1++; }
}
// A course that was offered last term on src=2/3 rows alone has no row left once those
// go. It is still a catalog course, so keep it searchable as src=4 ("catalog") — the same
// treatment the original build gave every un-offered catalog course.
let kept4 = 0;
for (const [key, oc] of Object.entries(old.courses)) {
  if (courses[key] || byCourse.has(key)) continue;
  const row = new Array(data.cols.length).fill(null);
  row[C.s] = oc.sub; row[C.c] = oc.num; row[C.t] = titleOf(oc.t); row[C.i] = "";
  row[C.n] = 0; row[C.off] = 0; row[C.lv] = parseInt(oc.num, 10); row[C.src] = 4; row[C.cur] = 0;
  recs.push(row); byCourse.set(key, [row]); kept4++;
}
const fa = {}, added = { tba: 0, umbrella: 0 };
for (const [key, c] of Object.entries(courses)) {
  const instructors = [...new Set(c.sec.filter((x) => x[1] !== "FI" && x[7]).map((x) => x[7]))];
  const umbrella = UMBRELLA.test(key);
  if (umbrella && instructors.length) fa[key] = instructors;       // merge-schedule / sync-current skip umbrellas
  if (byCourse.has(key)) continue;
  if (!umbrella && instructors.length) continue;                   // merge-schedule adds src=2 rows for these
  const row = new Array(data.cols.length).fill(null);
  row[C.s] = c.sub; row[C.c] = c.num; row[C.t] = titleOf(c.t); row[C.i] = "";
  row[C.n] = 0; row[C.off] = 1; row[C.lv] = parseInt(c.num, 10); row[C.src] = 3; row[C.cur] = 0;
  recs.push(row); byCourse.set(key, [row]);
  if (umbrella) added.umbrella++; else added.tba++;
}
data.recs = recs; data.fa = fa; data.newProf = []; data.seats = {};
// catalogCourses was the FA26 build's "course codes in the catalog" and the page prefers it
// for the "(N course codes)" figure — it is this term's schedule count now.
for (const k of Object.keys(data.meta || {})) if (/^fa\d\d|^catalogSource$|^schedCodes$|^catalogCourses$/.test(k)) delete data.meta[k];
data.meta = Object.assign(data.meta || {}, { term: code, termName, schedCodes: stats.courses, termSource: schedule.source,
  termSwitched: new Date().toISOString().slice(0, 10) });
const offeredNoRow = Object.keys(courses).filter((k) => !byCourse.has(k)).length;

// ---------------------------------------------------------------- index.html
let html = fs.readFileSync(P("index.html"), "utf8");
const hasTerm = new RegExp(`^\\s*${code}:\\{code:'${code}'`, "m").test(html);
const flipRe = /^const TERM_CODE='([A-Z]{2}\d{2})';/m;
const curCode = (flipRe.exec(html) || [])[1];
if (!noFlip && !hasTerm) { console.error(`index.html's TERMS table has no ${code} entry — add its dates (official academic calendar) before switching.`); process.exit(1); }

// ---------------------------------------------------------------- report
const ub = [...stats.unknownBuilding.entries()].sort((a, b) => b[1] - a[1]);
console.log(`
schedule.json  ${code} — ${stats.courses} courses (old ${old.term}: ${Object.keys(old.courses).length}), ${stats.sections} sections
               ${stats.meetingRows} meeting rows, ${stats.tbaRows} TBA rows (no time), ${stats.fiRows} final-exam rows, ${stats.online} online rows
               ${stats.withInstructor} sections carry an instructor; ${stats.groupWrap} sections in groups past Z (WebReg-style ASCII letters); ${stats.recoded} renumbered to avoid a same-code clash
               buildings not in the coordinates map: ${ub.length}${ub.length ? " — " + ub.slice(0, 12).map(([b, n]) => `${b} (${n})`).join(", ") : ""}
               ${stats.unparsedSched ? stats.unparsedSched + " rows timed from Sched text only (no _schedule rows); " : ""}${stats.dupKeys.length ? "duplicate course keys skipped: " + stats.dupKeys.join(", ") : ""}
data.json      rows ${before.rows} -> ${recs.length}: dropped ${before.src2} src=2 + ${before.src3} src=3 (previous term) + ${dropped4} src=4 now offered; added ${added.tba} TBA + ${added.umbrella} umbrella src=3 rows, ${kept4} src=4 catalog rows for courses no longer offered; ${titled1} RMP rows titled
               off: ${before.off} -> ${recs.filter((r) => r[C.off]).length} (+${offOn} newly offered, -${offOff} no longer offered)
               cur ${before.cur} -> 0, fa ${before.fa} -> ${Object.keys(fa).length} (umbrella advisor lists only), seats ${before.seats} -> 0, newProf -> 0
               offered courses with no row yet: ${offeredNoRow} (merge-schedule will add their src=2 rows)
index.html     TERM_CODE ${curCode} -> ${code}${noFlip ? " (skipped: --no-flip)" : hasTerm ? "" : "  !! missing from TERMS"}
`);
if (dry) { console.log("Nothing written (dry run)."); process.exit(0); }

fs.writeFileSync(P("schedule.json"), JSON.stringify(schedule));
fs.writeFileSync(P("data.json"), JSON.stringify(data));
const exportName = `ucsd-seats-${year}-${period}.json`;
fs.writeFileSync(P(exportName), JSON.stringify({ status: "ok", term: { year: +year, period: +period, label: code },
  generated: new Date().toISOString(), source: schedule.source, courses: legacy }));
if (!noFlip && curCode !== code) fs.writeFileSync(P("index.html"), html.replace(flipRe, `const TERM_CODE='${code}';`));
console.log(`wrote schedule.json, data.json, ${exportName}${!noFlip && curCode !== code ? ", index.html" : ""}.
next: node merge-schedule.js ${exportName} && node merge-seats.js ${exportName} && node align-packages.js && node sync-current.js ${exportName} && node healthcheck.js && node build.js`);
