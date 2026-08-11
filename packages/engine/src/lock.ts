import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export interface EngineLock {
  release(): void
}

/**
 * Exclusive single-instance guard for the engine daemon (finding C2).
 *
 * `EngineServer.listen()` unconditionally unlinks and rebinds the socket
 * file, so two engines started against the same NUDGE_HOME don't race for
 * the socket the way a normal "bind fails if taken" server would — the
 * second one happily steals the socket out from under the first, and BOTH
 * stay alive: the first keeps running its own watchdog/escalation timers and
 * its own now-orphaned handle on the SQLite file, unreachable by `nudge
 * mute`/`list`/`start` (which all talk to whichever socket is *currently*
 * bound). This is not a hypothetical race: the hook auto-spawns an engine
 * with no probe of its own whenever a send fails (`packages/hook/src/bin.ts`'s
 * `trySpawnEngine`, which bypasses `cmdStart`'s ping probe entirely), engine
 * boot takes ~100-200ms, and `PreToolUse`+`PostToolUse` fire back-to-back —
 * plus every hook in the burst right after a C1 crash spawns one. Several
 * overlapping spawn windows per session are routine, not exotic.
 *
 * `fs.openSync(path, 'wx')` is an atomic O_CREAT|O_EXCL create at the OS
 * level — at most one caller across any number of concurrent processes can
 * ever win it for a given path, so this is race-free even when two engines
 * call `acquireLock` within microseconds of each other. The winner writes
 * its own PID so a later caller can tell a *stale* lock (the process that
 * created it is dead — a prior crash, since `release()` removes a clean
 * shutdown's own lock) from a *live* one, and reclaim only the former.
 * Without that reclaim path, one crash would leave the engine permanently
 * unstartable — trading one bug for a worse one.
 *
 * Returns `null` when another live engine already holds the lock; the
 * caller (`bin.ts`) exits 0 quietly rather than binding anything. This also
 * closes the `nudge start` TOCTOU noted in the README's Limitations: two
 * near-simultaneous `start` invocations can both see "nothing answered" on
 * the ping probe and both call `spawnEngine()`, but only one of the two
 * resulting processes ever wins this lock.
 */
export function acquireLock(path: string): EngineLock | null {
  mkdirSync(dirname(path), { recursive: true })

  if (tryCreate(path)) return lockFor(path)

  // Someone already holds the lock file — find out if they're still alive.
  const holderPid = readPid(path)
  if (holderPid !== null && isAlive(holderPid)) return null // genuinely already running

  // Stale lock: the holder is gone (a crash — a clean shutdown deletes its
  // own lock via release() below) or the file was missing/corrupt. Reclaim it.
  try { unlinkSync(path) } catch { /* already gone */ }
  if (tryCreate(path)) return lockFor(path)

  // Lost a race to reclaim it to another process that got there first.
  return null
}

function tryCreate(path: string): boolean {
  try {
    const fd = openSync(path, 'wx')
    writeSync(fd, String(process.pid))
    closeSync(fd)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

function lockFor(path: string): EngineLock {
  return { release: () => { try { unlinkSync(path) } catch { /* already gone */ } } }
}

function readPid(path: string): number | null {
  try {
    const n = Number(readFileSync(path, 'utf8').trim())
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // ESRCH: no such process -> stale, reclaim it.
    // EPERM: the process exists but we lack permission to signal it -> treat
    // as alive; never steal a lock we can't prove is dead.
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
