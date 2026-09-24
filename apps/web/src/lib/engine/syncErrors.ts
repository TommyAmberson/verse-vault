/**
 * Reading the card ids back out of a rejected sync upload.
 *
 * `POST /sync/:materialId/events` rejects a whole batch with 400 when it
 * carries a card id the server's engine doesn't know, a guard against
 * persisting rows that would brick replay. This pulls those ids out so
 * the caller can decide what to do with them; the 409 snapshot-mismatch
 * path in `engineStore` is separately recoverable.
 *
 * Reading an id here is not the same as condemning its event. An id can
 * be refused merely because the current config doesn't emit that card,
 * so the caller checks each one against its own engine before treating
 * an event as unsendable.
 */

import { ApiError } from '../../api'

/** Matches the server's message form, for a server that predates the
 *  structured field. Deliberately anchored on the whole prefix so a
 *  different 400 can't be mistaken for this one. */
const MESSAGE_FORM = /Unknown card ids: ([\d,\s]+?)\s+—/

/** Card ids the server refused, or `[]` for every other failure.
 *
 *  Prefers the structured `unknownCardIds` field and falls back to the
 *  message: web and api deploy off the same push with no ordering, so a
 *  browser can run this code against a server that only sends the text. */
export function unknownCardIds(err: unknown): number[] {
  if (!(err instanceof ApiError) || err.status !== 400) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(err.body)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []

  const structured = (parsed as { unknownCardIds?: unknown }).unknownCardIds
  if (Array.isArray(structured)) {
    const ids = structured.filter((id): id is number => Number.isInteger(id))
    // Fall through to the message when the field is present but yields
    // nothing usable (ids serialised as strings, say). Returning []
    // here would discard the one signal that unblocks the queue.
    if (ids.length > 0) return ids
  }

  const message = (parsed as { error?: unknown }).error
  if (typeof message !== 'string') return []
  const match = MESSAGE_FORM.exec(message)
  if (!match?.[1]) return []
  return match[1]
    .split(',')
    // `Number('')` is 0 and `Number.isInteger(0)` is true, so a trailing
    // or doubled comma would otherwise conjure card id 0, a real id
    // whose events would then be set aside for nothing.
    .filter((part) => /^\s*\d+\s*$/.test(part))
    .map((part) => Number(part.trim()))
}
