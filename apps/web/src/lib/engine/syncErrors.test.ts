import { describe, expect, it } from 'vitest'

import { ApiError } from '@/api'
import { unknownCardIds } from './syncErrors'

function apiError(status: number, body: unknown): ApiError {
  return new ApiError(status, typeof body === 'string' ? body : JSON.stringify(body))
}

describe('unknownCardIds', () => {
  it('reads the structured field the server sends', () => {
    const err = apiError(400, {
      error: 'Unknown card ids: 15, 39 — re-fetch state before syncing',
      unknownCardIds: [15, 39],
    })
    expect(unknownCardIds(err)).toEqual([15, 39])
  })

  // web and api deploy off the same master push with no ordering, so a
  // browser can hold the new bundle while the server still sends only
  // the message. Parsing it keeps the quarantine working in that window.
  it('falls back to parsing the message from an older server', () => {
    const err = apiError(400, {
      error: 'Unknown card ids: 7578, 7579, 71 — re-fetch state before syncing',
    })
    expect(unknownCardIds(err)).toEqual([7578, 7579, 71])
  })

  it('ignores failures that are not an unknown-card 400', () => {
    expect(unknownCardIds(apiError(409, { error: 'Snapshot version mismatch' }))).toEqual([])
    expect(unknownCardIds(apiError(400, { error: 'grade must be 1..=4' }))).toEqual([])
    expect(unknownCardIds(apiError(500, 'upstream exploded'))).toEqual([])
    expect(unknownCardIds(new Error('offline'))).toEqual([])
  })

  it('survives a body that is not JSON', () => {
    expect(unknownCardIds(apiError(400, '<html>gateway</html>'))).toEqual([])
  })

  it('falls through to the message when the field holds nothing usable', () => {
    const err = apiError(400, {
      error: 'Unknown card ids: 15, 39 — re-fetch state before syncing',
      unknownCardIds: ['15', '39'],
    })
    expect(unknownCardIds(err)).toEqual([15, 39])
  })

  // Number('') is 0 and Number.isInteger(0) is true, so a stray comma
  // would otherwise name card 0 and strand its events.
  it('never conjures card id 0 from an empty segment', () => {
    const err = apiError(400, { error: 'Unknown card ids: 15, , 39 — re-fetch state' })
    expect(unknownCardIds(err)).toEqual([15, 39])
    const trailing = apiError(400, { error: 'Unknown card ids: 15, — re-fetch state' })
    expect(unknownCardIds(trailing)).toEqual([15])
  })
})
