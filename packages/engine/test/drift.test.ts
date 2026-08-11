import { describe, it, expect } from 'vitest'
import { DriftDetector } from '../src/drift.js'
import { FakeClock } from '../src/clock.js'

function build(thresholdMs = 5_000) {
  const clock = new FakeClock(0)
  let wall = 1_000_000
  let mono = 0
  const drifts: number[] = []
  const d = new DriftDetector({
    clock,
    wall: () => wall,
    mono: () => mono,
    onDrift: skew => drifts.push(skew),
    intervalMs: 10_000,
    thresholdMs,
  })
  return {
    d, clock, drifts,
    tick: (wallMs: number, monoMs: number) => { wall += wallMs; mono += monoMs },
  }
}

describe('DriftDetector', () => {
  it('reports nothing when both clocks advance together', () => {
    const { d, drifts, tick } = build()
    d.check()
    tick(10_000, 10_000)
    d.check()
    expect(drifts).toEqual([])
  })

  it('tolerates small scheduling jitter', () => {
    const { d, drifts, tick } = build()
    d.check()
    tick(10_400, 10_000)
    d.check()
    expect(drifts).toEqual([])
  })

  it('reports a sleep — wall advanced far beyond monotonic', () => {
    const { d, drifts, tick } = build()
    d.check()
    tick(7_200_000, 10_000)   // two hours asleep
    d.check()
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toBeGreaterThan(7_000_000)
  })

  it('reports a backwards clock set', () => {
    const { d, drifts, tick } = build()
    d.check()
    tick(-60_000, 10_000)
    d.check()
    expect(drifts).toHaveLength(1)
    expect(drifts[0]).toBeLessThan(0)
  })

  it('does not re-report the same drift on the next check', () => {
    const { d, drifts, tick } = build()
    d.check()
    tick(7_200_000, 10_000)
    d.check()
    tick(10_000, 10_000)
    d.check()
    expect(drifts).toHaveLength(1)
  })

  it('checks on the configured interval until cancelled', () => {
    const { d, clock, drifts, tick } = build()
    const cancel = d.start()
    tick(7_200_000, 10_000)
    clock.advance(10_000)
    expect(drifts).toHaveLength(1)
    cancel()
    tick(7_200_000, 10_000)
    clock.advance(60_000)
    expect(drifts).toHaveLength(1)
    expect(clock.pendingCount()).toBe(0)
  })
})
