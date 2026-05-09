#!/usr/bin/env python3
"""Derive structural verse-vault JSON from a chunked text-bearing JSON.

Strips NKJV verse text and phrase strings, replacing them with structural
metadata that doesn't reproduce copyrighted content:

    text + phrases + <b>/<i> markup    →    phraseWordCounts + annotations

Tokenisation rule (locked, must match render-time tokenisation in the API):
whitespace-split with punctuation glued to the adjacent token. So
"Paul, called to be" is 4 tokens: ["Paul,", "called", "to", "be"].

For each whitespace token in a phrase, examine the raw substring for HTML
tag wrappers — `<b>word</b>` → bold, `<i>word</i>` → italic, both nested →
boldItalic. Mid-word small-caps spans (NKJV typography for YHWH) are
stripped to leave the visible word; they're not user annotations and come
from api.bible at render time.

Heading entries lose their `text` field — titles are resolved server-side
against api.bible's sections endpoint.

Usage:
    python3 tools/derive_structure.py data/corinthians.json data/corinthians-structural.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys


_TAG_RE = re.compile(r"<[^>]+>")
# The small-caps opening span has internal whitespace inside the style
# attribute, which would otherwise split a single visible word into
# multiple tokens during whitespace-tokenisation. Strip the open+close
# pair (keeping the wrapped text) BEFORE tokenising.
_SMALL_CAPS_SPAN_OPEN_RE = re.compile(
    r'<span\s+style="[^"]*small-caps[^"]*">',
    re.IGNORECASE,
)
_SMALL_CAPS_SPAN_CLOSE_RE = re.compile(r"</span>", re.IGNORECASE)


def drop_small_caps_spans(text: str) -> str:
    """Remove `<span style="…small-caps…">` wrappers (open + close), leaving
    the wrapped text intact. This is editorial NKJV typography that comes
    from api.bible at render time; not tracked in our structural data."""
    text = _SMALL_CAPS_SPAN_OPEN_RE.sub("", text)
    text = _SMALL_CAPS_SPAN_CLOSE_RE.sub("", text)
    return text


def strip_markup(token: str) -> str:
    """Return the visible (display) text of a single token, dropping tags."""
    return _TAG_RE.sub("", token)


def annotation_kind(token: str) -> str | None:
    """Detect bold/italic markup wrapping a token. Returns the kind or None.

    Small-caps spans (NKJV's LORD typography) are intentionally ignored —
    they're editorial typography, not user annotation.
    """
    cleaned = drop_small_caps_spans(token)
    has_b = "<b>" in cleaned
    has_i = "<i>" in cleaned
    if has_b and has_i:
        return "boldItalic"
    if has_b:
        return "bold"
    if has_i:
        return "italic"
    return None


def derive_verse(verse: dict) -> dict:
    """Convert a single verse dict from text-bearing → structural shape."""
    out: dict = {
        "book": verse["book"],
        "chapter": verse["chapter"],
        "verse": verse["verse"],
        "phraseWordCounts": [],
        "annotations": [],
        "ftvWordCount": None,
        "clubs": list(verse.get("clubs", [])),
    }

    text = verse.get("text", "")
    phrases = verse.get("phrases", [])
    if not text or not phrases:
        return out

    # Pre-strip small-caps spans before tokenising so internal attribute
    # whitespace doesn't split a visible word into multiple tokens.
    cleaned_phrases = [drop_small_caps_spans(p) for p in phrases]

    word_index = 0
    phrase_word_counts: list[int] = []
    annotations: list[dict] = []
    for phrase in cleaned_phrases:
        tokens = phrase.split()
        phrase_word_counts.append(len(tokens))
        for tok in tokens:
            kind = annotation_kind(tok)
            if kind is not None:
                annotations.append({"wordIndex": word_index, "kind": kind})
            word_index += 1
    out["phraseWordCounts"] = phrase_word_counts
    out["annotations"] = annotations

    # Sanity check: stripping all markup and rejoining tokens should
    # reproduce the verse text. Mirrors validate_and_merge's phrase-join
    # check — the verse is well-formed if it matches.
    rejoined = " ".join(
        strip_markup(tok) for phrase in cleaned_phrases for tok in phrase.split()
    )
    canonical_text = re.sub(r"\s+", " ", strip_markup(drop_small_caps_spans(text))).strip()
    if rejoined != canonical_text:
        out["_warning"] = (
            f"text/phrase mismatch: rejoined={rejoined!r} canonical={canonical_text!r}"
        )

    # FTV: count words in the FTV string. Verify it's a prefix of phrase 0
    # (matches the Rust builder invariant in structural form).
    ftv = (verse.get("ftv") or "").strip()
    if ftv and cleaned_phrases:
        ftv_tokens = drop_small_caps_spans(ftv).split()
        ftv_word_count = len(ftv_tokens)
        first_phrase_visible = [strip_markup(t) for t in cleaned_phrases[0].split()]
        ftv_visible = [strip_markup(t) for t in ftv_tokens]
        prefix_ok = (
            ftv_word_count <= len(first_phrase_visible)
            and first_phrase_visible[:ftv_word_count] == ftv_visible
        )
        if prefix_ok:
            out["ftvWordCount"] = ftv_word_count

    return out


def derive_heading(heading: dict) -> dict:
    return {
        "book": heading["book"],
        "startChapter": heading["start_chapter"],
        "startVerse": heading["start_verse"],
        "endChapter": heading["end_chapter"],
        "endVerse": heading["end_verse"],
    }


def derive_material(data: dict) -> tuple[dict, list[str]]:
    """Convert a full material JSON. Returns (output, warnings)."""
    out_verses: list[dict] = []
    warnings: list[str] = []
    for v in data.get("verses", []):
        out = derive_verse(v)
        warning = out.pop("_warning", None)
        if warning:
            warnings.append(f"{v['book']} {v['chapter']}:{v['verse']} — {warning}")
        out_verses.append(out)
    out_headings = [derive_heading(h) for h in data.get("headings", [])]
    return {
        "year": data.get("year", 0),
        "books": data.get("books", []),
        "chapters": data.get("chapters", []),
        "verses": out_verses,
        "headings": out_headings,
    }, warnings


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="Chunked text-bearing JSON (e.g. data/corinthians.json)")
    ap.add_argument("output", help="Structural JSON to write")
    args = ap.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    out, warnings = derive_material(data)

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    print(f"Wrote {len(out['verses'])} verses, {len(out['headings'])} headings to {args.output}")
    if warnings:
        print(f"\n{len(warnings)} verses had structural warnings:")
        for w in warnings[:10]:
            print(f"  {w}")
        if len(warnings) > 10:
            print(f"  …and {len(warnings) - 10} more")


if __name__ == "__main__":
    main()
