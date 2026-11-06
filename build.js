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
const zlib = require("zlib");

const ROOT = __dirname;
// Past quarters are kept as data.<TERM>.json / schedule.<TERM>.json (written by new-term.js
// when it archives the term it replaces) and picked up here automatically, so the page's
// quarter picker can load any of them.
const ARCHIVED = fs.readdirSync(__dirname)
  .filter((f) => /^(data|schedule)\.[A-Z]{2}\d{2}\.json$/.test(f)).sort();
const ASSETS = ["data.json", "hist.json", "schedule.json", "plans.json", "gradplans.json", "walkbike.json", "ge-courses.json", "minors.json", ...ARCHIVED];

function shortHash(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 10);
}
// Each hashed copy ships in whichever form is smaller ON THE WIRE. Vercel compresses
// static files on the fly at roughly brotli quality 2 (measured: data.json's plain copy
// came back at 709 KB, which q2 reproduces; q11 would be 491 KB). At that level plain
// JSON wins for most files, but for the big, very repetitive ones a pre-gzipped
// {"gz": base64} wrapper still wins by a wide margin (plans: ~592 KB packed vs ~795 KB
// plain). So: estimate both at q2 and pack only when that saves at least 10% and 20 KB.
// The page's unGz() accepts either form. plans.json is stored packed at source.
const WIRE_Q = 2, PACK_MIN_SAVING = 0.10, PACK_MIN_BYTES = 20 * 1024;
const wire = (buf) => zlib.brotliCompressSync(buf, { params: {
  [zlib.constants.BROTLI_PARAM_QUALITY]: WIRE_Q, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length;
function servable(bytes) {
  const head = bytes.slice(0, 16).toString().replace(/\s+/g, "");
  const plain = head.startsWith('{"gz":')
    ? Buffer.from(zlib.gunzipSync(Buffer.from(JSON.parse(bytes.toString("utf8")).gz, "base64")).toString("utf8"))
    : bytes;
  const packed = Buffer.from('{"gz":"' + zlib.gzipSync(plain, { level: 9 }).toString("base64") + '"}');
  const wp = wire(plain), wk = wire(packed);
  const usePacked = wk <= wp * (1 - PACK_MIN_SAVING) && wp - wk >= PACK_MIN_BYTES;
  return { bytes: usePacked ? packed : plain,
    note: `${usePacked ? "packed" : "plain "}  ~${Math.round((usePacked ? wk : wp) / 1024)} KB on the wire (plain ~${Math.round(wp / 1024)}, packed ~${Math.round(wk / 1024)})` };
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
    const { bytes, note } = servable(fs.readFileSync(src));
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
    summary.push(`${asset}  ->  ${hashed}  ${note}`);
  }

  fs.writeFileSync(path.join(ROOT, "index.html"), html);

  console.log("Prebuilt hashed data assets (references rewritten in index.html):");
  for (const line of summary) console.log(`  ${line}`);
}

main();
