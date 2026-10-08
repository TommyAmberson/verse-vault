import { describe, expect, it } from 'vitest'

import { RESET_SENT, THROTTLED_MESSAGE, emailRequestMessage } from './authEmail'

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
