#!/usr/bin/env node
// walkbike-gen.js — rebuild walkbike.json: walk / bike minutes and walking-path metres
// between every pair of buildings in schedule.json's `buildings` map.
//
//   node walkbike-gen.js             # regenerate (every pair, both profiles)
//   node walkbike-gen.js --dry-run   # route, compare with the current file, write nothing
//   node build.js                    # then re-hash
//
// Routing is OpenStreetMap-based, via the public Valhalla demo server
// (valhalla1.openstreetmap.de, pedestrian + bicycle costing) — the same road / path
// network the original OSRM run used. Matrix requests are chunked to stay under the
// server's per-request location limit, with a pause between calls. The result is a
// full N×N table keyed by the building names, in the order of the `buildings` map.
// Zero dependencies (Node 18+ fetch).
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const dry = process.argv.includes("--dry-run");
const HOST = process.env.VALHALLA || "https://valhalla1.openstreetmap.de";
const CHUNK = 10;              // sources × targets per request — the demo server caps a matrix at 100 pairs
const PAUSE_MS = 700;

const sched = JSON.parse(fs.readFileSync(path.join(ROOT, "schedule.json"), "utf8"));
const names = Object.keys(sched.buildings);
const coords = names.map((n) => sched.buildings[n]);
if (!names.length) { console.error("schedule.json has no buildings"); process.exit(1); }
console.log(`${names.length} buildings → ${names.length * names.length} pairs × 2 profiles via ${HOST}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function matrix(costing, si, ti) {
  const body = {
    sources: si.map((i) => ({ lat: coords[i][0], lon: coords[i][1] })),
    targets: ti.map((i) => ({ lat: coords[i][0], lon: coords[i][1] })),
    costing, units: "kilometers",
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(HOST + "/sources_to_targets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return (await r.json()).sources_to_targets;
    const txt = await r.text();
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    throw new Error(`Valhalla ${r.status}: ${txt.slice(0, 200)}`);
  }
  throw new Error("Valhalla kept failing");
}

(async () => {
  const n = names.length;
  const walk = Array.from({ length: n }, () => new Array(n).fill(null));
  const bike = Array.from({ length: n }, () => new Array(n).fill(null));
  const meters = Array.from({ length: n }, () => new Array(n).fill(null));
  const idx = [...Array(n).keys()];
  let calls = 0;
  for (const costing of ["pedestrian", "bicycle"]) {
    for (let s = 0; s < n; s += CHUNK) {
      for (let t = 0; t < n; t += CHUNK) {
        const si = idx.slice(s, s + CHUNK), ti = idx.slice(t, t + CHUNK);
        const rows = await matrix(costing, si, ti);
        calls++;
        rows.forEach((row, a) => row.forEach((cell, b) => {
          const i = si[a], j = ti[b];
          const min = cell.time == null ? null : Math.round(cell.time / 6) / 10;        // seconds → minutes, 0.1
          if (costing === "pedestrian") { walk[i][j] = min; meters[i][j] = cell.distance == null ? null : Math.round(cell.distance * 1000); }
          else bike[i][j] = min;
        }));
        process.stdout.write(`\r  ${costing.padEnd(10)} ${Math.min(s + CHUNK, n)}/${n} × ${Math.min(t + CHUNK, n)}/${n}   `);
        await sleep(PAUSE_MS);
      }
    }
    console.log();
  }
  // the diagonal is 0 by definition; a null elsewhere means the router found no path
  let unroutable = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (i === j) { walk[i][j] = 0; bike[i][j] = 0; meters[i][j] = 0; continue; }
    if (walk[i][j] == null || bike[i][j] == null) unroutable++;
  }
  // compare with what is shipped now, where the names overlap
  let old = null;
  try { old = JSON.parse(fs.readFileSync(path.join(ROOT, "walkbike.json"), "utf8")); } catch (e) {}
  if (old) {
    const oi = new Map(old.names.map((nm, i) => [nm, i]));
    const rel = [];
    let same = 0;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = oi.get(names[i]), b = oi.get(names[j]);
      if (a == null || b == null) continue;
      same++;
      if (old.meters[a][b] && meters[i][j]) rel.push(meters[i][j] / old.meters[a][b]);
    }
    rel.sort((x, y) => x - y);
    const med = rel[Math.floor(rel.length / 2)];
    const newNames = names.filter((nm) => !oi.has(nm));
    console.log(`compared ${same} pairs with the current file: walking metres new/old median ${med ? med.toFixed(3) : "n/a"}, p10 ${rel[Math.floor(rel.length * 0.1)]?.toFixed(3)}, p90 ${rel[Math.floor(rel.length * 0.9)]?.toFixed(3)}`);
    if (newNames.length) console.log(`new buildings: ${newNames.join(", ")}`);
  }
  console.log(`${calls} requests; ${unroutable} unroutable pairs`);
  const out = {
    generated: new Date().toISOString().slice(0, 10),
    note: "Walk/bike minutes + walking-path meters between UCSD buildings. Precomputed via Valhalla (OpenStreetMap pedestrian / bicycle routing); regenerate with walkbike-gen.js after adding a building to schedule.json.",
    names, coords, walk, bike, meters,
  };
  if (dry) { console.log("dry run — nothing written"); return; }
  fs.writeFileSync(path.join(ROOT, "walkbike.json"), JSON.stringify(out));
  console.log(`wrote walkbike.json (${n}×${n}). Next: node build.js`);
})().catch((e) => { console.error(e.message); process.exit(1); });
