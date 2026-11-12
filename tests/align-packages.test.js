const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const align = require(path.join(root, 'align-packages.js'));
// A frozen FA26 slice, not the live data.json / schedule.json: the data-backed tests
// below pin facts about specific courses (ECE 285's three lecture topics, AWP 3's 66
// seminar sections) that change every quarter. The aligner's behaviour is what's
// under test, not this term's data. The fixture holds `data.seats` and
// `schedule.courses` for every FA26 course the aligner linked sections for.
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'align.fa26.json'), 'utf8'));
const data = fixture.data;
const schedule = fixture.schedule;

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

test('AWP 3: every seminar package maps to its own distinct section page', () => {
  // The count itself drifts with TSS (66 seminars in Sep 2026, 64 by Oct after
  // two waitlist-only sections were pulled), so pin the shape, not the number:
  // every package aligned, no two sharing a URL or a schedule section.
  const entry = data.seats['AWP 3'];
  assert.equal(entry.x, 1);
  const annotated = entry.p.filter((p) => p.s);
  assert.ok(annotated.length >= 50, `only ${annotated.length} AWP 3 packages aligned`);
  assert.equal(annotated.length, entry.p.length);
  assert.equal(new Set(annotated.map((p) => p.u)).size, annotated.length);
  assert.equal(new Set(annotated.map((p) => p.s[0])).size, annotated.length);
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
  // pkgLinkFor: packages with aligned codes (p.s) match picked section codes;
  // on x-courses it never falls through to time-key matching.
  assert.match(html, /function pkgLinkFor\(key,secs\)\{[\s\S]{0,500}?p\.s&&p\.s\.length[\s\S]{0,200}?if\(entry\.x\|\|coded\.length\)\{[\s\S]{0,200}?codes\.every\(c=>p\.s\.indexOf\(c\)>=0\)[\s\S]{0,120}?if\(entry\.x\)return null;/);
  // bookingFor: several packages and none identified -> launchpad, never the
  // course-level url (= the first package, a different section).
  assert.match(html, /function bookingFor\(it\)\{[\s\S]{0,900}?entry&&entry\.p&&entry\.p\.length>1\)return\{href:TSS_HOME/);
  // bookingFor: an unidentified group on an aligned course goes to the
  // launchpad, never to the course-level link (someone else's section).
  assert.match(html, /function bookingFor\(it\)\{[\s\S]{0,400}?entry\.x&&Object\.keys\(groups\)\.length>1[\s\S]{0,80}?TSS_HOME/);
  // seatLink: a professor's row on an aligned course links to their own
  // package, with a launchpad fallback.
  assert.match(html, /function seatLink\(r\)\{[\s\S]{0,900}?entry&&entry\.x[\s\S]{0,300}?faMatchesName\(n,r\[C\.i\]\)/);
});

test('annotateEntry aligns combo courses lab by lab in package-id order (CHEM 43A)', () => {
  // LE A00 + labs A01–A05 at 9:00 and A06–A10 at 1:00 (same times, different rooms)
  // + an OT section; ten packages, scraped out of order.
  const lab = (c, t) => [c, 'LA', 'MW', t, '', 'York Hall', '', 'Emmanuel Theodorakis', 24, 24, 0];
  const course = { sec: [
    ['A00', 'LE', 'F', '9:00a', '9:50a', 'Mosaic', '114', 'Emmanuel Theodorakis', null, null, 0],
    ...[1, 2, 3, 4, 5].map((n) => lab('A0' + n, '9:00a')),
    ...[6, 7, 8, 9, 10].map((n) => lab('A' + String(n).padStart(2, '0'), '1:00p')),
    ['A11', 'OT', '', '', '', '', '', 'Emmanuel Theodorakis', 24, 24, 0],
    ['03/17/2027', 'FI', '03/17/2027', '8:00a', '10:59a', 'Mosaic', '114', '', null, null, 0],
  ] };
  const url = (id) => `https://tss.ucsd.edu/fiori#ZUSModule-display?TileType=MYMOD&/Detail/EventPackage/SM/2117/00000000/0/0/0/00000000-0000-0000-0000-000000000000/${id}/2026/3/?`;
  const ids = [162952, 162947, 162948, 162949, 162950, 162951, 162953, 162954, 162955, 162956]; // shuffled
  const entry = { u: url(162947), p: ids.map((id) => ({
    u: url(id),
    k: id === 162947 ? ['LA|MW|09:00', 'LE|F|09:00'] : [id <= 162951 ? 'LA|MW|09:00' : 'LA|MW|13:00'],
  })) };
  assert.equal(align.annotateEntry(entry, course), 'combo-aligned');
  assert.equal(entry.x, undefined);
  const byId = Object.fromEntries(entry.p.map((p) => [+/\/(\d+)\/2026/.exec(p.u)[1], p.s]));
  assert.deepEqual(byId[162947], ['A00', 'A11', 'A01']);
  assert.deepEqual(byId[162952], ['A00', 'A11', 'A06']);
  assert.deepEqual(byId[162956], ['A00', 'A11', 'A10']);
});

test('annotateEntry leaves cross-product combos (two choice types in a group) alone', () => {
  const course = { sec: [
    ['A00', 'LE', 'MWF', '9:00a', '', '', '', 'X', null, null, 0],
    ['A01', 'DI', 'M', '1:00p', '', '', '', 'X', 1, 1, 0],
    ['A02', 'DI', 'M', '2:00p', '', '', '', 'X', 1, 1, 0],
    ['A50', 'LA', 'Tu', '1:00p', '', '', '', 'X', 1, 1, 0],
    ['A51', 'LA', 'Tu', '2:00p', '', '', '', 'X', 1, 1, 0],
  ] };
  const entry = { u: 'u1', p: [1, 2, 3, 4].map((n) => ({ u: `x/${n}/2026/3/?`, k: ['DI|M|13:00'] })) };
  assert.equal(align.annotateEntry(entry, course), 'combo');
  assert.ok(entry.p.every((p) => !p.s));
});
