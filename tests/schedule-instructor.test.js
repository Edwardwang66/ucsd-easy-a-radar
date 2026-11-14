const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const helperPath = path.join(root, 'schedule-instructor.js');
const helper = fs.existsSync(helperPath) ? require(helperPath) : {};
// A frozen FA26 slice, not the live schedule.json: these tests pin facts about specific
// courses (ECON 1's instructor groups, AWP 3's 66 seminar groups running past 'Z') that
// change every quarter. The helper's behaviour is what's under test, not this term's data.
const schedule = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'schedule.fa26.json'), 'utf8'));

const S_CODE = 0;
const S_TYPE = 1;
const S_CANC = 10;

// Mirror of index.html's activeGroups: group by the EXACT first character of
// the section code — WebReg group letters run past 'Z' into ASCII punctuation
// and lowercase on very large courses, so 'a81' is a different group from 'A81'.
function activeGroups(course) {
  const groups = {};
  for (const section of course.sec) {
    if (section[S_CANC] || section[S_TYPE] === 'FI') continue;
    const code = section[S_CODE] || '';
    const group = code.charAt(0);
    if (!group || /[0-9]/.test(group)) continue;
    (groups[group] = groups[group] || []).push(section);
  }
  return groups;
}

test('ECON 1 can select Dai instead of defaulting to Levkoff', () => {
  assert.equal(typeof helper.preferredGroupForInstructor, 'function');

  const groups = activeGroups(schedule.courses['ECON 1']);
  assert.equal(helper.preferredGroupForInstructor(groups, 'Yinlin Dai'), 'C');
  assert.equal(helper.preferredGroupForInstructor(groups, 'Steven Levkoff'), 'A');
});

test('exact FA26 name wins even when historical aliases use a different surname', () => {
  assert.equal(typeof helper.sameInstructorName, 'function');

  const groups = activeGroups(schedule.courses['EDS 368']);
  assert.equal(helper.sameInstructorName('Bailey Choi-Vanos', 'Bailey Choi-Vanos'), true);
  assert.equal(helper.preferredGroupForInstructor(groups, 'Bailey Choi-Vanos'), 'B');

  // The row's schedule button picks its instructor through faMatchesName, which
  // must try the exact catalog name (after the reviewed data.aka map, which is
  // also exact) before falling back to the surname+initial heuristic ladder.
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /preferredInstructor=[^;]*faMatchesName/);
  const fnMatch = html.match(/function faMatchesName\(faName,gradeName\)\{[\s\S]*?\n  \}\n/);
  assert.ok(fnMatch, 'index.html defines function faMatchesName(faName,gradeName)');
  const fn = fnMatch[0];
  const exactAt = fn.indexOf('if(ScheduleInstructor.sameInstructorName(faName,gradeName)) return true;');
  const heuristicAt = fn.indexOf('catKeysJS(faName)');
  assert.ok(exactAt !== -1, 'faMatchesName short-circuits on sameInstructorName(faName,gradeName)');
  assert.ok(heuristicAt !== -1, 'faMatchesName falls back to catKeysJS surname+initial keys');
  assert.ok(exactAt < heuristicAt, 'exact name match must run before the surname+initial ladder');
  // Nothing before the exact match may be a heuristic key comparison — only the AKA map.
  const before = fn.slice(0, exactAt);
  assert.doesNotMatch(before, /catKeysJS|ourKeysJS/);
  assert.match(before, /AKA\[gradeName\]/);
});

test('instructor choices identify every ECON 1 section group', () => {
  assert.equal(typeof helper.instructorGroupChoices, 'function');

  const groups = activeGroups(schedule.courses['ECON 1']);
  // the same instructor on two groups gets the lecture time so the options differ
  assert.deepEqual(helper.instructorGroupChoices(groups), [
    { group: 'A', instructors: ['Steven Levkoff'], label: 'Steven Levkoff · A · LE TuTh 11:00a' },
    { group: 'B', instructors: ['Steven Levkoff'], label: 'Steven Levkoff · B · LE TuTh 2:00p' },
    { group: 'C', instructors: ['Yinlin Dai'], label: 'Yinlin Dai · C' },
  ]);
});

test('button state distinguishes the selected professor from an available switch', () => {
  assert.equal(typeof helper.instructorChoiceState, 'function');

  const groups = activeGroups(schedule.courses['ECON 1']);
  assert.equal(helper.instructorChoiceState(false, groups, '', 'Yinlin Dai'), 'add');
  assert.equal(helper.instructorChoiceState(true, groups, 'A', 'Yinlin Dai'), 'switch');
  assert.equal(helper.instructorChoiceState(true, groups, 'C', 'Yinlin Dai'), 'added');
});

test('AWP 3 seminar groups stay distinct past Z (no case-insensitive merging)', () => {
  const groups = activeGroups(schedule.courses['AWP 3']);
  const keys = Object.keys(groups);
  // WebReg's group letters continue past 'Z' into ASCII — every seminar is its
  // own group, and 'a81' must NOT be folded into group 'A'.
  assert.ok(keys.length >= 60, `expected 60+ AWP 3 groups, got ${keys.length}`);
  assert.ok(keys.includes('A') && keys.includes('a'), 'uppercase and lowercase are separate groups');
  assert.notDeepEqual(groups['A'], groups['a']);
  for (const sections of Object.values(groups)) assert.equal(sections.length, 1);

  // index.html must use the same exact-first-character grouping.
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /function activeGroups\(course\)\{[^\n]*charAt\(0\);if\(!gl\|\|\/\[0-9\]\/\.test\(gl\)\)continue;/);
});

test('instructor-less groups are labelled with their real section code', () => {
  const groups = activeGroups(schedule.courses['AWP 3']);
  const choices = helper.instructorGroupChoices(groups);
  const a = choices.find((c) => c.group === 'A');
  assert.deepEqual(a.instructors, []);
  assert.equal(a.label, 'Section A81');
});

test('changing the schedule dropdown refreshes professor-row button states', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(
    html,
    /if\(g\)\{[\s\S]{0,300}?saveSchState\(\);updateAddButtons\(\);renderSchedule\(\);/,
  );
});
