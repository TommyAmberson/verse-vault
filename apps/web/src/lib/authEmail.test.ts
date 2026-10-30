import { describe, expect, it } from 'vitest'

import { RESET_SENT, codeErrorMessage, emailRequestMessage } from './authEmail'

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

describe('codeErrorMessage', () => {
  it('reads a success as no error', () => {
    expect(codeErrorMessage({ error: null })).toBeNull()
  })

  it('tells a wrong code from one that has run out', () => {
    expect(codeErrorMessage({ error: { status: 400, code: 'INVALID_OTP' } })).toBe(
      "That code isn't right.",
    )
    for (const code of ['OTP_EXPIRED', 'TOO_MANY_ATTEMPTS']) {
      expect(codeErrorMessage({ error: { status: 400, code } })).toBe(
        'That code has expired. Send a new one.',
      )
    }
  })

  it("shows the server's message for anything else", () => {
    const short = { error: { status: 400, code: 'PASSWORD_TOO_SHORT', message: 'Password too short' } }
    expect(codeErrorMessage(short)).toBe('Password too short')
    expect(codeErrorMessage({ error: { status: 500 } })).toBe('Something went wrong. Try again.')
  })
})
