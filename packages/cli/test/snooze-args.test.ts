import { describe, it, expect } from 'vitest'
import { parseSnoozeArgs } from '../src/commands.js'

// `nudge snooze <sessionId> [minutes]` must never silently turn a typo into
// NaN/undefined and report success. Every bad input here must throw with a
// message specific enough to diagnose from a script's stderr, and the CLI's
// top-level handler turns any thrown Error into a non-zero exit.

describe('parseSnoozeArgs', () => {
  it('rejects a non-numeric minutes argument', () => {
    expect(() => parseSnoozeArgs('sess1', 'abc'))
      .toThrow(/minutes must be a positive number, got "abc"/)
  })

  it('rejects a negative minutes argument', () => {
    expect(() => parseSnoozeArgs('sess1', '-5'))
      .toThrow(/minutes must be a positive number, got "-5"/)
  })

  it('rejects zero minutes', () => {
    expect(() => parseSnoozeArgs('sess1', '0'))
      .toThrow(/minutes must be a positive number, got "0"/)
  })

  it('rejects a missing session id', () => {
    expect(() => parseSnoozeArgs(undefined, '10'))
      .toThrow(/session id is required/i)
  })

  it('rejects a missing session id even when minutes is also omitted', () => {
    expect(() => parseSnoozeArgs(undefined, undefined))
      .toThrow(/session id is required/i)
  })

  it('accepts a valid minutes argument and converts to milliseconds', () => {
    expect(parseSnoozeArgs('sess1', '15')).toEqual({ sessionId: 'sess1', ms: 900_000 })
  })

  it('defaults to 10 minutes when no minutes argument is given', () => {
    expect(parseSnoozeArgs('sess1', undefined)).toEqual({ sessionId: 'sess1', ms: 600_000 })
  })
})
