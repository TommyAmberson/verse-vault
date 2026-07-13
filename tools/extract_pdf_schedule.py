#!/usr/bin/env python3
"""Extract a season's schedule table from one of the Bible-quiz printable
PDFs (SK Corinthians, GEPC, NT Survey…) and emit the v2 schedule JSON the
API consumes at `data/schedules/<deck>-<season>.json`.

Usage:
    tools/extract_pdf_schedule.py <pdf> <deck> <season> <material_id>

Where:
    <pdf>          path to the printable PDF
    <deck>         file-name prefix, e.g. `1-gepc`
    <season>       season string as it appears on the file, e.g. `2023-24`
    <material_id>  matches server-side materialId, e.g. `nkjv-gepc`

The extractor shells out to `pdftotext -layout` and then parses the
laid-out text against a fixed row grammar. Compound weeks (passage
column contains `&` or a chapter-jumping `Ch - Ch:V` form; verse columns
carry a `|` separator) become multi-block weeks per spec §7. Meets are
parsed from the italicised weekend rows.

The material JSON at `data/<deck-name>.json` is consulted for two
things: the canonical book-name spellings and the number of verses per
chapter (so a whole-chapter passage's `endVerse` is exact).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

# Book abbreviation → canonical name, as the material JSONs spell them.
BOOK_ABBREV = {
    "gal": "Galatians",
    "eph": "Ephesians",
    "phil": "Philippians",
    "col": "Colossians",
    "1 cor": "1 Corinthians",
    "2 cor": "2 Corinthians",
    "matt": "Matthew",
    "acts": "Acts",
    "1 thess": "1 Thessalonians",
    "2 thess": "2 Thessalonians",
    "1 tim": "1 Timothy",
    "2 tim": "2 Timothy",
    "titus": "Titus",
    "philem": "Philemon",
    "1 john": "1 John",
    "2 john": "2 John",
    "3 john": "3 John",
    "jude": "Jude",
    "rev": "Revelation",
}

MONTHS = {
    "january": 1, "february": 2, "march": 3, "april": 4,
    "may": 5, "june": 6, "july": 7, "august": 8,
    "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7,
    "aug": 8, "sept": 9, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def canonical_book(name: str) -> str:
    """Normalise "Matt.", "matt", "1 Cor" → canonical book name."""
    k = name.strip().rstrip(".").lower()
    if k not in BOOK_ABBREV:
        raise ValueError(f"Unknown book abbreviation: {name!r}")
    return BOOK_ABBREV[k]


@dataclass
class ChapterFacts:
    """Verse counts per (book, chapter) drawn from the material JSON —
    lets whole-chapter passages resolve their endVerse exactly."""

    counts: dict[tuple[str, int], int] = field(default_factory=dict)

    @classmethod
    def load(cls, material_json: Path) -> "ChapterFacts":
        data = json.loads(material_json.read_text())
        counts: dict[tuple[str, int], int] = {}
        for v in data["verses"]:
            key = (v["book"], v["chapter"])
            counts[key] = max(counts.get(key, 0), v["verse"])
        return cls(counts=counts)

    def last_verse(self, book: str, chapter: int) -> int:
        v = self.counts.get((book, chapter))
        if v is None:
            raise ValueError(f"No verses in material for {book} {chapter}")
        return v


@dataclass
class Passage:
    book: str
    chapter: int
    start_verse: int
    end_verse: int

    def to_json(self) -> dict:
        return {
            "book": self.book,
            "chapter": self.chapter,
            "startVerse": self.start_verse,
            "endVerse": self.end_verse,
        }


@dataclass
class Block:
    passage: Passage
    club150: list[int]
    club300: list[int]

    def to_json(self) -> dict:
        return {
            "passage": self.passage.to_json(),
            "verses": {"club150": self.club150, "club300": self.club300},
        }


@dataclass
class Week:
    iso_date: str
    blocks: list[Block]
    is_review: bool

    def to_json(self) -> dict:
        if self.is_review:
            return {"date": self.iso_date, "blocks": [], "isReview": True}
        return {
            "date": self.iso_date,
            "blocks": [b.to_json() for b in self.blocks],
            "isReview": False,
        }


@dataclass
class Meet:
    id: str
    name: str
    start_date: str
    end_date: str
    location: str

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "startDate": self.start_date,
            "endDate": self.end_date,
            "location": self.location,
        }


def parse_verse_list(raw: str) -> list[int]:
    """Turn `"1, 6, 7, 10, 23"` (or `"1,6,7,10,23"`) into `[1,6,7,10,23]`."""
    raw = raw.strip()
    if not raw:
        return []
    return sorted({int(tok) for tok in re.split(r"[,\s]+", raw) if tok})


def parse_passage_column(raw: str, facts: ChapterFacts) -> list[Passage]:
    """Turn a passage-column cell into 1+ Passage objects.

    Handles:
        "1 Cor. 1:1-31"                     → single
        "1 Cor. 4 - 5:13"                   → 1 Cor 4 whole + 1 Cor 5:1-13
        "Matt. 1 & 2"                       → Matt 1 whole + Matt 2 whole
        "Matt 13 & 16"                      → non-adjacent whole chapters
        "1 Tim. 4 & 2 Tim. 3"               → cross-book
        "Titus 2 & 1 John 1"                → cross-book
        "Matt 5"                            → single whole chapter
        "Matt 27:1-31"                      → single chapter partial
    """
    raw = raw.strip()
    # Cross-book compound: literal "A & B" where A and B are each a
    # book+chapter cell. Detect by splitting on ` & ` and checking each
    # side has its own book. Otherwise treat `&` as "same-book multiple
    # chapters".
    if " & " in raw:
        left, right = raw.split(" & ", 1)
        left_p = _parse_book_chapter_partial(left, facts, default_book=None)
        # Right side: does it lead with a book (e.g. "1 John 1")?
        if _looks_like_book_prefix(right):
            right_p = _parse_book_chapter_partial(right, facts, default_book=None)
        else:
            right_p = _parse_book_chapter_partial(right, facts, default_book=left_p[0].book)
        return left_p + right_p
    # Chapter-jumping shape: "1 Cor. 4 - 5:13" or "2 Cor. 2 - 3:18".
    m = re.match(
        r"^([\w\s]+?\.?)\s*(\d+)\s*[-–]\s*(\d+)\s*:\s*(\d+)$",
        raw,
    )
    if m:
        book = canonical_book(m.group(1))
        c1 = int(m.group(2))
        c2 = int(m.group(3))
        end2 = int(m.group(4))
        first = Passage(book=book, chapter=c1, start_verse=1, end_verse=facts.last_verse(book, c1))
        second = Passage(book=book, chapter=c2, start_verse=1, end_verse=end2)
        return [first, second]
    return _parse_book_chapter_partial(raw, facts, default_book=None)


def _looks_like_book_prefix(s: str) -> bool:
    """Right side of `A & B` — does it start with its own book name
    (`1 John 1`, `2 Tim. 3`) vs a bare chapter (`2`)?"""
    m = re.match(r"^(\d?\s*[A-Za-z]+)\.?\s+\d+", s.strip())
    if not m:
        return False
    stem = m.group(1).strip().rstrip(".").lower()
    return stem in BOOK_ABBREV


def _parse_book_chapter_partial(
    raw: str, facts: ChapterFacts, default_book: str | None
) -> list[Passage]:
    """Parse either `Book Ch:S-E`, `Book Ch`, or `Ch` (with a default
    book from a preceding cross-book compound side)."""
    raw = raw.strip()
    # Bare chapter (right side of "Matt 13 & 16" recursion).
    if raw.isdigit() and default_book is not None:
        chap = int(raw)
        return [Passage(book=default_book, chapter=chap, start_verse=1, end_verse=facts.last_verse(default_book, chap))]
    # Book chapter:start-end
    m = re.match(r"^([\w\s\.]+?)\s+(\d+)\s*:\s*(\d+)\s*[-–]\s*(\d+)$", raw)
    if m:
        book = canonical_book(m.group(1))
        return [Passage(book=book, chapter=int(m.group(2)), start_verse=int(m.group(3)), end_verse=int(m.group(4)))]
    # Book chapter (whole)
    m = re.match(r"^([\w\s\.]+?)\s+(\d+)$", raw)
    if m:
        book = canonical_book(m.group(1))
        chap = int(m.group(2))
        return [Passage(book=book, chapter=chap, start_verse=1, end_verse=facts.last_verse(book, chap))]
    raise ValueError(f"Cannot parse passage cell: {raw!r}")


ORDINAL_RE = re.compile(r"^(\d+)(st|nd|rd|th)$", re.IGNORECASE)


def parse_ordinal_day(tok: str) -> int:
    m = ORDINAL_RE.match(tok.strip())
    if not m:
        raise ValueError(f"Not an ordinal day token: {tok!r}")
    return int(m.group(1))


def parse_year_range(title: str) -> tuple[int, int]:
    """Extract the two calendar years covered by the schedule from the
    title line (`"2023 - 2024 SCHEDULE"` or `"2025-26 SCHEDULE"`)."""
    m = re.search(r"(\d{4})\s*[-–]\s*(\d{4}|\d{2})", title)
    if not m:
        raise ValueError(f"Cannot parse year range from title: {title!r}")
    y1 = int(m.group(1))
    tail = m.group(2)
    y2 = int(tail) if len(tail) == 4 else (y1 // 100) * 100 + int(tail)
    return y1, y2


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "meet"


def parse_meet_row(line: str, year_start: int, year_end: int) -> Meet | None:
    """Match `Nov. 21-23 First Weekend Quiz Meet | Heritage …` or
    `May 3-5 Final Weekend Quiz Meet`."""
    month_pat = (
        r"January|February|March|April|May|June|July|August|September|October|November|December|"
        r"Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sept\.?|Sep\.?|Oct\.?|Nov\.?|Dec\.?"
    )
    m = re.match(
        rf"^\s*({month_pat})\s*(\d{{1,2}})\s*[-–]\s*(?:({month_pat})\s*)?(\d{{1,2}})\s+"
        r"(.+?)(?:\s*\|\s*(.+))?$",
        line.strip(),
    )
    if not m:
        return None
    m1 = MONTHS[m.group(1).lower().rstrip(".").rstrip()]
    d1 = int(m.group(2))
    m2 = MONTHS[m.group(3).lower().rstrip(".").rstrip()] if m.group(3) else m1
    d2 = int(m.group(4))
    name = m.group(5).strip()
    location = (m.group(6) or "TBD").strip()
    y1 = year_start if m1 >= 8 else year_end
    y2 = year_start if m2 >= 8 else year_end
    start_iso = date(y1, m1, d1).isoformat()
    end_iso = date(y2, m2, d2).isoformat()
    return Meet(
        id=slugify(name.replace("Quiz Meet", "").strip()),
        name=name,
        start_date=start_iso,
        end_date=end_iso,
        location=location,
    )


DATE_COL_WIDTH = 18  # approximate column width in the pdftotext layout


ROW_RE = re.compile(r"^-\s*(\d+(?:st|nd|rd|th))\s+(.+)$", re.IGNORECASE)


def split_row(rest: str) -> tuple[str, str, str]:
    """Split the passage / club150 / club300 columns using layout gaps.

    The PDF renders columns with wide runs of spaces between cells (2+
    spaces); a single space is a value separator inside a cell. We
    split on 2+ spaces to recover the three columns, tolerating trailing
    junk. Compound weeks with `|` inside a column parse the same way
    because the `|` is column-internal."""
    # Sub 2+ spaces → tab for a clean split, but keep at least 3 fields.
    parts = re.split(r"\s{2,}", rest.strip())
    if len(parts) == 1:
        return parts[0], "", ""
    if len(parts) == 2:
        return parts[0], parts[1], ""
    return parts[0], parts[1], " ".join(parts[2:])


def parse_pdf(pdf_path: Path, facts: ChapterFacts, meeting_day: str) -> tuple[list[Week], list[Meet], int, int, str]:
    text = subprocess.check_output(["pdftotext", "-layout", str(pdf_path), "-"]).decode()
    lines = [ln.rstrip() for ln in text.splitlines()]
    title = next((ln for ln in lines if "SCHEDULE" in ln.upper()), "")
    year_start, year_end = parse_year_range(title)

    weeks: list[Week] = []
    meets: list[Meet] = []
    current_month: int | None = None

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        # Month header (e.g. `SEPTEMBER:`)
        m = re.match(r"^([A-Z][A-Z]+):$", line)
        if m:
            current_month = MONTHS[m.group(1).lower()]
            continue
        # Meet row — try before the ordinal-week matcher so `Feb. 2-4`
        # style rows aren't mis-parsed.
        meet = parse_meet_row(raw, year_start, year_end)
        if meet is not None:
            meets.append(meet)
            continue
        # Week row (starts with `- 11th`)
        row_m = ROW_RE.match(line)
        if row_m and current_month is not None:
            day = parse_ordinal_day(row_m.group(1))
            rest = row_m.group(2)
            year = year_start if current_month >= 8 else year_end
            iso = date(year, current_month, day).isoformat()
            passage_col, c150_col, c300_col = split_row(rest)
            if passage_col.strip().lower() == "review":
                weeks.append(Week(iso_date=iso, blocks=[], is_review=True))
                continue
            passages = parse_passage_column(passage_col, facts)
            c150_groups = [g.strip() for g in c150_col.split("|")]
            c300_groups = [g.strip() for g in c300_col.split("|")]
            # Non-compound rows: single group in each column.
            if len(passages) == 1 and len(c150_groups) == 1 and len(c300_groups) == 1:
                blocks = [Block(passage=passages[0], club150=parse_verse_list(c150_groups[0]), club300=parse_verse_list(c300_groups[0]))]
            else:
                # Compound: verse groups should line up with passages.
                if not (len(passages) == len(c150_groups) == len(c300_groups)):
                    raise ValueError(
                        f"Passage / verse group count mismatch on {iso}: "
                        f"passages={len(passages)}, c150={len(c150_groups)}, c300={len(c300_groups)} "
                        f"({passage_col!r} | {c150_col!r} | {c300_col!r})"
                    )
                blocks = [
                    Block(passage=p, club150=parse_verse_list(a), club300=parse_verse_list(b))
                    for p, a, b in zip(passages, c150_groups, c300_groups)
                ]
            weeks.append(Week(iso_date=iso, blocks=blocks, is_review=False))
            continue
    return weeks, meets, year_start, year_end, title


def infer_meeting_day(weeks: list[Week]) -> str:
    """Pick the weekday most weeks fall on (schedules are anchored on
    the practice day)."""
    if not weeks:
        return "Mon"
    for w in weeks:
        d = date.fromisoformat(w.iso_date)
        return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.weekday() + 1 if d.weekday() < 6 else 0]
    return "Mon"


def main() -> None:
    if len(sys.argv) != 5:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    pdf_path = Path(sys.argv[1]).expanduser()
    deck = sys.argv[2]
    season = sys.argv[3]
    material_id = sys.argv[4]
    material_json = Path(__file__).resolve().parent.parent / "data" / f"{deck}.json"
    if not material_json.exists():
        print(f"material data missing: {material_json}", file=sys.stderr)
        sys.exit(1)
    facts = ChapterFacts.load(material_json)
    weeks, meets, y1, y2, title = parse_pdf(pdf_path, facts, meeting_day="Mon")
    meeting_day = infer_meeting_day(weeks)
    payload = {
        "version": 2,
        "materialId": material_id,
        "season": season,
        "title": title.strip() or f"{deck} {season}",
        "meetingDayOfWeek": meeting_day,
        "weeks": [w.to_json() for w in weeks],
        "meets": [m.to_json() for m in meets],
    }
    out = Path(__file__).resolve().parent.parent / "data" / "schedules" / f"{deck}-{season}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {out}  ({len(weeks)} weeks, {len(meets)} meets)")


if __name__ == "__main__":
    main()
