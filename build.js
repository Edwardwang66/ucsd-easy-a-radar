#!/usr/bin/env node
// Commit-time prebuild — run locally BEFORE committing a data change:
//
//   node build.js
//
// It content-hashes the big data files, writes data.<hash>.json (etc.) into the
// repo root, deletes the previous hashed copies, and rewrites the references
// inside index.html to point at the new names. You then commit the result.
//
// Why commit-time (not a Vercel build step): the site is served as a plain
// static folder from the repo root — no build runs on Vercel — so the files it
// serves must already exist in the repo. Because a file's URL only changes when
// its bytes change, the hashed files are served `immutable` (see vercel.json):
// returning visitors never re-download an unchanged file, and unchanged files
// stay cached across deploys.
//
// Only the large DATA files are hashed. index.html and schedule-instructor.js
// are edited directly and served under their own names, so editing app code
// never requires running this — only a data change does.
//
// Zero dependencies (Node built-ins only).
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const ASSETS = ["data.json", "hist.json", "schedule.json", "plans.json", "gradplans.json"];

function shortHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 10);
}
function reEsc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function main() {
  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const summary = [];

  for (const asset of ASSETS) {
    const ext = path.extname(asset);              // ".json"
    const base = asset.slice(0, -ext.length);     // "data"
    const src = path.join(ROOT, asset);
    if (!fs.existsSync(src)) {
      throw new Error(`build.js: source data file missing: ${asset}`);
    }
    const bytes = fs.readFileSync(src);
    const hashed = `${base}.${shortHash(bytes)}${ext}`;   // data.<hash>.json

    // (Re)write the current hashed copy.
    fs.writeFileSync(path.join(ROOT, hashed), bytes);

    // Remove any previous hashed copies of this asset (but never the source).
    const stale = new RegExp(`^${reEsc(base)}\\.[0-9a-f]+${reEsc(ext)}$`);
    for (const f of fs.readdirSync(ROOT)) {
      if (f !== hashed && stale.test(f)) fs.rmSync(path.join(ROOT, f));
    }

    // Point index.html at the new name — matches the bare source name or a
    // previously-hashed name, in single or double quotes. (A no-op replacement
    // when it already points at this hash is fine; only a total absence of any
    // reference is an error.)
    const pattern = `(['"])${reEsc(base)}(?:\\.[0-9a-f]+)?${reEsc(ext)}\\1`;
    if (!new RegExp(pattern).test(html)) {
      throw new Error(`build.js: no reference to ${asset} found in index.html`);
    }
    html = html.replace(new RegExp(pattern, "g"), `$1${hashed}$1`);
    summary.push(`${asset}  ->  ${hashed}`);
  }

  fs.writeFileSync(path.join(ROOT, "index.html"), html);

  console.log("Prebuilt hashed data assets (references rewritten in index.html):");
  for (const line of summary) console.log(`  ${line}`);
}

main();
