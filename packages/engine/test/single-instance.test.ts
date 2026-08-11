import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { connect } from 'node:net'
import { encode, NdjsonDecoder } from '@nudge/shared/protocol'

/**
 * Finding C2, end to end: spawns the REAL compiled engine binary
 * (packages/engine/dist/bin.js), exactly as the hook's trySpawnEngine and
 * the CLI's spawnEngine both do, and proves the single-instance guard at
 * the level that actually matters — two real OS processes racing for one
 * NUDGE_HOME. This is the exact scenario the finding describes: before the
 * fix, both processes stayed alive, the second having unlinked and rebound
 * the first's socket out from under it while the first sat orphaned with
 * its own timers and its own handle on the SQLite file.
 *
 * Run `npx tsc --build` first, same requirement as the other dist-spawning
 * suites (hook/test/bin.test.ts, engine/test/integration.test.ts).
 */
const ENGINE_BIN = join(import.meta.dirname, '..', 'dist', 'bin.js')

let home: string
const children: ChildProcess[] = []

function spawnEngine(): ChildProcess {
  const child = spawn(process.execPath, [ENGINE_BIN], {
    env: { ...process.env, NUDGE_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  return child
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitForExit(child: ChildProcess, ms: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms)
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
}

async function waitForSocket(sockPath: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (existsSync(sockPath)) return
    await sleep(20)
  }
}

/** One-shot ping against a unix socket; resolves false on any connection failure. */
function ping(sockPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const s = connect(sockPath)
    const dec = new NdjsonDecoder()
    const done = (ok: boolean) => { try { s.destroy() } catch { /* ignore */ }; resolve(ok) }
    const timer = setTimeout(() => done(false), timeoutMs)
    s.on('connect', () => s.write(encode({ t: 'ping', id: 1 })))
    s.setEncoding('utf8')
    s.on('data', chunk => { for (const _ of dec.push(chunk as unknown as string)) { clearTimeout(timer); done(true) } })
    s.on('error', () => { clearTimeout(timer); done(false) })
  })
}

afterEach(async () => {
  for (const c of children) { try { c.kill('SIGKILL') } catch { /* already gone */ } }
  children.length = 0
  await sleep(50)
  if (home) rmSync(home, { recursive: true, force: true })
})

describe('engine single-instance guard (C2)', () => {
  it('the second engine started against the same NUDGE_HOME exits without binding, leaving the first alive and reachable', async () => {
    home = mkdtempSync(join(tmpdir(), 'nudge-single-'))
    const sock = join(home, 'engine.sock')

    const a = spawnEngine()
    await waitForSocket(sock, 5000)
    await sleep(150) // let the first engine finish chmod'ing the socket

    expect(isAlive(a.pid!)).toBe(true)
    expect(await ping(sock)).toBe(true)

    const b = spawnEngine()
    const bExit = await waitForExit(b, 5000)

    // The second process must exit — quietly, code 0 — without ever binding.
    expect(bExit).toBe(0)
    // The first is untouched: still alive, still answering on the socket it
    // originally bound (not a socket the second process stole and rebound).
    expect(isAlive(a.pid!)).toBe(true)
    expect(await ping(sock)).toBe(true)
  }, 15_000)

  it('a stale lock (holder pid not alive) is reclaimed, so a crashed engine does not permanently block future starts', async () => {
    home = mkdtempSync(join(tmpdir(), 'nudge-single-stale-'))
    const sock = join(home, 'engine.sock')
    const lockFile = join(home, 'engine.lock')

    // Simulate a crash: a lock file left behind by a pid that is provably
    // dead (a child spawned and already exited), with no engine actually
    // running and no socket bound.
    const { spawn: spawnDead } = await import('node:child_process')
    const dead = spawnDead(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid = dead.pid!
    await new Promise(resolve => dead.on('exit', resolve))
    writeFileSync(lockFile, String(deadPid))

    const a = spawnEngine()
    await waitForSocket(sock, 5000)
    await sleep(150)

    expect(isAlive(a.pid!)).toBe(true)
    expect(await ping(sock)).toBe(true)
    // The lock now reflects the new, real engine — proving it was reclaimed
    // rather than left pointing at the dead pid forever.
    expect(readFileSync(lockFile, 'utf8').trim()).toBe(String(a.pid))
  }, 15_000)
})
