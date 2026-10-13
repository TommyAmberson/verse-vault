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

  it('says so when the address turns out to be verified already', () => {
    const verified = { error: { status: 400, code: 'EMAIL_ALREADY_VERIFIED' } }
    expect(emailRequestMessage(verified, RESET_SENT)).toBe('This address is already verified.')
  })

  it('says to switch accounts when signed in as someone else', () => {
    const mismatch = { error: { status: 400, code: 'EMAIL_MISMATCH' } }
    expect(emailRequestMessage(mismatch, RESET_SENT)).toMatch(/signed in to a different account/)
  })

  it('reports any other failure instead of claiming it was sent', () => {
    expect(emailRequestMessage({ error: { status: 500 } }, RESET_SENT)).not.toBe(RESET_SENT)
  })
})
