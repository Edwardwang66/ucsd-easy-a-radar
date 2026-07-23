/*
 * rmp_console_scraper.js — paste into the browser DevTools console while on
 * https://www.ratemyprofessors.com  (any page on that domain, so the request is
 * same-origin). Scrapes every UC San Diego professor (school 1079) and downloads
 * rmp_ucsd.json.
 *
 * WHY THIS IS THE FAST WAY
 *   RMP's "Show More" is cursor pagination over GraphQL. The page size is capped
 *   at 1000 (first > 1000 is rejected), so you can't grab all 4018 in one call —
 *   but at 1000/page it's only ~5 sequential requests (~5s). Using the site's
 *   default ~8-per-click page (what a naive Show-More loop does) is what makes a
 *   scrape stop short / miss rows to boundary duplicates — this got 4018/4018 for
 *   me because it asks first:1000 and de-dupes by legacyId.
 */
(async () => {
  const SCHOOL = "U2Nob29sLTEwNzk=";               // base64 "School-1079" (UC San Diego)
  const AUTH = "Basic dGVzdDp0ZXN0";               // RMP public site token (test:test)
  const QUERY = `query T($q: TeacherSearchQuery!, $first: Int!, $after: String){
    newSearch{ teachers(query:$q, first:$first, after:$after){
      resultCount
      edges{ node{ id legacyId firstName lastName department avgRating avgDifficulty numRatings wouldTakeAgainPercent } }
      pageInfo{ hasNextPage endCursor }
    }}}`;

  async function page(text, after) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch("/graphql", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: AUTH },
          body: JSON.stringify({ query: QUERY, variables: { q: { text, schoolID: SCHOOL }, first: 1000, after } }),
        });
        const j = await res.json();
        const t = j?.data?.newSearch?.teachers;
        if (t) return t;
      } catch (e) { /* fall through to backoff */ }
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt)); // 1,2,4,8,16,32s
    }
    return null;
  }

  const byId = new Map();
  const take = (t) => {                             // add new professors from a page, de-duping
    for (const { node: n } of t.edges) {
      if (byId.has(n.legacyId)) continue;
      byId.set(n.legacyId, {
        name: `${n.firstName} ${n.lastName}`.trim(),
        firstName: n.firstName, lastName: n.lastName,
        department: n.department,
        quality: n.avgRating, difficulty: n.avgDifficulty,
        wouldTakeAgainPercent: n.wouldTakeAgainPercent,
        numRatings: n.numRatings,
        legacyId: n.legacyId,
        url: `https://www.ratemyprofessors.com/professor/${n.legacyId}`,
        id: n.id,                                   // base64 relay id, e.g. "VGVhY2hlci0yNzMyMzU5"
      });
    }
  };

  // one "Show More" loop for a given search seed (empty seed = whole roster).
  // Returns the resultCount RMP reports for that seed.
  async function loop(text, label) {
    let after = "", count = 0;
    while (true) {
      const t = await page(text, after);
      if (!t) { console.warn(`  [${label}] page failed, stopping this seed`); break; }
      count = t.resultCount;
      take(t);
      if (!t.pageInfo.hasNextPage) break;
      after = t.pageInfo.endCursor;
    }
    return count;
  }

  // Pass 1 — the plain Show-More loop. Fast (~5 requests at first:1000), lands a few short
  // because RMP's paged stream repeats rows near page boundaries. The empty-seed resultCount is
  // the true roster total — capture it here and never overwrite it with a seed's smaller count.
  const reported = await loop("", "all");
  console.log(`pass 1: ${byId.size}/${reported}`);

  // Pass 2 — fill the gap: re-run the loop seeded with each letter/digit (a different slice of
  // the index each time) until we reach the reported total. Usually only a few seeds are needed.
  if (byId.size < reported) {
    for (const seed of "abcdefghijklmnopqrstuvwxyz0123456789") {
      if (byId.size >= reported) break;
      const before = byId.size;
      await loop(seed, seed);
      if (byId.size !== before) console.log(`  seed '${seed}': +${byId.size - before}  (${byId.size}/${reported})`);
    }
  }

  const out = {
    source: "https://www.ratemyprofessors.com/search/professors/1079?q=*&did=*",
    retrieved: new Date().toISOString(),
    count: byId.size,
    reportedTotal: reported,
    complete: byId.size >= reported,
    professors: [...byId.values()].sort((a, b) => a.lastName.localeCompare(b.lastName)),
  };

  // download the JSON
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rmp_ucsd.json";
  a.click();
  console.log(`DONE — ${out.count}/${out.reportedTotal} professors, complete=${out.complete}. Downloading rmp_ucsd.json`);
  window.__rmp = out; // also left on window in case the download is blocked
})();
