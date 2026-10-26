import { describe, expect, it } from 'vitest'

import { socialSignInError, withoutErrorParam } from './socialSignInError'

describe('socialSignInError', () => {
  it('is null when the callback carried no error', () => {
    expect(socialSignInError('')).toBeNull()
    expect(socialSignInError('?profile=2')).toBeNull()
  })

  it('points a refused link at the password form', () => {
    const result = socialSignInError('?error=account_not_linked')
    expect(result?.passwordAccount).toBe(true)
    expect(result?.message).toMatch(/can't sign in to yet/)
    expect(result?.message).toMatch(/password/)
    expect(result?.message).toMatch(/reset/)
  })

  it('explains a Google account with a different address', () => {
    const result = socialSignInError("?error=email_doesn't_match")
    expect(result?.message).toMatch(/different email address/)
  })

  it('reports other codes as a generic failure', () => {
    const result = socialSignInError('?error=invalid_code&error_description=bad')
    expect(result?.passwordAccount).toBe(false)
    expect(result?.message).toMatch(/failed/)
  })
})

describe('withoutErrorParam', () => {
  it('drops error and error_description but keeps the rest', () => {
    expect(
      withoutErrorParam(
        'https://www.versevault.ca/vv/?profile=2&error=account_not_linked&error_description=x',
      ),
    ).toBe('https://www.versevault.ca/vv/?profile=2')
  })

  it('leaves a URL without them unchanged', () => {
    expect(withoutErrorParam('https://www.versevault.ca/vv/review')).toBe(
      'https://www.versevault.ca/vv/review',
    )
  })
})
