import { describe, it, expect } from 'vitest'
import { encode, NdjsonDecoder } from '../src/protocol.js'

describe('NDJSON codec', () => {
  it('round-trips a message', () => {
    const d = new NdjsonDecoder()
    expect(d.push(encode({ t: 'ping', id: 1 }))).toEqual([{ t: 'ping', id: 1 }])
  })

  it('yields nothing for a partial line, then the whole message', () => {
    const d = new NdjsonDecoder()
    expect(d.push('{"t":"pi')).toEqual([])
    expect(d.push('ng","id":2}\n')).toEqual([{ t: 'ping', id: 2 }])
  })

  it('decodes several messages in one chunk', () => {
    const d = new NdjsonDecoder()
    expect(d.push(encode({ t: 'a' }) + encode({ t: 'b' }))).toHaveLength(2)
  })

  it('skips a malformed line and keeps going', () => {
    const d = new NdjsonDecoder()
    expect(d.push('not json\n' + encode({ t: 'ok' }))).toEqual([{ t: 'ok' }])
  })

  it('ignores blank lines', () => {
    const d = new NdjsonDecoder()
    expect(d.push('\n\n' + encode({ t: 'ok' }))).toEqual([{ t: 'ok' }])
  })

  it('always terminates encoded messages with a newline', () => {
    expect(encode({ t: 'x' }).endsWith('\n')).toBe(true)
  })
})
