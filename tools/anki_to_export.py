#!/usr/bin/env python3
"""Convert an Anki ``.colpkg`` backup to the verse-vault account-export
JSON format (``packages/api/src/lib/export-format.ts`` v1).

The output is the same JSON shape ``GET /api/export`` produces, so it
can be uploaded directly to ``POST /api/import`` to seed a new account
from years of Anki review history.

Reuses ``extract_collection`` and ``parse_clubs`` from
``tools/audit_colpkg.py``, ``parse_reference`` from
``tools/phrase_splitter/helpers.py``.

Usage:

    python3 tools/anki_to_export.py <colpkg> \\
        --material nkjv-cor --deck data/3-corinthians.json \\
        [--material nkjv-john --deck data/4-john.json ...] \\
        --user-email you@example.com --user-name 'Your Name' \\
        --out export.json

Each ``--material`` pairs with the immediately preceding or following
``--deck``; pairs may be given in either order. One pass produces ONE
export.json covering every material whose deck was provided. Notes that
don't resolve in any deck are skipped (counted at the end).

Read-only against the colpkg. Does not need a running api server.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from audit_colpkg import (  # noqa: E402
    ANKI_FIELD_SEP,
    extract_collection,
    open_collection_db,
    parse_clubs,
)
from phrase_splitter.helpers import parse_reference  # noqa: E402

EXPORT_VERSION = 1

# Verse-note template ords → CardRef kind (with FTV's withCitation default).
# The Anki "Verse" notetype has three templates in this order:
#   ord 0 "Reference" → Citation in verse-vault (just the citation card).
#   ord 1 "Quote"     → Recitation (verse text on the back).
#   ord 2 "FTV"       → Ftv (first three words / typing test).
VERSE_ORD_TO_KIND = {0: "Citation", 1: "Recitation", 2: "Ftv"}

# Anki revlog.ease → FSRS grade (1=Again, 2=Hard, 3=Good, 4=Easy).
# Same numbering on both sides, so this is identity for valid grades.
# ease=0 marks manual reschedule / cram and is filtered out upstream.
EASE_TO_GRADE = {1: 1, 2: 2, 3: 3, 4: 4}

# Anki revlog.type:
#   0 = learn, 1 = review, 2 = relearn, 3 = cram, 4 = manual reset
# verse-vault has no notion of "manual reset" so type=4 rows are
# dropped. Cram/filtered grading (type=3) is also dropped since the
# user wasn't grading against schedule; their FSRS state is in (0,1,2).
REVLOG_TYPES_TO_KEEP = (0, 1, 2)

# Anki cards.queue values:
#   -3 user-buried, -2 sched-buried, -1 suspended,
#    0 new, 1 learning, 2 review, 3 day-learn/relearn, 4 preview
# Cards in queue >= 2 are "graduated" enough that the user has the verse
# in long-term review rotation, which is the user's graduation criterion.
GRADUATED_QUEUES = (2, 3)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("colpkg", help="path to the Anki .colpkg backup")
    p.add_argument(
        "--material",
        action="append",
        required=True,
        dest="materials",
        help="verse-vault materialId; pair with --deck",
    )
    p.add_argument(
        "--deck",
        action="append",
        required=True,
        dest="decks",
        help="path to the corresponding data/<N>-<book>.json",
    )
    p.add_argument("--user-email", required=True)
    p.add_argument("--user-name", required=True)
    p.add_argument("--out", required=True, help="path to write export.json")
    return p.parse_args()


def load_deck(path: str) -> Dict[str, Any]:
    with open(path) as f:
        return json.load(f)


def build_verse_index(deck: Dict[str, Any]) -> Dict[Tuple[str, int, int], int]:
    """``(book, chapter, verse) → verseId``. The deck's ``verses`` array
    index IS the verseId (confirmed against the Rust builder)."""
    out: Dict[Tuple[str, int, int], int] = {}
    for i, v in enumerate(deck["verses"]):
        out[(v["book"], v["chapter"], v["verse"])] = i
    return out


def build_heading_index(
    deck: Dict[str, Any],
) -> Dict[Tuple[str, int, int], int]:
    """``(book, startChapter, startVerse) → headingIdx``. The deck's
    ``headings`` array index IS the headingIdx — see crates/core."""
    out: Dict[Tuple[str, int, int], int] = {}
    for i, h in enumerate(deck["headings"]):
        out[(h["book"], h["startChapter"], h["startVerse"])] = i
    return out


# --- field parsers ------------------------------------------------------------

# Heading-note Sort field looks like "2-01-001-018,001-025": that's
# year-book-chapter-startVerse,endChapter-endVerse. We only need the
# (chapter, startVerse) pair to key into the deck's headings array.
_HEADING_SORT_RE = re.compile(r"^\d+-\d+-(\d+)-(\d+),")

# Key-Verse-List Chapter field looks like "Luke 1 (150)". The tier in
# parens is duplicated in the club field, but we read the chapter
# number out of here and trust the club field for the tier.
_KVL_CHAPTER_RE = re.compile(r"^(.+?)\s+(\d+)\s*\(\d+\)\s*$")


def parse_heading_fields(flds: str) -> Optional[Tuple[str, int, int]]:
    """Return ``(book, startChapter, startVerse)`` for a Heading note,
    or None if the fields don't parse. Heading notes have:
        [Sort, Front, Back, Add Reverse]
    Front is the book name (trailing space in real data); Sort encodes
    the verse range."""
    parts = flds.split(ANKI_FIELD_SEP)
    if len(parts) < 4:
        return None
    sort, front, _back, _rev = parts[:4]
    m = _HEADING_SORT_RE.match(sort)
    if not m:
        return None
    book = front.strip()
    if not book:
        return None
    return book, int(m.group(1)), int(m.group(2))


def parse_kvl_fields(flds: str) -> Optional[Tuple[str, int, int]]:
    """Return ``(book, chapter, tier)`` for a Key-Verse-List note. KVL
    notes have:
        [Sort, Chapter, Verses, club]
    Chapter encodes book + chapter + tier; club is the bare tier."""
    parts = flds.split(ANKI_FIELD_SEP)
    if len(parts) < 4:
        return None
    _sort, chapter_field, _verses, club_field = parts[:4]
    m = _KVL_CHAPTER_RE.match(chapter_field)
    if not m:
        return None
    book = m.group(1).strip()
    chapter = int(m.group(2))
    tiers = parse_clubs(club_field)
    if not tiers:
        return None
    return book, chapter, tiers[0]


def parse_verse_fields(flds: str) -> Optional[Tuple[str, int, int]]:
    """Return ``(book, chapter, verse)`` for a Verse note. Verse notes
    have ``[Sort, Ref, Text, FTV, club]`` — we only need ``Ref``."""
    parts = flds.split(ANKI_FIELD_SEP)
    if len(parts) < 2:
        return None
    try:
        return parse_reference(parts[1])
    except ValueError:
        return None


def tier_name(n: int) -> str:
    """Map an Anki club number to the CardRef ``tier`` string
    (``Club150`` / ``Club300``). Returns an empty string for club
    numbers the wire format doesn't recognise; the caller treats that
    as falsy and drops the event."""
    if n == 150:
        return "Club150"
    if n == 300:
        return "Club300"
    return ""


# Running graduation-timestamp state for a single card: (ts, passed).
# `ts` is the chosen graduation timestamp so far; `passed` records
# whether it came from a passing (grade≥3) row, which locks it in.
GradState = Tuple[Optional[int], bool]


def fold_graduation_ts(state: GradState, ts: int, grade: int) -> GradState:
    """Fold one revlog row into a card's graduation-timestamp state,
    given rows arrive in ascending-time order.

    Rule: the graduation moment is the *earliest passing* review
    (grade≥3) — that's when the card left learning for review rotation.
    Until a pass is seen, track the latest row so a card that reached
    queue≥2 without any recorded pass still falls back to its most
    recent activity rather than its first.
    """
    current, passed = state
    if passed:
        # Earliest pass already locked in; nothing later can improve it.
        return current, True
    if grade >= 3:
        return ts, True
    # No pass yet — keep advancing the fallback to the latest row.
    return ts, False


# --- main conversion ----------------------------------------------------------


def read_col_mod(con: sqlite3.Connection) -> int:
    row = con.execute("SELECT mod FROM col").fetchone()
    return int(row[0]) if row else 0


def resolve_note(
    notetype: str,
    ord_: int,
    flds: str,
    verse_indexes: Dict[str, Dict[Tuple[str, int, int], int]],
    heading_indexes: Dict[str, Dict[Tuple[str, int, int], int]],
) -> Optional[Tuple[str, Dict[str, Any]]]:
    """Translate one Anki (notetype, ord, flds) tuple to
    ``(materialId, CardRef)``. Returns None if the note doesn't map to
    a verse-vault card in any of the provided decks."""
    if notetype == "Verse":
        ref = parse_verse_fields(flds)
        if ref is None:
            return None
        for material_id, index in verse_indexes.items():
            verse_id = index.get(ref)
            if verse_id is None:
                continue
            kind = VERSE_ORD_TO_KIND.get(ord_)
            if kind is None:
                return None
            card_ref: Dict[str, Any] = {"kind": kind, "verseId": verse_id}
            if kind == "Ftv":
                # The Anki FTV card has no citation showing; treat as
                # withCitation=false. (verse-vault has both variants;
                # the import resolver only matches the explicit one.)
                card_ref["withCitation"] = False
            return material_id, card_ref
        return None

    if notetype == "Heading":
        parsed = parse_heading_fields(flds)
        if parsed is None:
            return None
        for material_id, index in heading_indexes.items():
            heading_idx = index.get(parsed)
            if heading_idx is None:
                continue
            # Both Heading template ords (0 Card 1, 1 Card 2) collapse
            # to the same HeadingPassage CardRef in verse-vault. The
            # clientEventId per Anki revlog row stays unique, so the
            # double-emit gets dedup'd naturally on the verse-vault
            # side via the unique (user, material, clientEventId) idx.
            return material_id, {"kind": "HeadingPassage", "headingIdx": heading_idx}
        return None

    if notetype == "Key Verse List":
        parsed = parse_kvl_fields(flds)
        if parsed is None:
            return None
        book, chapter, tier_num = parsed
        tier = tier_name(tier_num)
        if not tier:
            return None
        for material_id, index in verse_indexes.items():
            # KVL doesn't have a verse to look up — we just confirm the
            # book is present in this deck before claiming it.
            if any(b == book for (b, _c, _v) in index):
                return material_id, {
                    "kind": "ChapterClubList",
                    "book": book,
                    "chapter": chapter,
                    "tier": tier,
                }
        return None

    return None


def build_export(
    db_path: str,
    materials: Dict[str, str],
    user_email: str,
    user_name: str,
) -> Tuple[Dict[str, Any], Dict[str, int]]:
    """Read the colpkg DB and assemble the AccountExport JSON. Returns
    ``(payload, counters)``. Counters cover skip / drop / accept rates
    so the caller can print a summary."""
    decks = {mid: load_deck(path) for mid, path in materials.items()}
    verse_indexes = {mid: build_verse_index(d) for mid, d in decks.items()}
    heading_indexes = {mid: build_heading_index(d) for mid, d in decks.items()}

    con = open_collection_db(db_path)
    col_mod = read_col_mod(con)

    # cid → (materialId, CardRef) once resolved; cache so we don't
    # re-resolve per revlog row. Keyed by *card* id, not note id: a
    # Verse note fans out to three cards (ord 0/1/2 → Citation /
    # Recitation / Ftv) that share one nid but resolve to distinct
    # CardRefs, so caching per-nid would mislabel two of the three.
    card_resolution: Dict[int, Optional[Tuple[str, Dict[str, Any]]]] = {}
    # (materialId, JSON-of-cardRef) → GradState. Folded per revlog row
    # via `fold_graduation_ts`: earliest passing (grade≥3) review wins,
    # else the latest row. Reduced to a bare ts in the promote step.
    graduations_per_material: Dict[str, Dict[str, GradState]] = {mid: {} for mid in materials}
    # (materialId, verseId) → graduatedAtSecs
    verse_graduations: Dict[str, Dict[int, int]] = {mid: {} for mid in materials}
    # materialId → list of {clientEventId, timestampSecs, cardRef, grade}
    events_per_material: Dict[str, List[Dict[str, Any]]] = {mid: [] for mid in materials}

    counters = {
        "revlog_total": 0,
        "revlog_skipped_unmapped": 0,
        "revlog_skipped_bad_grade": 0,
        "revlog_skipped_type": 0,
        "graduated_verses": 0,
        "graduated_cards": 0,
        "events_emitted": 0,
    }

    # Per-note "any-card-graduated?" preflight: gather the set of nids
    # for which at least one card sits in queue>=2. Used for both the
    # per-card graduation emission and the per-verse "graduate the
    # whole verse if any of its 3 cards graduated" rule.
    cur = con.execute(
        """
        SELECT c.nid, c.id, c.queue, c.ord, n.mid, m.name AS notetype, n.flds
        FROM cards c
        JOIN notes n ON n.id = c.nid
        JOIN notetypes m ON m.id = n.mid
        WHERE m.name IN ('Verse', 'Heading', 'Key Verse List')
        """
    )
    nid_to_meta: Dict[int, Tuple[str, str]] = {}
    cards_by_id: Dict[int, Dict[str, Any]] = {}
    nid_any_graduated: Dict[int, bool] = {}
    for nid, cid, queue, ord_, _mid, notetype, flds in cur:
        nid_to_meta[nid] = (notetype, flds)
        cards_by_id[cid] = {"nid": nid, "ord": ord_}
        if queue in GRADUATED_QUEUES:
            nid_any_graduated[nid] = True
        else:
            nid_any_graduated.setdefault(nid, False)

    # Stream the revlog. Order by id ASC so the first Good/Easy row we
    # see for a given (material, cardRef) is the earliest one — that's
    # the graduation timestamp.
    cur = con.execute(
        """
        SELECT id, cid, ease, type
        FROM revlog
        ORDER BY id ASC
        """
    )
    for revlog_id, cid, ease, rtype in cur:
        counters["revlog_total"] += 1
        if rtype not in REVLOG_TYPES_TO_KEEP:
            counters["revlog_skipped_type"] += 1
            continue
        grade = EASE_TO_GRADE.get(ease)
        if grade is None:
            counters["revlog_skipped_bad_grade"] += 1
            continue
        card = cards_by_id.get(cid)
        if card is None:
            counters["revlog_skipped_unmapped"] += 1
            continue
        nid = card["nid"]
        if cid not in card_resolution:
            notetype, flds = nid_to_meta[nid]
            card_resolution[cid] = resolve_note(
                notetype, card["ord"], flds, verse_indexes, heading_indexes
            )
        resolved = card_resolution[cid]
        if resolved is None:
            counters["revlog_skipped_unmapped"] += 1
            continue
        material_id, card_ref = resolved

        timestamp_secs = revlog_id // 1000
        events_per_material[material_id].append(
            {
                "clientEventId": f"anki:{col_mod}:{revlog_id}",
                "timestampSecs": timestamp_secs,
                "cardRef": card_ref,
                "grade": grade,
            }
        )
        counters["events_emitted"] += 1

        # If any card under this Anki note reached queue≥2, the note
        # graduated; fold this row into the card's running graduation-ts
        # state (earliest pass wins — see `fold_graduation_ts`).
        if nid_any_graduated.get(nid):
            ref_key = json.dumps(card_ref, sort_keys=True)
            by_ref = graduations_per_material[material_id]
            by_ref[ref_key] = fold_graduation_ts(
                by_ref.get(ref_key, (None, False)), timestamp_secs, grade
            )

    # Promote verse-bound graduated cards to a single graduatedVerses
    # entry per (material, verseId), per the user's rule: graduate the
    # whole verse if ANY of Reference/Quote/FTV reached queue≥2 in Anki.
    graduated_cards_per_material: Dict[str, List[Dict[str, Any]]] = {mid: [] for mid in materials}
    for material_id, by_ref in graduations_per_material.items():
        for ref_key, (ts, _passed) in by_ref.items():
            card_ref = json.loads(ref_key)
            kind = card_ref["kind"]
            if kind in ("Citation", "Recitation", "Ftv"):
                vid = card_ref["verseId"]
                existing = verse_graduations[material_id].get(vid)
                if existing is None or ts < existing:
                    verse_graduations[material_id][vid] = ts
            else:
                graduated_cards_per_material[material_id].append(
                    {"cardRef": card_ref, "graduatedAtSecs": ts}
                )
                counters["graduated_cards"] += 1

    counters["graduated_verses"] = sum(len(v) for v in verse_graduations.values())

    now_secs = int(time.time())
    payload: Dict[str, Any] = {
        "exportVersion": EXPORT_VERSION,
        "exportedAt": now_secs,
        "user": {"email": user_email, "name": user_name},
        "materials": [],
    }
    for material_id in materials:
        payload["materials"].append(
            {
                "materialId": material_id,
                "enrollment": {"clubTier": None, "offlineMode": False, "createdAt": now_secs},
                "settings": None,
                "snapshot": {"version": 1, "contentSha": ""},
                "graduatedVerses": [
                    {"verseId": vid, "graduatedAtSecs": ts}
                    for vid, ts in sorted(verse_graduations[material_id].items())
                ],
                "graduatedCards": graduated_cards_per_material[material_id],
                "reviewEvents": sorted(
                    events_per_material[material_id],
                    key=lambda e: (e["timestampSecs"], e["clientEventId"]),
                ),
            }
        )
    return payload, counters


def main() -> int:
    args = parse_args()
    if len(args.materials) != len(args.decks):
        sys.exit("--material and --deck must be passed the same number of times")
    materials = dict(zip(args.materials, args.decks))

    with tempfile.TemporaryDirectory(prefix="vv-anki-") as workdir:
        db_path = extract_collection(args.colpkg, workdir)
        payload, counters = build_export(
            db_path, materials, args.user_email, args.user_name
        )

    with open(args.out, "w") as f:
        json.dump(payload, f, indent=2)

    skipped = (
        counters["revlog_skipped_unmapped"]
        + counters["revlog_skipped_bad_grade"]
        + counters["revlog_skipped_type"]
    )
    print(
        f"wrote {args.out}: "
        f"{counters['events_emitted']} events, "
        f"{counters['graduated_verses']} verse graduations, "
        f"{counters['graduated_cards']} card graduations "
        f"(skipped {skipped}/{counters['revlog_total']} revlog rows: "
        f"{counters['revlog_skipped_type']} type, "
        f"{counters['revlog_skipped_bad_grade']} bad grade, "
        f"{counters['revlog_skipped_unmapped']} unmapped)",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
