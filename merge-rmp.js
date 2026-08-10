#!/usr/bin/env node
// Fill in RateMyProfessors ratings for recs rows that don't have any yet.
//
//   node merge-rmp.js ../rmp-professors-1079-complete-4009-2026-07-23.json --dry-run
//   node merge-rmp.js ../rmp-professors-1079-complete-4009-2026-07-23.json
//   node healthcheck.js && node build.js
//
// Rows created from the schedule or from SET evaluations carry an instructor
// but no rating — merge-schedule.js and merge-set.js only knew about the
// course. Michael Holst teaches MATH 20D and has 10 RMP ratings, and his row
// still read "no RMP match". This backfills those, and the older grade rows
// the original pipeline's name matching missed.
//
// Matching is deliberately strict, because the failure mode is silently
// attributing someone else's ratings. A surname match alone is not enough:
// "Romero, Sally Ann Dominick" and "Anthony Romero" share a surname and a
// first initial and are different people. So a candidate must also share a
// given name — the same token, or a 4+ character prefix of one ("Erin
// Truesdell Hill" / "Hill, Erin Truesdell"). Anything with more than one
// surviving candidate is left alone rather than guessed at.
//
// Skips rows that already have a rating, so re-running is a no-op. Zero deps.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data.json");
const MIN_PREFIX = 4;

const deacc = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const alnum = (s) => deacc(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// "Hill, Erin Truesdell" and "Erin Truesdell Hill" -> same surname + tokens.
function splitName(name) {
  const n = deacc(name).replace(/\s+/g, " ").trim();
  if (!n) return null;
  if (n.includes(",")) {
    const i = n.indexOf(",");
    return { surname: alnum(n.slice(0, i)), given: n.slice(i + 1).trim().split(" ").map(alnum).filter(Boolean) };
  }
  const parts = n.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return { surname: alnum(parts[parts.length - 1]), given: parts.slice(0, -1).map(alnum).filter(Boolean) };
}

function givenNamesAgree(a, b) {
  for (const x of a) {
    for (const y of b) {
      if (x === y && x.length >= 2) return true;
      const shorter = x.length <= y.length ? x : y;
      const longer = shorter === x ? y : x;
      if (shorter.length >= MIN_PREFIX && longer.startsWith(shorter)) return true;
    }
  }
  return false;
}

function main() {
  const src = process.argv[2];
  const dry = process.argv.includes("--dry-run");
  if (!src) {
    console.error("usage: node merge-rmp.js <rmp-professors-*.json> [--dry-run]");
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const raw = JSON.parse(fs.readFileSync(src, "utf8"));
  const profs = Array.isArray(raw) ? raw : (raw.professors || raw.data || []);
  const C = {};
  data.cols.forEach((c, i) => (C[c] = i));

  const bySurname = new Map();
  for (const p of profs) {
    const parsed = splitName(p.name);
    if (!parsed || !parsed.surname) continue;
    if (!bySurname.has(parsed.surname)) bySurname.set(parsed.surname, []);
    bySurname.get(parsed.surname).push({ ...p, parsed });
  }

  const stats = { filled: 0, ambiguous: 0, noCandidate: 0, alreadyRated: 0, noInstructor: 0, mergedDuplicate: 0 };
  const bySrc = {};
  const samples = [], ambiguousSamples = [];

  for (const r of data.recs) {
    if (!r[C.i]) { stats.noInstructor++; continue; }
    if (r[C.rid] != null) { stats.alreadyRated++; continue; }
    const parsed = splitName(r[C.i]);
    if (!parsed) { stats.noCandidate++; continue; }
    const hits = (bySurname.get(parsed.surname) || [])
      .filter((p) => givenNamesAgree(parsed.given, p.parsed.given));
    if (!hits.length) { stats.noCandidate++; continue; }
    // Several candidates are usually one professor with duplicate RMP profiles
    // ("Michael Davidson" twice, "David Danks" / "David  Danks"). When every
    // candidate spells out the same full name, take the profile carrying the
    // ratings. When they don't — "Sebastian Pardo Guerra" vs "Juan Pardo
    // Guerra" — they're different people and nothing is safe to pick.
    const ids = new Set(hits.map((p) => String(p.legacyId)));
    const fullNames = new Set(hits.map((p) => alnum(p.name)));
    if (ids.size > 1 && fullNames.size === 1) {
      hits.sort((a, b) => (b.numRatings || 0) - (a.numRatings || 0));
      ids.clear();
      ids.add(String(hits[0].legacyId));
      stats.mergedDuplicate++;
    }
    if (ids.size > 1) {
      stats.ambiguous++;
      if (ambiguousSamples.length < 8) {
        ambiguousSamples.push(`${r[C.s]} ${r[C.c]} · ${r[C.i]} -> ${hits.map((p) => p.name).join(" / ")}`);
      }
      continue;
    }
    const p = hits[0];
    if (!dry) {
      r[C.rq] = p.quality ?? null;
      r[C.rd] = p.difficulty ?? null;
      r[C.rw] = p.wouldTakeAgainPercent == null ? null : Math.round(p.wouldTakeAgainPercent);
      r[C.rn] = p.numRatings ?? null;
      r[C.rid] = p.legacyId ?? null;
    }
    stats.filled++;
    bySrc[r[C.src]] = (bySrc[r[C.src]] || 0) + 1;
    if (samples.length < 8) samples.push(`${r[C.s]} ${r[C.c]} · ${r[C.i]} -> ${p.name} (${p.quality}, ${p.numRatings} ratings)`);
  }

  if (!dry) fs.writeFileSync(DATA, JSON.stringify(data));

  const rated = data.recs.filter((r) => r[C.rid] != null).length;
  console.log(`${dry ? "[dry run] would fill" : "filled"} ${stats.filled} row(s) with RMP ratings`);
  console.log(`  by src: ${JSON.stringify(bySrc)}   (0=grades 2=new-instructor 5=SET)`);
  console.log(`  resolved duplicate RMP profiles      : ${stats.mergedDuplicate}`);
  console.log(`  left alone — more than one candidate : ${stats.ambiguous}`);
  console.log(`  left alone — no candidate            : ${stats.noCandidate}`);
  console.log(`  already rated                        : ${stats.alreadyRated}`);
  console.log(`  rows with an RMP rating: ${rated} / ${data.recs.length}`);
  if (samples.length) { console.log("\n  e.g."); for (const s of samples) console.log("    " + s); }
  if (ambiguousSamples.length) {
    console.log("\n  ambiguous (needs a human, not filled):");
    for (const s of ambiguousSamples) console.log("    " + s);
  }
  console.log(dry ? "\nNothing written. Re-run without --dry-run to apply." : "\nNext: node healthcheck.js && node build.js");
}

main();
