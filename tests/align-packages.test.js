const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const align = require(path.join(root, 'align-packages.js'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'data.json'), 'utf8'));
const schedule = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));

// sec columns: [code, type, days, start, end, building, room, instructor, avail, limit, cancelled]
function sec(code, type, days, start, instructor) {
  return [code, type, days, start, '', '', '', instructor || '', null, null, 0];
}

test('certainPairs: equal-length duplicate runs are forced onto the diagonal', () => {
  // groups [X, X] vs packages [X, X] — order forces 0↔0 and 1↔1.
  const eq = (i, j) => true;
  assert.deepEqual([...align.certainPairs(2, 2, eq)].sort(), [[0, 0], [1, 1]]);
});

test('certainPairs: a missing package makes same-signature neighbours ambiguous', () => {
  // groups [Y, X, X] vs packages [Y, X] (one of the two same-time X sections
  // was never scraped): Y is forced, but the lone X package may belong to
  // either X group — it must match neither.
  const g = ['Y', 'X', 'X'], p = ['Y', 'X'];
  const eq = (i, j) => g[i] === p[j];
  assert.deepEqual([...align.certainPairs(3, 2, eq)], [[0, 0]]);
});

test('certainPairs: order pins a duplicate when a later anchor needs the room', () => {
  // groups [X, Y, X] vs packages [X, Y]: the X package cannot belong to the
  // last group — the Y package after it would have nowhere to go — so the
  // scrape order forces it onto the FIRST X group (this is exactly ECE 285:
  // two 12:30 topics around an 18:30 one, with the last topic unscraped).
  const g = ['X', 'Y', 'X'], p = ['X', 'Y'];
  const eq = (i, j) => g[i] === p[j];
  assert.deepEqual([...align.certainPairs(3, 2, eq)].sort(), [[0, 0], [1, 1]]);
});

test('annotateEntry aligns one-package-per-group courses and flags them x', () => {
  const course = { sec: [
    sec('A00', 'LE', 'TuTh', '12:30p', 'Prof A'),
    ['12/11/2026', 'FI', '12/11/2026', '11:30a', '', '', '', '', null, null, 0],
    sec('B00', 'LE', 'TuTh', '6:30p', 'Prof B'),
    sec('C00', 'LE', 'TuTh', '12:30p', 'Prof C'),
  ] };
  const entry = { u: 'u0', p: [
    { u: 'pkgA', k: ['LE|TuTh|12:30'] },
    { u: 'pkgB', k: ['LE|TuTh|18:30'] },
  ] };
  assert.equal(align.annotateEntry(entry, course), 'aligned');
  assert.equal(entry.x, 1);
  assert.deepEqual(entry.p[0].s, ['A00']);       // first 12:30 lecture, by order
  assert.deepEqual(entry.p[0].i, ['Prof A']);
  assert.deepEqual(entry.p[1].s, ['B00']);       // unique evening lecture
  // Prof C's 12:30 lecture has no scraped package — nothing may claim it.
  assert.ok(!entry.p.some((p) => p.s && p.s.includes('C00')));
});

test('annotateEntry tolerates multi-meeting sections and partial package keys', () => {
  // MAE 107 shape: each lecture section meets twice a week under ONE code, and
  // the scrape recorded only one of the meetings in the package key.
  const course = { sec: [
    sec('A00', 'LE', 'Th', '10:00a', 'Prof A'),
    sec('A00', 'LE', 'MWF', '2:00p', 'Prof A'),
    sec('B00', 'LE', 'MWF', '10:00a', 'Prof B'),
    sec('B00', 'LE', 'W', '2:00p', 'Prof B'),
  ] };
  const entry = { u: 'u0', p: [
    { u: 'pkgA', k: ['LE|Th|10:00'] },
    { u: 'pkgB', k: ['LE|MWF|10:00'] },
  ] };
  assert.equal(align.annotateEntry(entry, course), 'aligned');
  assert.deepEqual(entry.p[0].s, ['A00']);
  assert.deepEqual(entry.p[1].s, ['B00']);
});

test('annotateEntry leaves combo courses (same-type section choices) alone', () => {
  const course = { sec: [
    sec('A00', 'LE', 'MWF', '9:00a', 'Prof A'),
    sec('A01', 'LA', 'Tu', '1:00p', 'Prof A'),
    sec('A02', 'LA', 'W', '1:00p', 'Prof A'),
  ] };
  const entry = { u: 'u0', p: [
    { u: 'pkg1', k: ['LE|MWF|09:00', 'LA|Tu|13:00'] },
    { u: 'pkg2', k: ['LE|MWF|09:00', 'LA|W|13:00'] },
  ] };
  assert.equal(align.annotateEntry(entry, course), 'combo');
  assert.ok(!entry.x);
  assert.ok(!entry.p[0].s && !entry.p[1].s);
});

test('annotateEntry flags no-package multi-instructor courses as ambiguous', () => {
  const course = { sec: [
    sec('A00', 'LE', 'TuTh', '2:00p', 'Prof A'),
    sec('B00', 'LE', 'MWF', '1:00p', 'Prof B'),
  ] };
  const entry = { u: 'u0' };
  assert.equal(align.annotateEntry(entry, course), 'flagged-ambiguous');
  assert.equal(entry.x, 1);
});

// ---- shipped data.json must actually carry the alignment ------------------

test('ECE 285: every topic links to its own instructor’s package (#71)', () => {
  const entry = data.seats['ECE 285'];
  assert.equal(entry.x, 1);
  const byCode = Object.fromEntries(entry.p.filter((p) => p.s).map((p) => [p.s[0], p]));
  assert.deepEqual(byCode['A00'].i, ['Parinaz Naghizadeh']);
  assert.deepEqual(byCode['B00'].i, ['Pengtao Xie']);
  assert.notEqual(byCode['A00'].u, byCode['B00'].u);
  // Yang Zheng's 12:30 lecture was never scraped — no package may claim C00,
  // so the app falls back to the launchpad instead of Naghizadeh's page.
  assert.ok(!entry.p.some((p) => p.s && p.s.includes('C00')));
});

test('AWP 3: all 66 seminar sections map to 66 distinct package pages', () => {
  const entry = data.seats['AWP 3'];
  assert.equal(entry.x, 1);
  const annotated = entry.p.filter((p) => p.s);
  assert.equal(annotated.length, 66);
  assert.equal(new Set(annotated.map((p) => p.u)).size, 66);
  assert.equal(new Set(annotated.map((p) => p.s[0])).size, 66);
});

test('shipped annotations are consistent with the schedule', () => {
  let aligned = 0, sectionLinks = 0;
  for (const [key, entry] of Object.entries(data.seats)) {
    if (!entry.x || !Array.isArray(entry.p)) continue;
    aligned++;
    const course = schedule.courses[key];
    assert.ok(course, `${key}: x-flagged but not in schedule`);
    const groups = new Map(align.activeGroups(course));
    const seen = new Set();
    for (const p of entry.p) {
      if (!p.s) continue;
      sectionLinks++;
      const gl = p.s[0].charAt(0);
      assert.ok(groups.has(gl), `${key}: package claims unknown group ${gl}`);
      assert.ok(!seen.has(gl), `${key}: two packages claim group ${gl}`);
      seen.add(gl);
      assert.ok(align.pkgFitsGroup(p, align.groupKeySet(groups.get(gl))),
        `${key}: package times don't fit claimed group ${gl}`);
    }
  }
  assert.ok(aligned >= 100, `expected 100+ aligned courses, got ${aligned}`);
  assert.ok(sectionLinks >= 500, `expected 500+ section links, got ${sectionLinks}`);
});

// ---- the app must consume the annotations --------------------------------

test('index.html trusts only aligned section codes on x-courses', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  // pkgLinkFor: the x branch matches picked section codes against p.s and
  // never falls through to time-key matching.
  assert.match(html, /function pkgLinkFor\(key,secs\)\{[\s\S]{0,200}?if\(entry\.x\)\{[\s\S]{0,300}?p\.s&&p\.s\.length&&codes\.every/);
  // bookingFor: an unidentified group on an aligned course goes to the
  // launchpad, never to the course-level link (someone else's section).
  assert.match(html, /function bookingFor\(it\)\{[\s\S]{0,400}?entry\.x&&Object\.keys\(groups\)\.length>1[\s\S]{0,80}?TSS_HOME/);
  // seatLink: a professor's row on an aligned course links to their own
  // package, with a launchpad fallback.
  assert.match(html, /function seatLink\(r\)\{[\s\S]{0,900}?entry&&entry\.x[\s\S]{0,300}?faMatchesName\(n,r\[C\.i\]\)/);
});
