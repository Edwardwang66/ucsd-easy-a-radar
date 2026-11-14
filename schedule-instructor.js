(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ScheduleInstructor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CODE_INDEX = 0;
  const TYPE_INDEX = 1;
  const DAYS_INDEX = 2;
  const START_INDEX = 3;
  const INSTRUCTOR_INDEX = 7;

  function instructorsForGroup(sections) {
    return [...new Set((sections || [])
      .map((section) => String(section[INSTRUCTOR_INDEX] || '').trim())
      .filter(Boolean))];
  }

  // Comparing catalog names against grade-history names is done tens of thousands of
  // times at startup over a few thousand distinct names, and NFD normalisation is the
  // expensive part \u2014 so cache it. Pure function of the string; the name set is bounded.
  const normCache = new Map();
  function normalize(value) {
    const s = String(value || '');
    let v = normCache.get(s);
    if (v === undefined) {
      v = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      normCache.set(s, v);
    }
    return v;
  }

  function sameInstructorName(a, b) {
    const left = normalize(a);
    return !!left && left === normalize(b);
  }

  // "LE MWF 10:00a" — the group's lecture (else its first timed meeting), used to tell
  // apart two groups taught by the same instructor.
  function groupMeeting(sections) {
    const timed = (sections || []).filter((s) => s[DAYS_INDEX] && s[START_INDEX]);
    const pick = timed.find((s) => s[TYPE_INDEX] === 'LE') || timed[0];
    return pick ? pick[TYPE_INDEX] + ' ' + pick[DAYS_INDEX] + ' ' + pick[START_INDEX] : '';
  }

  function instructorGroupChoices(groups) {
    const choices = Object.keys(groups || {}).sort().map((group) => {
      const sections = groups[group] || [];
      const instructors = instructorsForGroup(sections);
      // No instructor names (AWP-style seminars): label with the real section
      // code ("Section A81"), not just the group letter.
      const code = sections[0] && String(sections[0][CODE_INDEX] || '');
      return {
        group,
        instructors,
        label: instructors.length ? instructors.join(', ') + ' · ' + group : 'Section ' + (code || group),
        _who: instructors.join(', '),
        _when: groupMeeting(sections),
      };
    });
    // Same instructor on several groups ("Steven Levkoff · A" / "· B"): add the meeting time.
    const count = {};
    for (const c of choices) if (c._who) count[c._who] = (count[c._who] || 0) + 1;
    return choices.map(({ _who, _when, ...c }) =>
      (_who && count[_who] > 1 && _when) ? { ...c, label: c.label + ' · ' + _when } : c);
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
