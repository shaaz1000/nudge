import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NudgeEvent, SessionState, Tier } from '@nudge/shared/types'
import { dbPath } from '@nudge/shared/paths'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync: DB } = require('node:sqlite') as typeof import('node:sqlite')

export interface WaitRow {
  id: number
  sessionId: string
  project: string
  tier: Tier
  waitingSince: number
  resolvedAt: number | null
  resolvedBy: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  session_id TEXT    NOT NULL,
  project    TEXT    NOT NULL,
  cwd        TEXT    NOT NULL,
  hook       TEXT    NOT NULL,
  message    TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS waits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT    NOT NULL,
  project       TEXT    NOT NULL,
  tier          TEXT    NOT NULL,
  waiting_since INTEGER NOT NULL,
  resolved_at   INTEGER,
  resolved_by   TEXT
);
CREATE INDEX IF NOT EXISTS waits_since ON waits(waiting_since);
CREATE INDEX IF NOT EXISTS waits_open  ON waits(session_id, resolved_at);
`

const toRow = (r: Record<string, unknown>): WaitRow => ({
  id: r.id as number,
  sessionId: r.session_id as string,
  project: r.project as string,
  tier: r.tier as Tier,
  waitingSince: r.waiting_since as number,
  resolvedAt: (r.resolved_at as number | null) ?? null,
  resolvedBy: (r.resolved_by as string | null) ?? null,
})

export class Db {
  #db: DatabaseSync

  constructor(path = dbPath()) {
    mkdirSync(dirname(path), { recursive: true })
    this.#db = new DB(path)
    this.#db.exec('PRAGMA journal_mode = WAL;')
    this.#db.exec(SCHEMA)
  }

  recordEvent(ev: NudgeEvent): void {
    this.#db
      .prepare('INSERT INTO events (ts, session_id, project, cwd, hook, message) VALUES (?,?,?,?,?,?)')
      .run(ev.ts, ev.sessionId, ev.project, ev.cwd, ev.hook, ev.message ?? null)
  }

  eventCount(): number {
    const r = this.#db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    return r.n
  }

  openWait(s: SessionState, tier: Tier): number {
    const r = this.#db
      .prepare('INSERT INTO waits (session_id, project, tier, waiting_since) VALUES (?,?,?,?)')
      .run(s.sessionId, s.project, tier, s.waitingSince ?? s.lastEventAt)
    return Number(r.lastInsertRowid)
  }

  /** Closes the newest still-open wait for the session; a no-op if there is none. */
  closeWait(sessionId: string, at: number, by: string): void {
    this.#db.prepare(`
      UPDATE waits SET resolved_at = ?, resolved_by = ?
      WHERE id = (
        SELECT id FROM waits
        WHERE session_id = ? AND resolved_at IS NULL
        ORDER BY waiting_since DESC, id DESC LIMIT 1
      )
    `).run(at, by, sessionId)
  }

  openWaits(): WaitRow[] {
    return (this.#db.prepare(
      'SELECT * FROM waits WHERE resolved_at IS NULL ORDER BY waiting_since',
    ).all() as Record<string, unknown>[]).map(toRow)
  }

  waitsSince(ts: number): WaitRow[] {
    return (this.#db.prepare(
      'SELECT * FROM waits WHERE waiting_since >= ? ORDER BY waiting_since',
    ).all(ts) as Record<string, unknown>[]).map(toRow)
  }

  /** Drops old events and old *resolved* waits. An open wait is never pruned. */
  prune(olderThan: number): number {
    const a = this.#db.prepare('DELETE FROM events WHERE ts < ?').run(olderThan)
    const b = this.#db.prepare(
      'DELETE FROM waits WHERE waiting_since < ? AND resolved_at IS NOT NULL',
    ).run(olderThan)
    return Number(a.changes) + Number(b.changes)
  }

  close(): void {
    try {
      this.#db.close()
    } catch (err) {
      // Only ignore "database is not open"; rethrow other errors (I/O, corruption, etc.)
      if (err instanceof Error && err.message === 'database is not open') {
        return
      }
      throw err
    }
  }
}
