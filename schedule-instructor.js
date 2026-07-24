(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ScheduleInstructor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const INSTRUCTOR_INDEX = 7;

  function instructorsForGroup(sections) {
    return [...new Set((sections || [])
      .map((section) => String(section[INSTRUCTOR_INDEX] || '').trim())
      .filter(Boolean))];
  }

  function sameInstructorName(a, b) {
    const normalize = (value) => String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const left = normalize(a);
    return !!left && left === normalize(b);
  }

  function instructorGroupChoices(groups) {
    return Object.keys(groups || {}).sort().map((group) => {
      const instructors = instructorsForGroup(groups[group]);
      return {
        group,
        instructors,
        label: instructors.length ? instructors.join(', ') + ' · ' + group : 'Section ' + group,
      };
    });
  }

  function preferredGroupForInstructor(groups, instructor) {
    const target = String(instructor || '').trim();
    if (!target) return '';
    const choice = instructorGroupChoices(groups).find((item) => item.instructors.includes(target));
    return choice ? choice.group : '';
  }

  function instructorChoiceState(courseAdded, groups, selectedGroup, instructor) {
    if (!courseAdded) return 'add';
    const target = String(instructor || '').trim();
    if (!target) return 'added';
    const selected = instructorGroupChoices(groups).find((item) => item.group === selectedGroup);
    return selected && selected.instructors.includes(target) ? 'added' : 'switch';
  }

  return {
    instructorGroupChoices,
    preferredGroupForInstructor,
    instructorChoiceState,
    sameInstructorName,
  };
});
