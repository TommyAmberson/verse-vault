import { describe, expect, it } from 'vitest'

import {
  RESET_SENT,
  THROTTLED_MESSAGE,
  emailRequestMessage,
  verificationTokenEmail,
} from './authEmail'

describe('emailRequestMessage', () => {
  it('reads a success as sent', () => {
    expect(emailRequestMessage({ error: null }, RESET_SENT)).toBe(RESET_SENT)
  })

  it('tells a throttled learner to wait', () => {
    expect(emailRequestMessage({ error: { status: 429 } }, RESET_SENT)).toBe(THROTTLED_MESSAGE)
  })

  it('reports any other failure instead of claiming it was sent', () => {
    expect(emailRequestMessage({ error: { status: 500 } }, RESET_SENT)).not.toBe(RESET_SENT)
  })
})

describe('verificationTokenEmail', () => {
  const encode = (value: object) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

  it("reads the address from a JWT's payload", () => {
    const token = `${encode({ alg: 'HS256' })}.${encode({ email: 'a@example.com' })}.sig`
    expect(verificationTokenEmail(token)).toBe('a@example.com')
  })

  it('returns null for anything that is not a token', () => {
    expect(verificationTokenEmail('not-a-token')).toBeNull()
    expect(verificationTokenEmail('a.%%%.c')).toBeNull()
  })
})
