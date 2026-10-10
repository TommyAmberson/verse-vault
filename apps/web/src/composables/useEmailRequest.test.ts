import { describe, expect, it } from 'vitest'

import { RESET_SENT } from '@/lib/authEmail'

import { useEmailRequest } from './useEmailRequest'

describe('useEmailRequest', () => {
  it('releases the button and says so when the request never reaches the server', async () => {
    const { pending, notice, run } = useEmailRequest(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => RESET_SENT,
    )
    await run()
    expect(pending.value).toBe(false)
    expect(notice.value).toBe('Something went wrong. Try again.')
  })
})
