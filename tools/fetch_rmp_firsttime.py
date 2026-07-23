#!/usr/bin/env python3
"""
fetch_rmp_firsttime.py — look up RateMyProfessors (UCSD, school 1079) for the first-time
instructors in data.json and cache strict matches to tools/rmp_firsttime.json.

First-time instructors have no grade history, so the normal RMP join (which rides on grade
rows) never reaches them. This queries RMP directly by name, and — because RMP's search is
fuzzy and full of namesakes — accepts a match ONLY when the surname matches (accent/space
insensitive) and the first name is compatible (equal / prefix / initial). Better no rating
than a wrong one.

relink_fa26.py reads the cache and writes rq/rd/rw/rn/rid onto the 0x rows. Re-run this
whenever the first-timer set changes; commit the cache so relink is reproducible offline.

USAGE:  python3 tools/fetch_rmp_firsttime.py
"""
import json, re, time, unicodedata, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data.json"
CACHE = Path(__file__).resolve().parent / "rmp_firsttime.json"
SCHOOL = "U2Nob29sLTEwNzk="  # base64 "School-1079" (UC San Diego)
GQL = "https://www.ratemyprofessors.com/graphql"
AUTH = "Basic dGVzdDp0ZXN0"  # RMP's public site token (test:test)


def deacc(s):
    return "".join(c for c in unicodedata.normalize("NFD", str(s or "")) if unicodedata.category(c) != "Mn")


def norm(s):
    return re.sub(r"[^a-z]", "", deacc(s).lower())


def compat_first(a, b):
    a, b = a.lower(), b.lower()
    if a == b:
        return True
    if len(a) == 1 or len(b) == 1:
        return a[0] == b[0]
    return a.startswith(b) or b.startswith(a)


def query(text):
    body = {
        "query": "query T($q: TeacherSearchQuery!){newSearch{teachers(query: $q){edges{node{"
                 "firstName lastName legacyId avgRating avgDifficulty numRatings wouldTakeAgainPercent}}}}}",
        "variables": {"q": {"text": text, "schoolID": SCHOOL}},
    }
    req = urllib.request.Request(
        GQL, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": AUTH, "User-Agent": "Mozilla/5.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r).get("data", {}).get("newSearch", {}).get("teachers", {}).get("edges", [])
        except Exception:
            if attempt == 2:
                return []
            time.sleep(2)


def main():
    d = json.loads(DATA.read_text())
    new_prof = d.get("newProf", [])
    out = {}
    for name in new_prof:
        toks = deacc(name).split()
        first, last, surtoks = toks[0], toks[-1], toks[1:]
        best = None
        for e in query(name):
            n = e["node"]
            rl = norm(n["lastName"])
            surok = rl in (norm(last), norm(" ".join(surtoks))) or norm(" ".join(surtoks)).endswith(rl) or rl.endswith(norm(last))
            if surok and compat_first(first, n["firstName"]) and (n["numRatings"] or 0) > 0:
                if best is None or n["numRatings"] > best["numRatings"]:
                    best = n
        if best:
            wta = best["wouldTakeAgainPercent"]
            out[name] = {
                "rid": best["legacyId"],
                "rq": best["avgRating"],
                "rd": best["avgDifficulty"],
                "rw": round(wta) if wta is not None and wta >= 0 else None,
                "rn": best["numRatings"],
                "rmpName": f'{best["firstName"]} {best["lastName"]}',
            }
            print(f'  OK  {name:26} -> RMP {out[name]["rmpName"]} (id {out[name]["rid"]}, '
                  f'{out[name]["rn"]} ratings, ★{out[name]["rq"]})')
        else:
            print(f'      {name:26} -> no UCSD RMP match')
        time.sleep(0.4)
    CACHE.write_text(json.dumps(out, ensure_ascii=False, indent=2, sort_keys=True))
    print(f"\nmatched {len(out)}/{len(new_prof)} first-timers; wrote {CACHE.name}")


if __name__ == "__main__":
    main()
