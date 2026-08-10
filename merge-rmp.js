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
// attributing someone else's ratings — "Xiao Wang" teaches Chinese and has 24
// ratings; "Xiaolong Wang" teaches CSE and has one.
//
// Both sides are normalised to "given … surname" order, and how much of the
// tail is the surname is decided by how much of it the two names share. That
// matters for compound surnames: taking only the last word makes "Juan Pablo
// Pardo Guerra" and "Sebastian Pardo Guerra" agree on "Pardo" as if it were a
// given name. Sharing that tail is necessary but not sufficient — the names
// must also share a given name outright, so those two are correctly kept
// apart while "Juan Pardo Guerra" matches.
//
// Candidates are then scored (an identical name beats a partial one, a longer
// shared surname beats a shorter one) and only a single best candidate is
// accepted; a tie is left for a human. Skips rows that already have a rating,
// so re-running is a no-op. Zero dependencies.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data.json");

const deacc = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const alnum = (s) => deacc(s).toLowerCase().replace(/[^a-z0-9]/g, "");

// "Hill, Erin Truesdell" and "Erin Truesdell Hill" both -> [erin, truesdell, hill]
function tokens(name) {
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

// How much of the two names' tails is the same surname. Compared as joined
// text, not word by word, because the same surname gets written apart or
// together on either side — "De Sa" / "Desa", "Mc Kenzie" / "McKenzie",
// "Dauber Griffin" / "Dauber-Griffin". Returns the largest match found.
function sharedTail(a, b) {
  let best = null;
  for (let ka = 1; ka <= a.length; ka++) {
    const tailA = a.slice(a.length - ka).join("");
    for (let kb = 1; kb <= b.length; kb++) {
      if (tailA !== b.slice(b.length - kb).join("")) continue;
      if (!best || ka + kb > best.ka + best.kb) best = { ka, kb };
    }
  }
  return best;
}

// 0 = not the same person. Higher = better evidence.
function score(a, b) {
  if (!a.length || !b.length) return 0;
  const tail = sharedTail(a, b);
  if (!tail) return 0;                                   // no surname in common
  const givenA = a.slice(0, a.length - tail.ka);
  const givenB = b.slice(0, b.length - tail.kb);
  const depth = Math.min(tail.ka, tail.kb);
  if (!givenA.length && !givenB.length) return 1000 + depth;   // the very same name
  // One side is the whole of the other plus extra given names: "Alexander
  // Niema Moshiri" is the Niema Moshiri who also has ratings.
  if (!givenA.length || !givenB.length) return 500 + depth;
  let common = 0;
  for (const x of givenA) if (givenB.includes(x)) common++;
  if (!common) return 0;                                 // same surname, different person
  return depth * 10 + common;
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

  // Indexed under every way the tail could be read as a surname — "Virginia
  // Desa" under "desa", "De Sa, Virginia" under "sa" and "desa" — so the two
  // spellings of one surname still meet.
  const bySurname = new Map();
  const surnameKeys = (t) => {
    const keys = [];
    for (let k = 1; k <= Math.min(3, t.length); k++) keys.push(t.slice(t.length - k).join(""));
    return keys;
  };
  for (const p of profs) {
    const t = tokens(p.name);
    if (t.length < 2) continue;
    const entry = { ...p, tokens: t };
    for (const key of surnameKeys(t)) {
      if (!bySurname.has(key)) bySurname.set(key, []);
      bySurname.get(key).push(entry);
    }
  }

  const stats = { filled: 0, ambiguous: 0, noCandidate: 0, alreadyRated: 0, noInstructor: 0, mergedDuplicate: 0 };
  const bySrc = {};
  const samples = [], ambiguousSamples = [];

  for (const r of data.recs) {
    if (!r[C.i]) { stats.noInstructor++; continue; }
    if (r[C.rid] != null) { stats.alreadyRated++; continue; }
    const rowTokens = tokens(r[C.i]);
    if (rowTokens.length < 2) { stats.noCandidate++; continue; }
    const candidates = new Set();
    for (const key of surnameKeys(rowTokens)) {
      for (const p of bySurname.get(key) || []) candidates.add(p);
    }
    const scored = [...candidates]
      .map((p) => ({ p, s: score(rowTokens, p.tokens) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s);
    if (!scored.length) { stats.noCandidate++; continue; }
    const best = scored[0].s;
    let top = scored.filter((x) => x.s === best);
    // A tie is usually one professor with duplicate RMP profiles ("Michael
    // Davidson" twice, "David Danks" / "David  Danks"). When the tied names
    // spell out the same person, take the profile carrying the ratings.
    if (top.length > 1 && new Set(top.map((x) => alnum(x.p.name))).size === 1) {
      top.sort((x, y) => (y.p.numRatings || 0) - (x.p.numRatings || 0));
      top = [top[0]];
      stats.mergedDuplicate++;
    }
    if (new Set(top.map((x) => String(x.p.legacyId))).size > 1) {
      stats.ambiguous++;
      if (ambiguousSamples.length < 8) {
        ambiguousSamples.push(`${r[C.s]} ${r[C.c]} · ${r[C.i]} -> ${top.map((x) => x.p.name).join(" / ")}`);
      }
      continue;
    }
    const p = top[0].p;
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
