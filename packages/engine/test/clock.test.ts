import { describe, it, expect } from 'vitest'
import { FakeClock } from '../src/clock.js'

describe('FakeClock', () => {
  it('starts at the given time and does not move on its own', () => {
    const c = new FakeClock(1000)
    expect(c.now()).toBe(1000)
    expect(c.now()).toBe(1000)
  })

  it('fires callbacks whose deadline has passed, in time order', () => {
    const c = new FakeClock(0)
    const fired: string[] = []
    c.schedule(200, () => fired.push('b'))
    c.schedule(100, () => fired.push('a'))
    c.advance(150)
    expect(fired).toEqual(['a'])
    c.advance(100)
    expect(fired).toEqual(['a', 'b'])
    expect(c.now()).toBe(250)
  })

  it('does not fire a cancelled callback', () => {
    const c = new FakeClock(0)
    let fired = false
    const cancel = c.schedule(100, () => { fired = true })
    cancel()
    c.advance(500)
    expect(fired).toBe(false)
    expect(c.pendingCount()).toBe(0)
  })

  it('runs callbacks scheduled from within a callback in the same advance', () => {
    const c = new FakeClock(0)
    const fired: string[] = []
    c.schedule(10, () => {
      fired.push('outer')
      c.schedule(10, () => fired.push('inner'))
    })
    c.advance(25)
    expect(fired).toEqual(['outer', 'inner'])
  })
})
