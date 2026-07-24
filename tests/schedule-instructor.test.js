const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const helperPath = path.join(root, 'schedule-instructor.js');
const helper = fs.existsSync(helperPath) ? require(helperPath) : {};
const schedule = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));

const S_CODE = 0;
const S_TYPE = 1;
const S_CANC = 10;

function activeGroups(course) {
  const groups = {};
  for (const section of course.sec) {
    if (section[S_CANC] || section[S_TYPE] === 'FI') continue;
    const code = section[S_CODE] || '';
    if (!/^[A-Za-z]/.test(code)) continue;
    const group = code[0].toUpperCase();
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

  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /preferredInstructor=[^;]*ScheduleInstructor\.sameInstructorName/);
});

test('instructor choices identify every ECON 1 section group', () => {
  assert.equal(typeof helper.instructorGroupChoices, 'function');

  const groups = activeGroups(schedule.courses['ECON 1']);
  assert.deepEqual(helper.instructorGroupChoices(groups), [
    { group: 'A', instructors: ['Steven Levkoff'], label: 'Steven Levkoff · A' },
    { group: 'B', instructors: ['Steven Levkoff'], label: 'Steven Levkoff · B' },
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

test('changing the schedule dropdown refreshes professor-row button states', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(
    html,
    /if\(g\)\{[\s\S]{0,300}?saveSchState\(\);updateAddButtons\(\);renderSchedule\(\);/,
  );
});
