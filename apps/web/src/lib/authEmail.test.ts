import { describe, expect, it } from 'vitest'

import { RESET_SENT, emailRequestMessage } from './authEmail'

describe('emailRequestMessage', () => {
  it('reads a success as sent', () => {
    expect(emailRequestMessage({ error: null }, RESET_SENT)).toBe(RESET_SENT)
  })

  it("shows the server's message when throttled", () => {
    const throttled = { error: { status: 429, message: 'Try again later.' } }
    expect(emailRequestMessage(throttled, RESET_SENT)).toBe('Try again later.')
  })

  it('reports any other failure instead of claiming it was sent', () => {
    expect(emailRequestMessage({ error: { status: 500 } }, RESET_SENT)).not.toBe(RESET_SENT)
  })
})
