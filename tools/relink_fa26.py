#!/usr/bin/env python3
"""
relink_fa26.py — recompute the Fall-2026 current-instructor linkage in data.json.

WHAT IT DOES
------------
Grade records ("Cao, Yingjun") and the WebReg FA26 catalog ("Paul Cao") name the
same professors in different ways, and neither source carries a stable UCSD
instructor id — only a name string. This script resolves catalog names to
grade-history professors and rewrites three derived fields in place:

  * recs[.cur]  — 1 when a grade row's professor is teaching that course in FA26
  * alias       — catalog-name -> [surname, first-initial] for professors who
                  appear under a different name in the catalog than in grades
  * newProf     — FA26 instructors with no grade history (first term at UCSD)

It also appends synthetic "first-term" rows (src == 2) so those professors show
up in the main table — no GPA, marked 0x, sorted last.

THE MATCHING LADDER (precision-first; see docs/name-matching.md for the writeup)
------------------------------------------------------------------------------
  L1 normalise      strip accents, collapse space, unify "Last, First" vs "First Last"
  L2 compound       try both the last token AND the full trailing surname
                    ("Di Ventra" as well as "Ventra")
  L3 initials       match on the first OR any middle initial, so professors who
                    go by a middle name link automatically
                    ("Ryan Wagner" <- "Wagner, Timothy Ryan")
  L4 auto-alias     for names still unmatched, if a same-surname grade professor
                    taught the EXACT course now assigned, treat them as the same
                    person (course overlap is a strong disambiguator). Applied
                    automatically; every application is logged.
  L5 manual         MANUAL_ALIAS below — the irreducible residue: a rename with no
                    course overlap (e.g. a transliteration teaching a new course).
                    Kept tiny and human-confirmed.

Anything matched by surname+subject but NOT by an exact course is printed as a
REVIEW candidate, not applied — that is the only recurring human step.

USAGE
-----
  python3 tools/relink_fa26.py            # rewrite data.json, print a report
  python3 tools/relink_fa26.py --dry-run  # report only, write nothing
"""
import json, re, sys, unicodedata
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data.json"

# L5 — manual aliases: catalog display name -> grade-history full name.
# Only for renames that L1-L4 cannot reach (no shared course to lean on).
# Confirmed by hand; keep this list as small as possible.
MANUAL_ALIAS = {
    "Yiorgos Makris": "Makris, Georgios V",     # Greek transliteration; teaches ECE 299 (grad), grades under ECE 25
    "Zeinab Jahed": "Jahed Motlagh, Zeinab",    # same NANO professor; second family name dropped, no shared course
}

# L6 — manual blocks: (catalog name, grade name) pairs that share a surname + initial but are
# DIFFERENT people (namesakes). Matching would otherwise falsely tag the grade professor
# "Teaching now". The REVIEW report below surfaces candidates; confirmed namesakes go here.
MANUAL_BLOCK = {
    ("Michael McKay", "McKay, Mary A"),   # MGT: Michael (FA26) ≠ Mary (grades), same surname+initial
}


def deacc(s):
    return "".join(c for c in unicodedata.normalize("NFD", str(s or "")) if unicodedata.category(c) != "Mn")


def collapse(s):
    return re.sub(r"\s+", " ", str(s or "")).strip()


def split_name(nm):
    """Return (surname_lowercased, [given tokens]) handling both name orders."""
    n = collapse(deacc(nm))
    if not n:
        return "", []
    if "," in n:
        last, rest = n.split(",", 1)
        return collapse(last).lower(), collapse(rest).split()
    p = n.split()
    if len(p) < 2:
        return "", []
    return p[-1].lower(), p[:-1]


def despace(s):
    """Collapse a surname to bare letters so 'Mc Culloch' == 'McCulloch', "O'Connor" == 'O Connor'."""
    return re.sub(r"[^a-z0-9]", "", str(s).lower())


def grade_keys(nm):
    """Grade side: {surname, despaced surname} x {first initial, each middle initial}  (L1+L3)."""
    last, given = split_name(nm)
    if not last or not given:
        return set()
    inits = [t[0].lower() for t in given if t and t[0].isalpha()]
    surs = {last, despace(last)}
    return {(s, i) for s in surs for i in inits}


def primary_key(nm):
    """The single canonical (surname, first-given-initial) key for a grade name."""
    last, given = split_name(nm)
    for t in given:
        if t and t[0].isalpha():
            return (last, t[0].lower())
    return None


def catalog_keys(name):
    """Catalog side: {last token, full trailing surname, their despaced forms} x first initial (L1+L2)."""
    n = collapse(deacc(name))
    if not n:
        return set()
    if "," in n:
        return grade_keys(name)
    p = n.split()
    if len(p) < 2:
        return set()
    ini = p[0][0].lower()
    last, full = p[-1].lower(), " ".join(p[1:]).lower()
    return {(s, ini) for s in {last, full, despace(last), despace(full)}}


def subj(course):
    return course.split()[0]


def main(dry=False):
    d = json.loads(DATA.read_text())
    C = {c: i for i, c in enumerate(d["cols"])}

    # Drop any synthetic first-term rows from a previous run so this is idempotent.
    keep = [i for i, r in enumerate(d["recs"]) if r[C["src"]] != 2]
    d["recs"] = [d["recs"][i] for i in keep]
    if d.get("hist"):
        d["hist"] = [d["hist"][i] for i in keep]

    # --- indexes over the real grade rows ---
    # Name particles that are never a standalone family name — don't index on them.
    PARTICLE = {"de", "di", "da", "del", "della", "la", "le", "van", "von", "el",
                "al", "dos", "das", "bin", "ibn", "san", "st", "st.", "ii", "iii", "jr", "jr.", "sr"}

    def surname_tokens(nm):
        """Meaningful surname anchors: the full compound plus its first & last real tokens."""
        last, _ = split_name(nm)
        if not last:
            return set()
        toks = [t for t in last.split() if t not in PARTICLE] or last.split()
        return {last, toks[0], toks[-1], despace(last)}

    g_key_set = set()                 # every grade key that exists
    g_courses, g_count = {}, {}       # full name -> {courses}, -> record count
    g_by_surname = {}                 # surname-anchor -> [full names]
    for r in d["recs"]:
        nm = r[C["i"]] or ""
        for k in grade_keys(nm):
            g_key_set.add(k)
        course = f"{r[C['s']]} {r[C['c']]}"
        g_courses.setdefault(nm, set()).add(course)
        g_count[nm] = g_count.get(nm, 0) + 1
        for sv in surname_tokens(nm):
            g_by_surname.setdefault(sv, []).append(nm)

    fa_courses = {}                   # fa name -> {assigned courses}
    for course, names in d["fa"].items():
        for n in names:
            fa_courses.setdefault(n, set()).add(course)

    def initial_matches(fa_name):
        return bool(catalog_keys(fa_name) & g_key_set)

    # --- L4 auto-alias + L5 manual + REVIEW discovery ---
    alias = {}          # catalog name -> [surname, initial] grade key
    applied, review = [], []
    for name in sorted(fa_courses):
        if name in MANUAL_ALIAS:
            alias[name] = list(primary_key(MANUAL_ALIAS[name]))
            applied.append(("L5-manual", name, MANUAL_ALIAS[name], sorted(fa_courses[name])))
            continue
        if initial_matches(name):
            continue                                   # L1-L3 already link this person
        facs = fa_courses[name]
        best = None                                    # (exact_overlap, subj_overlap, records, full_name)
        # catalog surname anchors: full trailing surname + its first & last real tokens
        cat_toks = collapse(deacc(name)).split()
        cat_sur = cat_toks[1:] if len(cat_toks) >= 2 else []
        cat_real = [t.lower() for t in cat_sur if t.lower() not in PARTICLE] or [t.lower() for t in cat_sur]
        cat_full = " ".join(cat_sur).lower()
        cat_anchors = {cat_full, despace(cat_full), *cat_real} if cat_sur else set()
        cand_names = {g for sv in cat_anchors for g in g_by_surname.get(sv, [])}
        for g in sorted(cand_names):
            if True:
                exact = len(facs & g_courses[g])
                so = len({subj(x) for x in facs} & {subj(x) for x in g_courses[g]})
                if exact or so:
                    cand = (exact, so, g_count[g], g)
                    if best is None or cand > best:
                        best = cand
        if best and best[0] > 0:                       # shares an EXACT course -> apply
            g = best[3]
            alias[name] = list(primary_key(g))
            applied.append(("L4-course", name, g, sorted(facs)))
        elif best and best[1] > 0:                     # same subject only -> human review
            review.append((name, best[3], sorted(facs), sorted(g_courses[best[3]])[:4]))
        # else: no surname/subject overlap -> genuine first-timer (handled below)

    # --- matching primitives (alias-aware + block-aware) ---
    def fa_keyset(name):
        return {tuple(alias[name])} if name in alias else catalog_keys(name)

    def pair_matches(fa_name, grade_name):
        if (fa_name, grade_name) in MANUAL_BLOCK:   # confirmed namesake, never link
            return False
        return bool(fa_keyset(fa_name) & grade_keys(grade_name))

    # grade key -> set of grade names, so block checks can look up who supplied a match
    g_names_by_key = {}
    for r in d["recs"]:
        nm = r[C["i"]] or ""
        for k in grade_keys(nm):
            g_names_by_key.setdefault(k, set()).add(nm)

    # --- recompute cur: a grade row is "teaching now" iff some non-blocked FA26 instructor of
    #     that course links to it ---
    cur = 0
    for r in d["recs"]:
        course = f"{r[C['s']]} {r[C['c']]}"
        gname = r[C["i"]] or ""
        hit = bool(r[C["off"]]) and any(pair_matches(f, gname) for f in d["fa"].get(course, []))
        r[C["cur"]] = 1 if hit else 0
        cur += r[C["cur"]]

    # --- first-timers: FA26 instructors with no (non-blocked) grade-history link at all ---
    def resolves(name):
        cands = set()
        for k in fa_keyset(name):
            cands |= g_names_by_key.get(k, set())
        return any((name, g) not in MANUAL_BLOCK for g in cands)

    new_prof = sorted({n for n in fa_courses if not resolves(n)})

    # --- synthetic first-term rows (src == 2): one per (first-timer, course) ---
    # borrow title index + level from an existing row of the course, else from the
    # schedule catalog; append aligned empty history so the detail view stays valid.
    sched = {}
    sp = DATA.parent / "schedule.json"
    if sp.exists():
        sched = json.loads(sp.read_text()).get("courses", {})
    course_meta = {}                 # "SUBJ NUM" -> (title_index, level)
    for r in d["recs"]:
        course_meta.setdefault(f"{r[C['s']]} {r[C['c']]}", (r[C["t"]], r[C["lv"]]))
    titles = d["titles"]
    title_ix = {t: i for i, t in enumerate(titles)}

    def course_title_level(code, subject, num):
        if code in course_meta:
            return course_meta[code]
        t = sched.get(code, {}).get("t", "")
        if t:
            if t not in title_ix:
                title_ix[t] = len(titles)
                titles.append(t)
            ti = title_ix[t]
        else:
            ti = -1
        digits = re.sub(r"\D", "", str(num)) or "0"
        return ti, int(digits)

    # RMP ratings for first-timers, cached by tools/fetch_rmp_firsttime.py (no grade rows to
    # ride the normal join, so they're looked up by name directly).
    rmp_cache = {}
    rmp_path = Path(__file__).resolve().parent / "rmp_firsttime.json"
    if rmp_path.exists():
        rmp_cache = json.loads(rmp_path.read_text())
    rmp_hits = 0

    ncol = len(d["cols"])
    added = 0
    for name in new_prof:
        rmp = rmp_cache.get(name)
        for code in sorted(fa_courses[name]):
            s, num = code.split(" ", 1)
            ti, lv = course_title_level(code, s, num)
            row = [None] * ncol
            row[C["s"]], row[C["c"]], row[C["t"]], row[C["i"]] = s, num, ti, name
            row[C["n"]] = 0
            row[C["off"]] = 1
            row[C["lv"]] = lv
            row[C["src"]] = 2          # first-term instructor, no grade data
            row[C["cur"]] = 1          # teaching this term
            if rmp:                    # attach RMP rating if a strict match was cached
                row[C["rq"]], row[C["rd"]] = rmp.get("rq"), rmp.get("rd")
                row[C["rw"]], row[C["rn"]], row[C["rid"]] = rmp.get("rw"), rmp.get("rn"), rmp.get("rid")
            d["recs"].append(row)
            if d.get("hist") is not None:
                d["hist"].append([])   # keep hist parallel to recs
            added += 1
        if rmp:
            rmp_hits += 1

    # --- namesake review: cur=1 links where the FA26 first name only shares an INITIAL (not a
    #     full given token) with the grade record. Most are nicknames (Tim↔Timothy) and fine;
    #     the odd one is a different person sharing surname+initial → add it to MANUAL_BLOCK. ---
    def _first(nm):
        n = collapse(deacc(nm))
        if "," in n:
            r = collapse(n.split(",", 1)[1])
            return r.split()[0].lower() if r else ""
        p = n.split()
        return p[0].lower() if p else ""

    namesakes, seen_ns = [], set()
    for r in d["recs"]:
        if r[C["src"]] != 0 or r[C["cur"]] != 1:
            continue
        course = f"{r[C['s']]} {r[C['c']]}"
        gname = r[C["i"]] or ""
        for f in d["fa"].get(course, []):
            if f in alias or (f, gname) in MANUAL_BLOCK or not pair_matches(f, gname):
                continue
            ff = _first(f)
            gv = [t.lower() for t in split_name(gname)[1]]
            if ff and ff not in gv and (f, gname) not in seen_ns:
                seen_ns.add((f, gname))
                namesakes.append((course, gname, f))

    # --- meta + serialise ---
    d["alias"] = {k: v for k, v in sorted(alias.items())}
    d["block"] = [list(p) for p in sorted(MANUAL_BLOCK)]
    d["newProf"] = new_prof
    d["meta"]["fa26CurrentRows"] = cur
    d["meta"]["fa26Aliases"] = len(alias)
    d["meta"]["fa26FirstTime"] = len(new_prof)
    d["meta"]["fa26FirstTimeRows"] = added

    # --- report ---
    print(f"cur=1 rows           : {cur}")
    print(f"aliases resolved     : {len(alias)}  ({sum(1 for a in applied if a[0]=='L4-course')} auto / "
          f"{sum(1 for a in applied if a[0]=='L5-manual')} manual)")
    for tag, name, g, facs in applied:
        print(f"   [{tag}] {name:26} -> {g:28} {facs}")
    print(f"first-time instructors: {len(new_prof)}  (+{added} synthetic rows)")
    print(f"  with an RMP match   : {rmp_hits}"
          + ("" if rmp_cache else "  (run tools/fetch_rmp_firsttime.py to populate)"))
    print(f"blocked namesakes     : {len(MANUAL_BLOCK)}")
    if review:
        print(f"\nREVIEW aliases — same surname & subject but no shared course ({len(review)}); "
              f"add to MANUAL_ALIAS only if truly the same person:")
        for name, g, facs, gc in review:
            print(f"   ? {name:26} ?= {g:28} fa={facs} grades={gc}")
    if namesakes:
        print(f"\nVERIFY namesakes — cur=1 links matched on surname+initial with a differently "
              f"spelled first name ({len(namesakes)}). Nicknames are fine; block true namesakes:")
        for course, g, f in namesakes:
            print(f"   ~ {course:11} {g:32} <- FA26 {f!r}")

    if dry:
        print("\n--dry-run: data.json NOT written")
        return
    DATA.write_text(json.dumps(d, ensure_ascii=False, separators=(",", ":")))
    print(f"\nwrote {DATA} (recs now {len(d['recs'])})")


if __name__ == "__main__":
    main(dry="--dry-run" in sys.argv)
