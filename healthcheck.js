#!/usr/bin/env node
// Read-only consistency audit for data.json × schedule.json.
//
//   node healthcheck.js               # human report, exit 0
//   node healthcheck.js --strict      # exit 1 if any ERROR (CI gate)
//   node healthcheck.js --pedantic    # exit 1 if any ERROR or WARN
//   node healthcheck.js --json        # machine-readable findings
//   node healthcheck.js --all         # don't truncate the per-finding lists
//
// WHY THIS EXISTS. Every dataset in data.json is joined on one course key
//   CK(subj,num) = SUBJ.toUpperCase() + " " + NUM.toUpperCase().replace(/[^0-9A-Z]/g,"")
// (identical to index.html), plus instructor-name matching. All the merge-*.js
// scripts are SUPERSET UNIONS — they only add, never delete — so when UCSD
// churns its catalog (courses added / retired / renumbered each term) two things
// silently rot: ORPHAN entries (maps still point at a course/instructor that no
// longer exists) and COVERAGE GAPS (a new offered course never got joined). This
// script is the accountant that finds both. It NEVER edits anything — it only
// reports, so a human decides what to prune.
//
// Robustness contract: zero dependencies (Node built-ins only); tolerant of
// missing files, missing maps and malformed rows (counted, never thrown on);
// every course source is normalised through the exact app CK so a key that would
// fail an in-app lookup is caught here first. Findings are graded ERROR (breaks a
// lookup / structural), WARN (drift, bloat, missing coverage) or INFO (fuzzy —
// worth a human glance, e.g. a probable renumber or a stale namesake block).
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const ARGS = new Set(process.argv.slice(2));
const OPT = {
  json: ARGS.has("--json"),
  strict: ARGS.has("--strict"),
  pedantic: ARGS.has("--pedantic"),
  all: ARGS.has("--all") || ARGS.has("--verbose"),
};
const CAP = OPT.all ? Infinity : 20; // per-finding sample cap in human mode

// ---- the one true key (must mirror index.html) --------------------------
const CK = (s, c) =>
  String(s).toUpperCase() + " " + String(c).toUpperCase().replace(/[^0-9A-Z]/g, "");

// Split a "SUBJ NUM" map key on its FIRST space and re-normalise, so we can tell
// whether a stored key is already in the canonical shape the app looks up by.
function canonicalOf(key) {
  const s = String(key);
  const i = s.indexOf(" ");
  if (i < 0) return null; // no space at all → not canonical
  return CK(s.slice(0, i), s.slice(i + 1));
}
function isCanonical(key) {
  return canonicalOf(key) === String(key);
}

// Loose instructor-name normaliser for the fuzzy (INFO) checks only.
function normName(n) {
  return String(n)
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normTitle(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ---- load (defensive) ---------------------------------------------------
function loadJSON(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return { ok: false, missing: true, data: null };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) {
    return { ok: false, error: e.message, data: null };
  }
}

const findings = [];
function add(sev, code, msg, items) {
  findings.push({ sev, code, msg, items: items || [] });
}

const dataRes = loadJSON("data.json");
if (!dataRes.ok) {
  console.error("healthcheck: cannot read data.json — " + (dataRes.error || "file missing"));
  process.exit(2);
}
const d = dataRes.data;
const schedRes = loadJSON("schedule.json");
const sched = schedRes.ok ? schedRes.data : null;
if (!sched) {
  add("WARN", "no-schedule",
    "schedule.json not readable — current-term checks (coverage, offered/cur drift, orphan fa) are skipped.",
    schedRes.missing ? ["file missing"] : [schedRes.error]);
}

// ---- normalise every course source into canonical keys ------------------
const cols = Array.isArray(d.cols) ? d.cols : [];
const C = {}; cols.forEach((c, i) => (C[c] = i));
const recs = Array.isArray(d.recs) ? d.recs : [];
const titles = Array.isArray(d.titles) ? d.titles : [];

const fa = (d.fa && typeof d.fa === "object") ? d.fa : {};
const set = (d.set && typeof d.set === "object") ? d.set : {};
const seats = (d.seats && typeof d.seats === "object") ? d.seats : {};
const pre = (d.pre && typeof d.pre === "object") ? d.pre : {};
const alias = (d.alias && typeof d.alias === "object") ? d.alias : {};
const aka = (d.aka && typeof d.aka === "object") ? d.aka : {};
const rmpAka = (d.rmpAka && typeof d.rmpAka === "object") ? d.rmpAka : {};
const block = Array.isArray(d.block) ? d.block : [];
const newProf = Array.isArray(d.newProf) ? d.newProf : [];

// recs universe + instructor / rid / title-stub bookkeeping
const recsKeys = new Set();            // canonical course keys seen in recs
const recsInstr = new Set();           // instructor display strings in recs
const recsRid = new Set();             // rmp ids referenced by recs
const recsRowsByKey = new Map();       // key -> [rowIndex,...]
let malformedRecs = 0;
const badTitleIdx = [];
recs.forEach((r, ri) => {
  if (!Array.isArray(r) || r.length < cols.length) { malformedRecs++; return; }
  const key = CK(r[C.s], r[C.c]);
  recsKeys.add(key);
  (recsRowsByKey.get(key) || recsRowsByKey.set(key, []).get(key)).push(ri);
  if (r[C.i] != null && r[C.i] !== "") recsInstr.add(String(r[C.i]));
  if (r[C.rid] != null && r[C.rid] !== "") recsRid.add(String(r[C.rid]));
  // titles[i], with -1 as the app's official "no title" sentinel
  // (index.html renders `r[C.t]>=0 ? T[r[C.t]] : ''`), so -1 is legal.
  const ti = r[C.t];
  if (!(Number.isInteger(ti) && ti >= -1 && ti < titles.length)) badTitleIdx.push(ri);
});

// schedule (current term) universe
const schedKeys = new Set();
const schedTitle = new Map();          // key -> full title from schedule
const schedInstrByKey = new Map();     // key -> Set(instructor display names)
let SC = {};
if (sched) {
  const sc = Array.isArray(sched.secCols) ? sched.secCols : [];
  sc.forEach((c, i) => (SC[c] = i));
  const courses = sched.courses;
  const iter = Array.isArray(courses)
    ? courses.map((c) => [null, c])
    : (courses && typeof courses === "object" ? Object.entries(courses) : []);
  for (const [k, c] of iter) {
    if (!c || typeof c !== "object") continue;
    const key = (c.sub != null && c.num != null) ? CK(c.sub, c.num)
      : (k != null ? (canonicalOf(k) || String(k)) : null);
    if (!key) continue;
    schedKeys.add(key);
    if (c.t) schedTitle.set(key, c.t);
    const names = new Set();
    const secs = Array.isArray(c.sec) ? c.sec : [];
    for (const s of secs) {
      if (!Array.isArray(s)) continue;
      const nm = s[SC.instructor];
      if (nm) names.add(String(nm));
    }
    if (names.size) schedInstrByKey.set(key, names);
  }
}

// pre (catalog) universe — canonicalised
const preKeys = new Set();
for (const k of Object.keys(pre)) preKeys.add(canonicalOf(k) || k);

// "known course universe" = anything we have any record of. An entry keyed to a
// course in here is legitimate; only a key absent from ALL of these is a true
// orphan (this is what keeps grad-only `set` entries from false-flagging).
const known = new Set([...recsKeys, ...schedKeys, ...preKeys]);

// fa display-name set (current-term instructors) — the anchor for instructor maps
const faNames = new Set();
for (const v of Object.values(fa)) if (Array.isArray(v)) for (const n of v) faNames.add(String(n));
const faNamesNorm = new Set([...faNames].map(normName));

// =========================================================================
// ERRORS — a stored key/shape that would break an in-app lookup, or a
// structural violation of the schema.
// =========================================================================

// E1  non-canonical map keys (would never match CK() lookups)
for (const [name, map] of [["fa", fa], ["set", set], ["seats", seats], ["pre", pre]]) {
  const bad = Object.keys(map).filter((k) => !isCanonical(k));
  if (bad.length) add("ERROR", `noncanonical-key:${name}`,
    `${bad.length} key(s) in \`${name}\` are not in canonical "SUBJ NUM" form — the app's CK() lookup can never hit them.`,
    bad.map((k) => `${k}  (expected ${canonicalOf(k) || "SUBJ NUM"})`));
}

// E2  title index out of range
if (badTitleIdx.length) add("ERROR", "title-index",
  `${badTitleIdx.length} recs row(s) have a title index outside titles[0..${titles.length - 1}] (and aren't the -1 "no title" sentinel) — those rows render the wrong title.`,
  badTitleIdx.map((ri) => `recs[${ri}] t=${recs[ri][C.t]}`));

// E3  structural: malformed rows / entries
if (malformedRecs) add("ERROR", "malformed-recs",
  `${malformedRecs} recs row(s) are not arrays of the expected width (${cols.length}).`, []);
{
  const badSet = [];
  for (const [k, arr] of Object.entries(set)) {
    if (!Array.isArray(arr)) { badSet.push(`${k} (not array)`); continue; }
    arr.forEach((e, i) => { if (!e || !e.sid || !e.u) badSet.push(`${k}[${i}] (missing sid/u)`); });
  }
  if (badSet.length) add("ERROR", "malformed-set",
    `${badSet.length} \`set\` entr(y/ies) missing sid/url — the SET deep-link won't render.`, badSet);

  const badSeats = Object.entries(seats).filter(([, v]) => !v || !v.u).map(([k]) => k);
  if (badSeats.length) add("ERROR", "malformed-seats",
    `${badSeats.length} \`seats\` entr(y/ies) missing a booking url.`, badSeats);

  const badFa = Object.entries(fa).filter(([, v]) => !Array.isArray(v) || v.length === 0).map(([k]) => k);
  if (badFa.length) add("ERROR", "malformed-fa",
    `${badFa.length} \`fa\` entr(y/ies) are not a non-empty instructor array.`, badFa);
}

// =========================================================================
// WARN — drift, bloat, and coverage gaps. None of these break a lookup, but
// each is a course-churn side-effect a superset-union merge can't self-heal.
// =========================================================================

// W1  orphan course-keyed entries (retired/renumbered course; superset merges never prune).
// A map is judged against the universe MINUS itself — `pre` feeds `known`, so
// including it would make a catalog-only key vacuously "known" and the check dead.
for (const [name, map, ownKeys] of [
  ["set", set, null], ["seats", seats, null], ["pre", pre, preKeys],
]) {
  const universe = ownKeys ? new Set([...recsKeys, ...schedKeys]) : known;
  const orphans = Object.keys(map)
    .map((k) => (isCanonical(k) ? k : canonicalOf(k) || k))
    .filter((k) => !universe.has(k));
  if (orphans.length) add("WARN", `orphan:${name}`,
    `${orphans.length} \`${name}\` key(s) reference a course absent from ` +
    (ownKeys ? "recs AND the current schedule" : "recs, schedule AND catalog") +
    ` — likely retired/renumbered; safe to prune.`,
    orphans);
}

// W2  fa comes from schedule.json OR the TSS scrape (sync-current.js covers med-school
// and late-added courses schedule.json lacks). A key backed by neither — not in the
// schedule and with no cur=1 row in recs — is a stale leftover from a previous term.
if (sched) {
  const curKeys = new Set();
  if (C.cur != null) recs.forEach((r) => { if (Array.isArray(r) && r[C.cur] === 1) curKeys.add(CK(r[C.s], r[C.c])); });
  const staleFa = Object.keys(fa).map((k) => canonicalOf(k) || k)
    .filter((k) => !schedKeys.has(k) && !curKeys.has(k));
  if (staleFa.length) add("WARN", "stale-fa",
    `${staleFa.length} \`fa\` key(s) aren't in the current schedule.json (${sched.termName || sched.term || "?"}) and have no cur=1 row backing them — stale leftovers; re-run sync-current.js with a fresh TSS scrape.`,
    staleFa);
}

// W3  coverage: offered courses with no grade-history row (new/renumbered course not joined)
if (sched) {
  const uncovered = [...schedKeys].filter((k) => !recsKeys.has(k));
  if (uncovered.length) add("WARN", "coverage-no-recs",
    `${uncovered.length} course(s) offered this term have NO recs row (no grade history joined). Genuinely-new courses are expected; a renumber of an existing course is not.`,
    uncovered.map((k) => schedTitle.has(k) ? `${k} — ${schedTitle.get(k)}` : k));
}

// W4  offered-flag drift (recs `off` vs the live schedule)
if (sched && C.off != null) {
  const offClaimedNotScheduled = [];
  const scheduledNotFlagged = [];
  for (const [key, rows] of recsRowsByKey) {
    const anyOff = rows.some((ri) => recs[ri][C.off]);
    if (anyOff && !schedKeys.has(key)) offClaimedNotScheduled.push(key);
    if (!anyOff && schedKeys.has(key)) scheduledNotFlagged.push(key);
  }
  if (offClaimedNotScheduled.length) add("WARN", "offered-drift-stale",
    `${offClaimedNotScheduled.length} course(s) are flagged offered (off=1) in recs but absent from the current schedule — stale "Offered this term".`,
    offClaimedNotScheduled);
  if (scheduledNotFlagged.length) add("WARN", "offered-drift-missing",
    `${scheduledNotFlagged.length} course(s) have grade history AND are in the schedule but no recs row is flagged off=1 — the offered-join didn't tag them.`,
    scheduledNotFlagged);
}

// W5  `cur` (teaching-now) flag drift vs fa
if (C.cur != null) {
  const curNoFa = [];
  recs.forEach((r, ri) => {
    if (!Array.isArray(r) || !r[C.cur]) return;
    const key = CK(r[C.s], r[C.c]);
    const list = fa[key];
    if (!Array.isArray(list) || !list.length) { curNoFa.push(`recs[${ri}] ${key}`); }
  });
  if (curNoFa.length) add("WARN", "cur-without-fa",
    `${curNoFa.length} recs row(s) carry cur=1 (Teaching now) but their course has no fa entry — stale current-term flag.`,
    curNoFa);
}

// W6  seats key-shape hygiene (the AAS-010R → AAS 10R translation regressing)
{
  const bad = Object.keys(seats).filter((k) => /-/.test(k) || /[a-z]/.test(k) || / 0\d/.test(k));
  if (bad.length) add("WARN", "seats-keyshape",
    `${bad.length} \`seats\` key(s) look untranslated (dash / lowercase / zero-padded number) — merge-seats.js key translation may have regressed.`,
    bad);
}

// =========================================================================
// INFO — fuzzy, human-review. Higher false-positive rate by nature; never gates.
// =========================================================================

// I1  probable renumbers: same subject + same title, one key only-in-recs
// (grade history, not offered) and one only-in-schedule (offered, no history).
if (sched) {
  const bySubjTitle = new Map(); // "SUBJ|title" -> {rec:Set, sched:Set}
  const push = (bucket, subj, title, key) => {
    if (!title) return;
    const kk = subj + "|" + normTitle(title);
    const e = bySubjTitle.get(kk) || { rec: new Set(), sched: new Set() };
    e[bucket].add(key); bySubjTitle.set(kk, e);
  };
  for (const [key, rows] of recsRowsByKey) {
    const subj = key.split(" ")[0];
    const t = titles[recs[rows[0]][C.t]];
    push("rec", subj, t, key);
  }
  for (const key of schedKeys) push("sched", key.split(" ")[0], schedTitle.get(key), key);
  const twins = [];
  for (const { rec, sched: sc } of bySubjTitle.values()) {
    const onlyRec = [...rec].filter((k) => !schedKeys.has(k) && !sc.has(k));
    const onlySched = [...sc].filter((k) => !recsKeys.has(k));
    if (onlyRec.length && onlySched.length)
      twins.push(`${onlyRec.join("/")} (history) ↔ ${onlySched.join("/")} (offered)`);
  }
  if (twins.length) add("INFO", "renumber-twins",
    `${twins.length} subject+title pair(s) split across an unoffered "history" code and an offered "no-history" code — candidate course renumbers to bridge or merge.`,
    twins);
}

// I2  stale instructor maps (anchor = fa display names of the current term)
{
  const staleAlias = Object.keys(alias).filter((k) => !faNames.has(k) && !faNamesNorm.has(normName(k)));
  if (staleAlias.length) add("INFO", "stale-alias",
    `${staleAlias.length} \`alias\` key(s) are no longer a current-term instructor (not in fa). If they've stopped teaching the alias is dead weight; review before pruning.`,
    staleAlias);

  const staleAka = Object.keys(aka).filter((k) => !faNames.has(k) && !faNamesNorm.has(normName(k)));
  if (staleAka.length) add("INFO", "stale-aka",
    `${staleAka.length} \`aka\` display name(s) aren't in the current fa set — review.`, staleAka);

  const staleBlock = block
    .filter((p) => Array.isArray(p) && p.length === 2)
    .filter((p) => !faNamesNorm.has(normName(p[0])) && !recsInstr.has(p[1]))
    .map((p) => `${p[0]} || ${p[1]}`);
  if (staleBlock.length) add("INFO", "stale-block",
    `${staleBlock.length} \`block\` namesake pair(s) reference neither a current instructor nor a recs instructor — the guarded collision may be gone.`,
    staleBlock);

  const staleRmpAka = Object.keys(rmpAka).filter((rid) => !recsRid.has(String(rid)));
  if (staleRmpAka.length) add("INFO", "stale-rmpaka",
    `${staleRmpAka.length} \`rmpAka\` rid(s) aren't referenced by any recs row — review.`,
    staleRmpAka.map((rid) => `${rid} → ${rmpAka[rid]}`));

  const staleNewProf = newProf.filter((n) => !faNames.has(n) && !faNamesNorm.has(normName(n)));
  if (staleNewProf.length) add("INFO", "stale-newprof",
    `${staleNewProf.length} \`newProf\` name(s) aren't in the current fa set — a first-timer who isn't teaching this term should roll off once they have grade history.`,
    staleNewProf);
}

// I3b  untitled rows (t=-1 is legal, but an OFFERED course with no title is a
// catalog-join gap worth filling — merge-catalog.js supplies official titles).
{
  const untitledOffered = new Set();
  recs.forEach((r) => {
    if (!Array.isArray(r) || r[C.t] !== -1) return;
    const key = CK(r[C.s], r[C.c]);
    if (!sched || schedKeys.has(key)) untitledOffered.add(key);
  });
  if (untitledOffered.size) add("INFO", "untitled-offered",
    `${untitledOffered.size} offered course(s) have rows with no title (t=-1) — re-run merge-catalog.js to supply the official title.`,
    [...untitledOffered]);
}

// I3  offered courses missing a catalog prerequisite entry (coverage, low stakes)
if (sched) {
  const noPre = [...schedKeys].filter((k) => !preKeys.has(k) && recsKeys.has(k));
  if (noPre.length) add("INFO", "missing-prereq",
    `${noPre.length} offered course(s) with grade history have no catalog \`pre\` entry — re-run merge-catalog.js against a fresh scrape to fill them.`,
    noPre);
}

// =========================================================================
// report
// =========================================================================
const order = { ERROR: 0, WARN: 1, INFO: 2 };
findings.sort((a, b) => order[a.sev] - order[b.sev] || a.code.localeCompare(b.code));
const counts = { ERROR: 0, WARN: 0, INFO: 0 };
for (const f of findings) counts[f.sev] += (f.items.length || 1);
const nErr = findings.filter((f) => f.sev === "ERROR").length;
const nWarn = findings.filter((f) => f.sev === "WARN").length;
const nInfo = findings.filter((f) => f.sev === "INFO").length;

if (OPT.json) {
  process.stdout.write(JSON.stringify({
    ok: nErr === 0,
    summary: {
      recs: recs.length, courses_in_recs: recsKeys.size,
      schedule_term: sched ? (sched.term || null) : null,
      courses_in_schedule: schedKeys.size,
      findings: { error: nErr, warn: nWarn, info: nInfo },
    },
    findings,
  }, null, 2) + "\n");
} else {
  const bar = "─".repeat(64);
  console.log(bar);
  console.log("Easy-A Radar · data health check");
  console.log(`recs: ${recs.length} rows / ${recsKeys.size} courses` +
    (sched ? `   schedule(${sched.term || "?"}): ${schedKeys.size} courses` : "   schedule: (skipped)"));
  console.log(`findings: ${nErr} ERROR · ${nWarn} WARN · ${nInfo} INFO`);
  console.log(bar);
  if (!findings.length) {
    console.log("✓ clean — no drift, orphans or coverage gaps detected.");
  }
  const icon = { ERROR: "✗", WARN: "▲", INFO: "·" };
  for (const f of findings) {
    console.log(`\n${icon[f.sev]} [${f.sev}] ${f.code}`);
    console.log(`  ${f.msg}`);
    const shown = f.items.slice(0, CAP);
    for (const it of shown) console.log(`    - ${it}`);
    if (f.items.length > shown.length)
      console.log(`    … and ${f.items.length - shown.length} more (run with --all to list)`);
  }
  console.log("");
  console.log("ERROR = breaks an in-app lookup · WARN = churn drift/orphan/coverage · INFO = review");
  console.log("Nothing was modified. Prune/re-map by hand, then re-run.");
}

// exit code
if (OPT.pedantic && (nErr || nWarn)) process.exit(1);
if (OPT.strict && nErr) process.exit(1);
process.exit(0);
