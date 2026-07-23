#!/usr/bin/env python3
"""
fetch_rmp_ucsd.py — scrape every RateMyProfessors professor for UC San Diego
(school 1079) and dump them to tools/rmp_ucsd.json.

This is the automated version of sitting on the RMP school page and clicking
"Show More" until the list is exhausted. RMP's "Show More" is really cursor
pagination over a GraphQL endpoint, so each "click" = one page(after=cursor)
call. We loop that until hasNextPage is false.

Pass 1 (the Show-More loop) usually lands a hair under the reported total,
because RMP's paged stream repeats a few rows near page boundaries and we
de-dupe by id. Pass 2 fills the gap: it re-runs the same Show-More loop seeded
with each letter/digit ("a", "b", …) — a different slice of the index each time
— and unions anything new, until we hit the reported count or run out of seeds.
Everything de-dupes by legacyId, so passes can overlap freely.

Why not just hit the live search per name? It rate-limits after a few dozen
rapid queries and starts returning empty — which looks like "not on RMP" when
the professor is right there. Pulling the whole roster once, locally, makes
downstream matching reliable. tools/ is in .vercelignore, so this never ships.

USAGE:  python3 tools/fetch_rmp_ucsd.py
"""
import json, string, time, urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent / "rmp_ucsd.json"
GQL = "https://www.ratemyprofessors.com/graphql"
AUTH = "Basic dGVzdDp0ZXN0"          # RMP public site token (test:test)
SCHOOL = "U2Nob29sLTEwNzk="          # base64 "School-1079" (UC San Diego)
PAGE = 1000                          # ask big; RMP caps the real page size itself
QUERY = """query T($q: TeacherSearchQuery!, $first: Int!, $after: String){
  newSearch{ teachers(query:$q, first:$first, after:$after){
    resultCount
    edges{ node{ firstName lastName legacyId avgRating avgDifficulty numRatings wouldTakeAgainPercent department } }
    pageInfo{ hasNextPage endCursor }
  }}}"""


def call(text, after):
    """One 'Show More' click: fetch a page, with backoff on throttle/errors."""
    body = {"query": QUERY, "variables": {"q": {"text": text, "schoolID": SCHOOL}, "first": PAGE, "after": after}}
    req = urllib.request.Request(
        GQL, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": AUTH, "User-Agent": "Mozilla/5.0"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                t = json.load(r)["data"]["newSearch"]["teachers"]
                if t is not None:
                    return t
        except Exception:
            pass
        time.sleep(2 ** attempt)          # 1,2,4,8,16,32s
    return None


def show_more_loop(text, profs, label):
    """Keep clicking Show More for one search `text` until there's no next page.
    Adds any professor not already seen (keyed by legacyId). Returns resultCount."""
    after, total, pages = "", None, 0
    while True:
        t = call(text, after)
        if t is None:
            print(f"    [{label}] page fetch failed — stopping this seed")
            break
        total = t["resultCount"]
        for e in t["edges"]:
            n = e["node"]
            if n["legacyId"] in profs:
                continue
            wta = n["wouldTakeAgainPercent"]
            profs[n["legacyId"]] = {
                "id": n["legacyId"], "first": n["firstName"], "last": n["lastName"],
                "dept": n["department"], "n": n["numRatings"],
                "q": n["avgRating"], "d": n["avgDifficulty"],
                "wta": round(wta) if wta is not None and wta >= 0 else None,
            }
        pages += 1
        if not t["pageInfo"]["hasNextPage"]:
            break
        after = t["pageInfo"]["endCursor"]
        time.sleep(0.4)
    return total


def main():
    profs = {}
    # Pass 1 — the plain Show-More loop over the whole school.
    print("Pass 1: Show More over the full roster …")
    target = show_more_loop("", profs, "all") or 0
    print(f"  pass 1 collected {len(profs)}/{target}")

    # Pass 2 — fill the de-dupe gap by re-seeding the loop with each letter/digit.
    if len(profs) < target:
        print(f"Pass 2: filling {target - len(profs)} missing via seeded Show-More sweeps …")
        for seed in string.ascii_lowercase + string.digits:
            if len(profs) >= target:
                break
            before = len(profs)
            show_more_loop(seed, profs, seed)
            if len(profs) != before:
                print(f"  seed '{seed}': +{len(profs) - before}  (total {len(profs)}/{target})")
            time.sleep(0.2)

    out = sorted(profs.values(), key=lambda p: (p["last"] or "", p["first"] or ""))
    OUT.write_text(json.dumps({"school": 1079, "count": len(out), "reported": target, "profs": out},
                              ensure_ascii=False, separators=(",", ":")))
    print(f"\nDONE — wrote {OUT.name}: {len(out)} professors (RMP reported {target})")


if __name__ == "__main__":
    main()
