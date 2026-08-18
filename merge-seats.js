#!/usr/bin/env node
// Merge a fresh ucsd-seat-sync export into data.json's `seats` map.
//
//   node merge-seats.js ~/Downloads/ucsd-seats-2026-2.json
//   node build.js            # then re-hash data.json + rewrite index.html
//
// The site's only source of direct TSS "Course page ↗" deep-links is
// data.json `seats["SUBJ NUM"] = { u: <bookingUrl> }`. That map is produced by
// the browser-console scraper in ../ucsd-seat-sync, which keys courses as
// "AAS-010R" (dash, zero-padded). The app looks them up with
//   CK(s,c) = SUBJ.toUpperCase() + " " + NUM.toUpperCase().replace(/[^0-9A-Z]/g,"")
// e.g. "AAS 10R" — so we translate the scraper's code to that shape here:
// split on the first "-", strip the number's leading zeros.
//
// Only courses whose scrape yielded a bookingUrl get an entry; the rest fall
// back to the TSS launchpad in the app. Merge is a superset union — existing
// links are never dropped, only added/refreshed — so a partial scrape can't
// regress coverage. Zero dependencies (Node built-ins only).
"use strict";

const fs = require("fs");
const path = require("path");

function ck(subject, number) {
  return String(subject).toUpperCase() + " " +
    String(number).toUpperCase().replace(/[^0-9A-Z]/g, "");
}

// "AAS-010R" -> "AAS 10R"; returns null if the code has no subject/number split.
function scraperCodeToKey(course) {
  const i = String(course).indexOf("-");
  if (i < 0) return null;
  const subject = course.slice(0, i);
  const number = course.slice(i + 1).replace(/^0+(?=\d)/, ""); // drop leading zeros, keep last digit
  return ck(subject, number);
}

// A course can span several TSS event packages — e.g. one lecture paired with
// each of nine labs, every combination separately enrollable and each with its
// own booking URL. The scraper reports them in `packages`, each carrying the
// sections it contains. We reduce every package to its booking link plus the
// set of meeting-time keys ("LA|W|09:00") of its sections, so the app can look
// at the sections a student actually picked and land them on that package's
// page instead of one shared course-level link.
//
// Only emitted when the packages are actually distinguishable: a single
// package needs no key at all, and courses whose packages all meet at the same
// times (identical signatures) can't be told apart this way — those keep the
// course-level link and the app falls back to it.
function sectionKey(section) {
  if (!section || !section.type || !section.days || !section.start) return null;
  return `${section.type}|${section.days}|${section.start}`;
}

function packageLinks(course) {
  const packages = (course.packages || []).filter((p) => p && p.bookingUrl);
  if (packages.length < 2) return null;
  const out = packages.map((p) => ({
    u: p.bookingUrl,
    k: [...new Set((p.sections || []).map(sectionKey).filter(Boolean))].sort(),
    // Special-topics packages can meet at the very same times (ECE 285's two
    // 12:30 lectures are different topics) — the instructor is what tells
    // them apart, so carry each package's instructors for the app to match.
    i: [...new Set((p.sections || []).map((s) => s && s.instructor).filter(Boolean))].sort(),
  })).filter((p) => p.k.length || p.i.length);
  if (out.length < 2) return null;
  const signatures = new Set(out.map((p) => p.k.join("~") + "§" + p.i.join("~")));
  if (signatures.size < 2) return null;   // indistinguishable by time or instructor
  return out;
}

function main() {
  const srcArg = process.argv[2];
  if (!srcArg) {
    console.error("usage: node merge-seats.js <ucsd-seats-*.json>");
    process.exit(1);
  }
  const ROOT = __dirname;
  const dataPath = path.join(ROOT, "data.json");
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const scrape = JSON.parse(fs.readFileSync(srcArg, "utf8"));

  const before = Object.keys(data.seats || {}).length;
  const seats = { ...(data.seats || {}) };
  let added = 0, refreshed = 0, skipped = 0, withPkgs = 0;
  for (const c of scrape.courses || []) {
    if (!c.bookingUrl) { skipped++; continue; }
    const key = scraperCodeToKey(c.course);
    if (!key) { skipped++; continue; }
    if (!seats[key]) added++;
    else if (seats[key].u !== c.bookingUrl) refreshed++;
    const entry = { u: c.bookingUrl };
    const pkgs = packageLinks(c);
    if (pkgs) { entry.p = pkgs; withPkgs++; }
    seats[key] = entry;
  }
  data.seats = seats;
  fs.writeFileSync(dataPath, JSON.stringify(data));

  console.log(`scrape: status=${scrape.status} courses=${(scrape.courses || []).length} ` +
    `withLink=${(scrape.courses || []).filter((c) => c.bookingUrl).length}`);
  console.log(`seats: ${before} -> ${Object.keys(seats).length} ` +
    `(added ${added}, refreshed ${refreshed}, no-link skipped ${skipped})`);
  console.log(`per-package links: ${withPkgs} courses`);
  console.log("\nNext: node align-packages.js  # re-align packages to schedule sections (seminar/special-topics links)");
  console.log("      node healthcheck.js     # reconcile — orphans / coverage / key drift");
  console.log("      node build.js           # then re-hash data.json + rewrite index.html");
}

main();
