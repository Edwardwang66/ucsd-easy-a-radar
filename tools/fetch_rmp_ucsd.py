#!/usr/bin/env python3
"""
fetch_rmp_ucsd.py — scrape the full RateMyProfessors professor list for UC San Diego
(school 1079) into tools/rmp_ucsd.json.

The live search API rate-limits after a few dozen rapid queries, so matching 150+ names
against it one-by-one is unreliable (it returns empty and looks like "not on RMP" when the
professor is actually there — e.g. Mihir Bellare, whose RMP entry even has first/last name
swapped). Pulling the whole ~4,000-professor list once, locally, makes matching reliable,
department-aware, and reproducible. tools/ is in .vercelignore, so this never ships.

USAGE:  python3 tools/fetch_rmp_ucsd.py
"""
import json, time, urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent / "rmp_ucsd.json"
GQL = "https://www.ratemyprofessors.com/graphql"
AUTH = "Basic dGVzdDp0ZXN0"          # RMP public site token (test:test)
SCHOOL = "U2Nob29sLTEwNzk="          # base64 "School-1079" (UC San Diego)
PAGE = 100
QUERY = """query T($q: TeacherSearchQuery!, $first: Int!, $after: String){
  newSearch{ teachers(query:$q, first:$first, after:$after){
    resultCount
    edges{ node{ firstName lastName legacyId avgRating avgDifficulty numRatings wouldTakeAgainPercent department } }
    pageInfo{ hasNextPage endCursor }
  }}}"""


def gql(after):
    body = {"query": QUERY, "variables": {"q": {"text": "", "schoolID": SCHOOL}, "first": PAGE, "after": after}}
    req = urllib.request.Request(
        GQL, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": AUTH, "User-Agent": "Mozilla/5.0"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                t = json.load(r)["data"]["newSearch"]["teachers"]
                if t and t["edges"]:
                    return t
        except Exception:
            pass
        time.sleep(2 * (attempt + 1))   # back off on throttle/errors
    return None


def main():
    profs, seen, after, total = [], set(), "", None
    while True:
        t = gql(after)
        if t is None:
            print(f"  stopped early after {len(profs)} (page fetch failed)")
            break
        total = t["resultCount"]
        for e in t["edges"]:
            n = e["node"]
            if n["legacyId"] in seen:
                continue
            seen.add(n["legacyId"])
            wta = n["wouldTakeAgainPercent"]
            profs.append({
                "id": n["legacyId"], "first": n["firstName"], "last": n["lastName"],
                "dept": n["department"], "n": n["numRatings"],
                "q": n["avgRating"], "d": n["avgDifficulty"],
                "wta": round(wta) if wta is not None and wta >= 0 else None,
            })
        print(f"  {len(profs)}/{total}")
        if not t["pageInfo"]["hasNextPage"]:
            break
        after = t["pageInfo"]["endCursor"]
        time.sleep(0.5)
    OUT.write_text(json.dumps({"school": 1079, "count": len(profs), "profs": profs},
                              ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT.name}: {len(profs)} professors (RMP reported {total})")


if __name__ == "__main__":
    main()
