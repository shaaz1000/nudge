import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock } from '../src/lock.js'

// Finding C2: EngineServer.listen() unconditionally unlinks and rebinds the
// socket file, so nothing stops a second engine process for the same
// NUDGE_HOME from starting up and stealing the socket out from under the
// first — both stay alive, the first orphaned with its own timers and its
// own handle on the SQLite file, unreachable by `nudge mute`/`list`/`start`.
// acquireLock() is the fix: an atomic O_CREAT|O_EXCL lockfile, reclaimed only
// when its recorded holder PID is provably dead.

let dir: string
let lockPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-lock-'))
  lockPath = join(dir, 'engine.lock')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('acquireLock', () => {
  it('acquires a fresh lock and writes its own pid into the file', () => {
    const lock = acquireLock(lockPath)
    expect(lock).not.toBeNull()
    expect(existsSync(lockPath)).toBe(true)
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid))
    lock!.release()
  })

  it('creates the containing directory if it does not exist yet', () => {
    const nested = join(dir, 'nested', 'dir', 'engine.lock')
    const lock = acquireLock(nested)
    expect(lock).not.toBeNull()
    expect(existsSync(nested)).toBe(true)
    lock!.release()
  })

  it('refuses a second acquire while the current process (a live pid) still holds it', () => {
    const first = acquireLock(lockPath)
    expect(first).not.toBeNull()

    // Simulates a second engine process: acquireLock reads the lock file's
    // pid (this test process's own, since `first` just wrote it) and finds
    // it alive — because it genuinely is.
    const second = acquireLock(lockPath)
    expect(second).toBeNull()

    first!.release()
  })

  it('release() removes the lock file so a later acquire succeeds', () => {
    const first = acquireLock(lockPath)!
    first.release()
    expect(existsSync(lockPath)).toBe(false)

    const second = acquireLock(lockPath)
    expect(second).not.toBeNull()
    second!.release()
  })

  it('reclaims a stale lock whose recorded holder pid is no longer alive', async () => {
    // A real, now-guaranteed-dead pid: spawn a child, let it exit, and reuse
    // its pid — far more honest than a hardcoded number that merely hopes no
    // process on the test machine happens to hold it.
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid: number = dead.pid!
    await new Promise(resolve => dead.on('exit', resolve))

    writeFileSync(lockPath, String(deadPid))
    const lock = acquireLock(lockPath)
    expect(lock).not.toBeNull()
    // Reclaimed, not merely left alone: the file now holds *our* pid.
    expect(readFileSync(lockPath, 'utf8').trim()).toBe(String(process.pid))
    lock!.release()
  })

  it('treats a corrupt/unreadable lock file the same as a stale one and reclaims it', () => {
    writeFileSync(lockPath, 'not-a-pid')
    const lock = acquireLock(lockPath)
    expect(lock).not.toBeNull()
    lock!.release()
  })
})
