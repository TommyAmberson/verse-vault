/**
 * Legacy-Phrase migration helpers. Ports
 * `packages/api/src/lib/engine.ts` `adaptElement` to the browser side so
 * the client can re-key its IDB-cached test states against the new
 * Phrase identity when the snapshot evolves.
 *
 * The server side already runs this on `/sync/state`, so in steady state
 * the client receives already-migrated entries. This module exists for
 * the snapshot-upgrade flow (months-stale device): if the client's cached
 * test states were written against an older MaterialData and the new one
 * restructures Phrase ranges, the upgrade pass walks the queued events
 * and IDB-cached entries through `adaptElement` against the new
 * snapshot before re-instantiating the engine.
 */

/** Cumulative-sum half-open word ranges per phrase, keyed by verse_id.
 *  Verses with empty `phraseWordCounts` are skipped, matching the Rust
 *  iterator. Parses out of the snapshot's MaterialData blob. */
export function computePhraseRangesByVerse(
  material: unknown,
): Map<number, [number, number][]> {
  const m = material as { verses?: { phraseWordCounts?: number[] }[] }
  const ranges = new Map<number, [number, number][]>()
  let verseId = 0
  for (const v of m.verses ?? []) {
    const counts = v.phraseWordCounts
    if (!counts || counts.length === 0) continue
    const r: [number, number][] = []
    let cursor = 0
    for (const n of counts) {
      const next = cursor + n
      r.push([cursor, next])
      cursor = next
    }
    ranges.set(verseId, r)
    verseId += 1
  }
  return ranges
}

/** Translate a stored `Phrase` element from the legacy positional form
 *  to the content-stable range form using the verse's phrase ranges.
 *  Non-Phrase elements pass through untouched. Returns null when the
 *  position no longer maps to any phrase range (verse removed or shrunk
 *  past this position) — caller should drop the entry. */
export function adaptElement(
  element: unknown,
  phraseRangesByVerse: Map<number, [number, number][]>,
): unknown | null {
  if (typeof element !== 'object' || element === null) return element
  const obj = element as Record<string, unknown>
  if (obj.kind !== 'Phrase' || !('position' in obj)) return element
  const verseId = obj.verse_id as number
  const position = obj.position as number
  const range = phraseRangesByVerse.get(verseId)?.[position]
  if (!range) return null
  return {
    kind: 'Phrase',
    verse_id: verseId,
    start_word: range[0],
    end_word: range[1],
  }
}
