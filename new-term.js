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
const src = argv.find((a, i) => !a.startsWith("--") && (i === 0 || argv[i - 1] !== "--root"));
const dry = argv.includes("--dry-run");
const noFlip = argv.includes("--no-flip");
const rootArg = argv.indexOf("--root");
const ROOT = rootArg >= 0 ? path.resolve(argv[rootArg + 1]) : __dirname;
if (!src) {
  console.error("usage: node new-term.js <scrape.json> [more scrapes…] [--dry-run] [--no-flip] [--root DIR]\n  a scrape is the TSS Schedule-of-Classes dump (modules[]) or a ucsd-seat-sync v2 export (courses[]);\n  later files only fill courses the earlier ones have no sections for");
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

// ---------------------------------------------------------------- load + normalise
// Two scrape formats are accepted, and several files may be given: a course comes from the
// first file that has sections for it (so a complete Schedule-of-Classes dump can be backed
// by a seat-sync export, or vice versa). Both are normalised to
//   { abbr, moduleId, title, units, sections: [{ id, abbr, type, instr, pkg, seatsA, seatsL,
//     meetings: [{days:Set, start24, end24, building, room}], finals: [{date, start24, end24, building, room}] }] }
function fromSoc(soc) {                                    // raw SAP module dump: modules[] with _sections/_schedule
  const out = new Map();
  for (const mod of soc.modules || []) {
    const slots = new Map();                                 // EventObjid -> Map("16:00|16:50" -> Set(days))
    for (const r of mod._schedule || []) {
      if (!slots.has(r.SectionId)) slots.set(r.SectionId, new Map());
      const k = to24FromHms(r.BeginTime) + "|" + to24FromHms(r.EndTime);
      const by = slots.get(r.SectionId);
      if (!by.has(k)) by.set(k, new Set());
      if (DOW[r.DoW]) by.get(k).add(DOW[r.DoW]);
    }
    const sections = [], seen = new Set();
    for (const s of mod._sections || []) {
      if (seen.has(s.EventObjid)) continue;
      seen.add(s.EventObjid);
      const { meets, finals } = parseSched(s.Sched);
      const meetings = [];
      const by = slots.get(s.EventObjid);
      if (by && by.size) {
        for (const [k, days] of by) {
          const [start24, end24] = k.split("|");
          const meet = meets.find((x) => t24(x.start) === start24 && t24(x.end) === end24) || meets.find((x) => t24(x.start) === start24) || meets[0] || {};
          meetings.push({ days, start24, end24, building: meet.building || "", room: meet.room || "" });
        }
      } else {
        for (const x of meets) { meetings.push({ days: new Set(x.days), start24: t24(x.start), end24: t24(x.end), building: x.building, room: x.room }); stats.unparsedSched++; }
      }
      const num = (v) => (v === "" || v == null || !Number.isFinite(+v) ? null : +v);
      sections.push({ id: s.EventObjid, abbr: s.EventAbbr, type: s.TeachingMethod, instr: (s.InstructorName || "").trim(),
        pkg: s.EventPkgObjid || "", seatsA: num(s.EventPkgSeatsAvailable), seatsL: num(s.EventPkgLimit), meetings,
        finals: finals.map((f) => ({ date: f.date, start24: t24(f.start), end24: t24(f.end), building: f.building, room: f.room })) });
    }
    out.set(mod.CourseAbbr, { abbr: mod.CourseAbbr, moduleId: String(mod.ModuleID), title: mod.CourseTitle || mod.Description || "",
      units: mod.CreditsDisplay || "", sections });
  }
  return out;
}
function fromSeatsV2(x) {                                  // ucsd-seat-sync v2: courses[] -> packages[] -> sections[]
  const out = new Map();
  for (const c of x.courses || []) {
    const byId = new Map();
    const mid = ((c.bookingUrl || "").match(/\/SM\/(\d+)\//) || [])[1] || "";
    for (const p of c.packages || []) {
      for (const s of p.sections || []) {
        const e = byId.get(s.sectionId) || { id: s.sectionId, abbr: s.sectionCode, type: s.type, instr: (s.instructor || "").trim(),
          pkg: String(p.eventPackageId || s.eventPackageId || ""), seatsA: s.openSeats == null ? null : +s.openSeats, seatsL: s.capacity == null ? null : +s.capacity,
          meetings: [], finals: [], _slots: new Set() };
        const dayList = String(s.days || "").match(/Tu|Th|Sa|Su|M|W|F/g) || [];
        if (s.start && s.end && dayList.length) {
          const k = `${s.days}|${s.start}|${s.end}`;
          if (!e._slots.has(k)) { e._slots.add(k); e.meetings.push({ days: new Set(dayList), start24: s.start, end24: s.end, building: /online/i.test(s.mode || "") && !s.building ? "RCLAS" : (s.building || ""), room: s.room || "" }); }
        }
        if (s.final && s.final.date && !e.finals.some((f) => f.date === s.final.date && f.start24 === s.final.start)) e.finals.push({ date: s.final.date, start24: s.final.start, end24: s.final.end, building: s.building || "", room: s.room || "" });
        byId.set(s.sectionId, e);
      }
    }
    for (const e of byId.values()) delete e._slots;
    out.set(c.course, { abbr: c.course, moduleId: mid, title: c.title || "", units: c.credits == null ? "" : Number(c.credits).toFixed(2), sections: [...byId.values()] });
  }
  return out;
}

const inputs = argv.filter((a, i) => !a.startsWith("--") && !(rootArg >= 0 && i === rootArg + 1));
const stats = { courses: 0, sections: 0, meetingRows: 0, tbaRows: 0, fiRows: 0, online: 0, withInstructor: 0,
  unknownBuilding: new Map(), unparsedSched: 0, dupKeys: [], skippedNoAbbr: 0, groupWrap: 0, recoded: 0, filled: 0 };
let year = "", period = "", code = null, termName = "", scrapedAt = "";
const norm = new Map();
for (const file of inputs) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  let m, fmt;
  if (Array.isArray(j.modules)) {
    m = fromSoc(j); fmt = "SOC dump";
    const sample = j.modules.find((x) => x.Persl) || {};
    const pm = /^(\d{2})(FA|WI|SP|SU|S1|S2)$/.exec(sample.Persl || "");
    if (!code && pm) { year = String((j.term || sample).AcademicYear || ""); period = String((j.term || sample).AcademicPeriod || "");
      code = pm[2] + pm[1]; termName = `${(sample.AcademicPeriod_Text || "").replace(/\s*Quarter$/i, "")} ${2000 + +pm[1]}`.trim(); scrapedAt = j.scrapedAt || ""; }
  } else if (Array.isArray(j.courses)) {
    m = fromSeatsV2(j); fmt = "seat-sync v2";
    const ap = j.academicPeriod || {};
    if (!code && ap.peryr && ap.perid) { year = String(ap.peryr); period = String(ap.perid);
      const q = { 1: "SU", 2: "FA", 3: "WI", 4: "SP" }[+ap.perid] || "T" + ap.perid, y = +ap.peryr + (+ap.perid >= 3 ? 1 : 0);
      code = q + String(y).slice(2); termName = `${(ap.term || "").replace(/\s*Quarter$/i, "")} ${y}`.trim(); scrapedAt = j.generatedAt || ""; }
  } else { console.error(`${file}: not a TSS scrape I recognise (expected modules[] or courses[])`); process.exit(1); }
  let added = 0, filled = 0;
  for (const [abbr, c] of m) {
    const have = norm.get(abbr);
    if (!have) { norm.set(abbr, c); added++; }
    else if (!have.sections.length && c.sections.length) { norm.set(abbr, c); filled++; }
  }
  stats.filled += filled;
  console.log(`${path.basename(file)}: ${fmt}, ${m.size} courses — ${added} new${filled ? `, ${filled} filled in (empty in an earlier file)` : ""}`);
}
if (!year || !period || !code) { console.error("could not read the term from the scrape(s)"); process.exit(1); }
console.log(`term ${year}/${period} = ${code} (${termName}), ${norm.size} courses, scraped ${scrapedAt || "?"}`);

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
const bookingUrl = (moduleId, pkgObjid) =>
  `https://tss.ucsd.edu/fiori#ZUSModule-display?TileType=MYMOD&/Detail/EventPackage/SM/${moduleId}/00000000/0/0/0/00000000-0000-0000-0000-000000000000/${pkgObjid}/${year}/${period}/?`;

for (const nc of norm.values()) {
  const key = keyOf(nc.abbr);
  if (!key) { stats.skippedNoAbbr++; continue; }
  if (courses[key]) { stats.dupKeys.push(key); continue; }
  const [sub, num] = key.split(" ");
  const groups = new Map();                                 // letter -> {rows:[], finals:Map, hasNonLE, order}
  const pkgs = new Map();                                   // pkg id -> {id, bookingUrl, sections:[]}
  const usedCodes = new Set();
  for (const s of nc.sections) {
    let [codeStr, letter] = groupCode(s.abbr);
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
    if (s.type !== "LE") g.hasNonLE = true;
    if (s.instr) stats.withInstructor++;
    const rowsOut = [];
    if (s.meetings.length) {
      for (const m of s.meetings) {
        const building = resolveBuilding(m.building);
        if (building === "RCLAS") stats.online++;
        rowsOut.push({ code: codeStr, type: s.type, days: daysStr(m.days), start: t12(m.start24 + ":00"), end: t12(m.end24 + ":00"),
          building, room: m.room || "", start24: m.start24, end24: m.end24, days24: daysStr(m.days) });
        stats.meetingRows++;
      }
    } else {
      rowsOut.push({ code: codeStr, type: s.type, days: "", start: "", end: "", building: "", room: "", start24: null, end24: null, days24: "" });
      stats.tbaRows++;
    }
    for (const r of rowsOut) {
      if (r.building && r.building !== "RCLAS" && !old.buildings[r.building]) stats.unknownBuilding.set(r.building, (stats.unknownBuilding.get(r.building) || 0) + 1);
      g.rows.push({ ...r, instr: s.instr, seatsA: s.seatsA, seatsL: s.seatsL, isLE: s.type === "LE" });
    }
    for (const f of s.finals) {
      const fk = `${f.date}|${f.start24}|${f.end24}`;
      if (!g.finals.has(fk)) g.finals.set(fk, f);
    }
    const pk = s.pkg || codeStr;
    if (!pkgs.has(pk)) pkgs.set(pk, { id: String(pk), bookingUrl: bookingUrl(nc.moduleId || "0", s.pkg || "0"), sections: [] });
    for (const r of rowsOut) {
      pkgs.get(pk).sections.push({ sectionCode: r.code, type: r.type, days: r.days24, start: r.start24, end: r.end24,
        building: r.building, room: r.room, instructor: s.instr, seatsAvail: s.seatsA, seatsLimit: s.seatsL });
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
      const fb = f.building === "RCLAS" ? "" : resolveBuilding(f.building);
      sec.push([f.date, "FI", f.date, t12(f.start24 + ":00"), t12(f.end24 + ":00"), fb, f.room || "", "", null, null, 0]);
      stats.fiRows++;
    }
  }
  courses[key] = { t: nc.title, u: nc.units, sub, num, sec };
  stats.courses++;
  const pkgList = [...pkgs.values()];
  legacy.push({ course: nc.abbr, moduleId: nc.moduleId, title: nc.title, units: nc.units,
    bookingUrl: pkgList.length ? pkgList[0].bookingUrl : null, packages: pkgList });
}

const schedule = {
  term: code, termName, generated: new Date().toISOString().slice(0, 10),
  source: `TSS Schedule of Classes scrape (${inputs.map((f) => path.basename(f)).join(" + ")}, ${scrapedAt.slice(0, 10)})`,
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
const flipRe = /^const TERM_DEFAULT='([A-Z]{2}\d{2})';/m;
const filesRe = /^const TERM_FILES=\{.*\};$/m;
const curCode = (flipRe.exec(html) || [])[1];
if (!filesRe.test(html) || !curCode) { console.error("index.html needs the TERM_DEFAULT and TERM_FILES lines (quarter picker)"); process.exit(1); }
if (!noFlip && !hasTerm) { console.error(`index.html's TERMS table has no ${code} entry — add its dates (official academic calendar) before switching.`); process.exit(1); }

// ---------------------------------------------------------------- report
const ub = [...stats.unknownBuilding.entries()].sort((a, b) => b[1] - a[1]);
console.log(`
schedule.json  ${code} — ${stats.courses} courses (old ${old.term}: ${Object.keys(old.courses).length}), ${stats.sections} sections${stats.filled ? `, ${stats.filled} courses filled from a later file` : ""}
               ${stats.meetingRows} meeting rows, ${stats.tbaRows} TBA rows (no time), ${stats.fiRows} final-exam rows, ${stats.online} online rows
               ${stats.withInstructor} sections carry an instructor; ${stats.groupWrap} sections in groups past Z (WebReg-style ASCII letters); ${stats.recoded} renumbered to avoid a same-code clash
               buildings not in the coordinates map: ${ub.length}${ub.length ? " — " + ub.slice(0, 12).map(([b, n]) => `${b} (${n})`).join(", ") : ""}
               ${stats.unparsedSched ? stats.unparsedSched + " rows timed from Sched text only (no _schedule rows); " : ""}${stats.dupKeys.length ? "duplicate course keys skipped: " + stats.dupKeys.join(", ") : ""}
               empty courses (no sections in any file): ${Object.values(courses).filter((c) => !c.sec.length).length}
data.json      rows ${before.rows} -> ${recs.length}: dropped ${before.src2} src=2 + ${before.src3} src=3 (previous term) + ${dropped4} src=4 now offered; added ${added.tba} TBA + ${added.umbrella} umbrella src=3 rows, ${kept4} src=4 catalog rows for courses no longer offered; ${titled1} RMP rows titled
               off: ${before.off} -> ${recs.filter((r) => r[C.off]).length} (+${offOn} newly offered, -${offOff} no longer offered)
               cur ${before.cur} -> 0, fa ${before.fa} -> ${Object.keys(fa).length} (umbrella advisor lists only), seats ${before.seats} -> 0, newProf -> 0
               offered courses with no row yet: ${offeredNoRow} (merge-schedule will add their src=2 rows)
index.html     TERM_DEFAULT ${curCode} -> ${code}${noFlip ? " (skipped: --no-flip)" : hasTerm ? "" : "  !! missing from TERMS"}; ${old.term} archived as data.${old.term}.json / schedule.${old.term}.json for the quarter picker
`);
if (dry) { console.log("Nothing written (dry run)."); process.exit(0); }

// Archive the quarter being replaced so the page's quarter picker can still show it
// (build.js hashes data.<CODE>.json / schedule.<CODE>.json automatically). Never overwrite
// an archive that already exists — a re-run must not clobber it with half-switched data.
if (old.term && old.term !== code) {
  for (const f of ["data", "schedule"]) {
    const dst = P(`${f}.${old.term}.json`);
    if (!fs.existsSync(dst)) fs.copyFileSync(P(`${f}.json`), dst);
  }
}
fs.writeFileSync(P("schedule.json"), JSON.stringify(schedule));
fs.writeFileSync(P("data.json"), JSON.stringify(data));
// TERM_FILES: the live pair plus every archived quarter on disk.
const archived = fs.readdirSync(ROOT).map((f) => (/^data\.([A-Z]{2}\d{2})\.json$/.exec(f) || [])[1]).filter((t) => t && t !== code && fs.existsSync(P(`schedule.${t}.json`)));
const filesLine = "const TERM_FILES={" + [code, ...archived].map((t) => `${t}:{data:'${t === code ? "data.json" : `data.${t}.json`}',schedule:'${t === code ? "schedule.json" : `schedule.${t}.json`}'}`).join(",") + "};";
html = html.replace(filesRe, filesLine);
if (!noFlip) html = html.replace(flipRe, `const TERM_DEFAULT='${code}';`);
fs.writeFileSync(P("index.html"), html);
const exportName = `ucsd-seats-${year}-${period}.json`;
fs.writeFileSync(P(exportName), JSON.stringify({ status: "ok", term: { year: +year, period: +period, label: code },
  generated: new Date().toISOString(), source: schedule.source, courses: legacy }));
console.log(`wrote schedule.json, data.json, index.html, ${exportName}${old.term && old.term !== code ? `, data.${old.term}.json, schedule.${old.term}.json` : ""}.
next: node merge-schedule.js ${exportName} && node merge-seats.js ${exportName} && node align-packages.js && node sync-current.js ${exportName} && node healthcheck.js && node build.js`);
