import { describe, expect, it } from 'vitest'

import { resetCounterStep } from './resetCounter'

describe('resetCounterStep', () => {
  it('adopts a first counter without clearing anything', () => {
    expect(resetCounterStep(undefined, 0)).toBe('adopt')
    expect(resetCounterStep(undefined, 3)).toBe('adopt')
  })

  it('ignores the counter it already has', () => {
    expect(resetCounterStep(2, 2)).toBe('ignore')
  })

  it('adopts a lower counter without clearing: the server went back', () => {
    expect(resetCounterStep(2, 1)).toBe('adopt')
  })

  it('catches up when the account was wiped elsewhere', () => {
    expect(resetCounterStep(1, 2)).toBe('catch-up')
  })
})
