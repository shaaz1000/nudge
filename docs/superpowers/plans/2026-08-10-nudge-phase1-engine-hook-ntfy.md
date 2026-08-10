# Nudge Phase 1 — Engine, Hook, and ntfy Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A headless daemon that alerts you the moment a Claude Code session is blocked on you, and pushes to your phone if you don't come back.

**Architecture:** A short-lived `hook` binary that Claude Code invokes writes normalized events over a filesystem socket to an always-running `engine` daemon. The engine owns all logic — session state machine, severity tiers, escalation timers, desktop notification, phone dispatch — and persists to SQLite. No GUI in this phase; the Electron shell is Phase 2 and attaches to the same socket.

**Tech Stack:** TypeScript (ESM), Node ≥ 22.5, npm workspaces, `node:sqlite` (built-in — no native compilation, no Electron rebuild pain), vitest, zero runtime dependencies in `engine` and `hook`.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Node ≥ 22.5.0.** Required for stable `node:sqlite`. Enforce via `engines` in every `package.json`.
- **Zero runtime dependencies in `@nudge/hook` and `@nudge/engine`.** Node built-ins only. Dev dependencies (vitest, typescript) are unrestricted.
- **The hook has a 500ms hard timeout, always `exit 0`, and never writes to stdout.** stdout is meaningful to Claude Code hooks. Violating any of these can break a user's agent session.
- **The engine listens on a filesystem socket with `0600` permissions, never a network port.**
- **Phone alerts carry `project` + `tier` only.** No commands, paths, arguments, or message text leave the machine unless `detailLevel: 'full'` is explicitly set.
- **No secret-redaction pass is shipped.** Minimal-by-default is the mitigation.
- **`~/.claude/settings.json` is sacred.** Timestamped backup before any write, structural merge that only appends to `hooks` arrays, JSON validated before write, `--dry-run` prints the diff, `uninstall` removes exactly what was added.
- **All time arithmetic goes through the `Clock` interface.** No direct `Date.now()` or `setTimeout` outside `SystemClock`. This is what makes the escalation ladder testable.
- **`NUDGE_HOME` env var overrides `~/.nudge` everywhere.** Required for scratch-HOME tests; no test may touch the developer's real config.
- Defaults: escalate at **180s** active / **45s** idle, idle threshold **60s**, local repeat **3×** at **60s**, phone repeat **0**, watchdog stall **900s**, session TTL **86400s**, retention **30 days**.

---

## File Structure

```
nudge/
├── package.json                       npm workspaces root
├── tsconfig.base.json
├── vitest.config.ts
├── .github/workflows/ci.yml
└── packages/
    ├── shared/                        @nudge/shared — types + paths + wire protocol
    │   ├── src/types.ts               NudgeEvent, SessionState, Tier, Alert, Surface
    │   ├── src/config.ts              NudgeConfig type + DEFAULT_CONFIG + validate/load
    │   ├── src/paths.ts               NUDGE_HOME-aware path resolution
    │   └── src/protocol.ts            ClientMessage/ServerMessage + NDJSON codec
    ├── hook/                          @nudge/hook — the binary Claude Code invokes
    │   ├── src/bin.ts                 entrypoint: read → send → exit 0
    │   ├── src/read-stdin.ts          bounded stdin read with timeout
    │   ├── src/surface.ts             environment fingerprint capture
    │   ├── src/send.ts                socket write with hard deadline
    │   └── src/spool.ts               fallback: write event to disk
    ├── engine/                        @nudge/engine — all logic
    │   ├── src/clock.ts               Clock interface, SystemClock, FakeClock
    │   ├── src/normalize.ts           raw Claude Code payload → NudgeEvent
    │   ├── src/state.ts               SessionStore: state machine + tier assignment
    │   ├── src/watchdog.ts            stall detection + session TTL
    │   ├── src/suppression.ts         mute / snooze / quiet hours / frontmost
    │   ├── src/escalation.ts          the ladder scheduler
    │   ├── src/desktop.ts             platform notification + sound
    │   ├── src/dispatch.ts            channel send with retry + failure state
    │   ├── src/db.ts                  node:sqlite events + waits tables
    │   ├── src/drain.ts               spool drain on boot
    │   ├── src/server.ts              socket server + local API
    │   ├── src/engine.ts              composition root
    │   └── src/bin.ts                 daemon entrypoint
    ├── channels/                      @nudge/channels
    │   ├── src/types.ts               Channel interface
    │   ├── src/ntfy.ts                default adapter
    │   └── src/registry.ts            built-ins + ~/.nudge/channels/*.js loader
    └── cli/                           nudge — the CLI
        ├── src/bin.ts                 arg parsing
        ├── src/settings.ts            ~/.claude/settings.json backup/merge/diff/remove
        ├── src/setup.ts               setup + --dry-run
        ├── src/service.ts             launchd / systemd --user / schtasks
        └── src/commands.ts            status, list, test, snooze, mute
```

Rationale for the split: files that change together live together, and each file has one responsibility small enough to hold in context. `state.ts`, `escalation.ts`, and `suppression.ts` are separated because they have genuinely different reasons to change — the state machine follows Claude Code's hooks, the ladder follows user preference, suppression follows platform behaviour.

---

## Task 1: Monorepo scaffold and shared types

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/paths.ts`
- Test: `packages/shared/test/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type below, imported by all later tasks. `nudgeHome()`, `socketPath()`, `configPath()`, `spoolDir()`, `dbPath()`, `claudeSettingsPath()`.

- [ ] **Step 1: Create the workspace root**

`package.json`:

```json
{
  "name": "nudge",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22.5.0" },
  "scripts": {
    "build": "tsc --build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^22.7.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "composite": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true
  }
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
})
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
.nudge-test/
```

- [ ] **Step 2: Create the shared package**

`packages/shared/package.json`:

```json
{
  "name": "@nudge/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    "./types": "./dist/types.js",
    "./paths": "./dist/paths.js",
    "./config": "./dist/config.js",
    "./protocol": "./dist/protocol.js"
  },
  "engines": { "node": ">=22.5.0" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write the shared types**

`packages/shared/src/types.ts`:

```ts
export type Tier = 'blocked' | 'idle-long' | 'idle-short' | 'stalled'

export type HookName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Notification'
  | 'Stop'
  | 'SessionEnd'

export type SurfaceKind =
  | 'vscode' | 'cursor' | 'windsurf' | 'terminal' | 'desktop' | 'unknown'

export interface Surface {
  kind: SurfaceKind
  termProgram?: string
  termSessionId?: string
  tty?: string
  tmux?: boolean
  wtSession?: string
  ppid?: number
}

/** A normalized event produced by an event source. */
export interface NudgeEvent {
  source: 'claude-code'
  sessionId: string
  hook: HookName
  cwd: string
  project: string
  message?: string
  tool?: string
  surface?: Surface
  ts: number
}

export type SessionStatus = 'running' | 'blocked' | 'idle' | 'stalled' | 'gone'

export interface SessionState {
  sessionId: string
  project: string
  cwd: string
  surface: Surface
  status: SessionStatus
  tier: Tier | null
  waitingSince: number | null
  turnStartedAt: number | null
  lastEventAt: number
  message: string | null
  snoozedUntil: number | null
  pushFailed: boolean
}

/** What a channel receives. `detail` is present only when detailLevel is 'full'. */
export interface Alert {
  sessionId: string
  project: string
  tier: Tier
  waitingSince: number
  detail?: string
}

export const UNKNOWN_SURFACE: Surface = { kind: 'unknown' }
```

- [ ] **Step 4: Write the failing test for paths**

`packages/shared/test/paths.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { nudgeHome, socketPath, configPath, spoolDir, dbPath } from '../src/paths.js'

describe('paths', () => {
  const original = process.env.NUDGE_HOME
  beforeEach(() => { process.env.NUDGE_HOME = '/tmp/nudge-test-home' })
  afterEach(() => {
    if (original === undefined) delete process.env.NUDGE_HOME
    else process.env.NUDGE_HOME = original
  })

  it('honours NUDGE_HOME for every derived path', () => {
    expect(nudgeHome()).toBe('/tmp/nudge-test-home')
    expect(configPath()).toBe(join('/tmp/nudge-test-home', 'config.json'))
    expect(spoolDir()).toBe(join('/tmp/nudge-test-home', 'spool'))
    expect(dbPath()).toBe(join('/tmp/nudge-test-home', 'nudge.db'))
  })

  it('produces a platform-appropriate socket path', () => {
    const p = socketPath()
    if (process.platform === 'win32') expect(p).toMatch(/^\\\\[.]\\pipe\\nudge-/)
    else expect(p).toBe(join('/tmp/nudge-test-home', 'engine.sock'))
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run packages/shared/test/paths.test.ts`
Expected: FAIL — `Cannot find module '../src/paths.js'`

- [ ] **Step 6: Implement paths**

`packages/shared/src/paths.ts`:

```ts
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

export function nudgeHome(): string {
  return process.env.NUDGE_HOME ?? join(homedir(), '.nudge')
}

export function configPath(): string { return join(nudgeHome(), 'config.json') }
export function spoolDir(): string { return join(nudgeHome(), 'spool') }
export function dbPath(): string { return join(nudgeHome(), 'nudge.db') }
export function channelsDir(): string { return join(nudgeHome(), 'channels') }

export function socketPath(): string {
  if (process.platform === 'win32') {
    // Named pipes are per-user by default; scope by username to avoid collisions.
    return `\\\\.\\pipe\\nudge-${userInfo().username}`
  }
  return join(nudgeHome(), 'engine.sock')
}

/** Claude Code honours CLAUDE_CONFIG_DIR; fall back to ~/.claude. */
export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return join(dir, 'settings.json')
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run packages/shared/test/paths.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.base.json vitest.config.ts .gitignore packages/shared
git commit -m "feat(shared): monorepo scaffold, core types, NUDGE_HOME-aware paths"
```

---

## Task 2: Clock abstraction

**Files:**
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`
- Create: `packages/engine/src/clock.ts`
- Test: `packages/engine/test/clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Clock { now(): number; schedule(delayMs: number, fn: () => void): Cancel }`, `type Cancel = () => void`, `class SystemClock implements Clock`, `class FakeClock implements Clock` with extra methods `advance(ms: number): void` and `pendingCount(): number`.

Every later task takes a `Clock` by constructor injection. This is the single most important testability decision in the plan — without it the escalation ladder can only be tested by waiting in real time.

- [ ] **Step 1: Create the engine package**

`packages/engine/package.json`:

```json
{
  "name": "@nudge/engine",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/engine.js",
  "bin": { "nudge-engine": "./dist/bin.js" },
  "engines": { "node": ">=22.5.0" },
  "dependencies": { "@nudge/shared": "0.1.0", "@nudge/channels": "0.1.0" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/engine/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../shared" }, { "path": "../channels" }]
}
```

- [ ] **Step 2: Write the failing test**

`packages/engine/test/clock.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/clock.test.ts`
Expected: FAIL — `Cannot find module '../src/clock.js'`

- [ ] **Step 4: Implement the clock**

`packages/engine/src/clock.ts`:

```ts
export type Cancel = () => void

export interface Clock {
  now(): number
  schedule(delayMs: number, fn: () => void): Cancel
}

export class SystemClock implements Clock {
  now(): number { return Date.now() }
  schedule(delayMs: number, fn: () => void): Cancel {
    const t = setTimeout(fn, delayMs)
    if (typeof t.unref === 'function') t.unref()
    return () => clearTimeout(t)
  }
}

interface Task { at: number; fn: () => void; cancelled: boolean }

export class FakeClock implements Clock {
  #now: number
  #tasks: Task[] = []

  constructor(start = 0) { this.#now = start }

  now(): number { return this.#now }

  schedule(delayMs: number, fn: () => void): Cancel {
    const task: Task = { at: this.#now + delayMs, fn, cancelled: false }
    this.#tasks.push(task)
    return () => {
      task.cancelled = true
      this.#tasks = this.#tasks.filter(t => t !== task)
    }
  }

  pendingCount(): number { return this.#tasks.filter(t => !t.cancelled).length }

  /**
   * Advance time, firing due tasks in deadline order. Tasks scheduled from
   * within a callback are picked up in the same advance if they come due,
   * which mirrors how real timers behave across a long tick.
   */
  advance(ms: number): void {
    const target = this.#now + ms
    for (;;) {
      const due = this.#tasks
        .filter(t => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at)
      const next = due[0]
      if (!next) break
      this.#tasks = this.#tasks.filter(t => t !== next)
      this.#now = next.at
      next.fn()
    }
    this.#now = target
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/clock.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add packages/engine
git commit -m "feat(engine): injectable Clock with SystemClock and FakeClock"
```

---

## Task 3: Config module

**Files:**
- Create: `packages/shared/src/config.ts`
- Test: `packages/shared/test/config.test.ts`

**Interfaces:**
- Consumes: `Tier` from `@nudge/shared/types`.
- Produces: `interface NudgeConfig`, `interface TierConfig`, `DEFAULT_CONFIG: NudgeConfig`, `mergeConfig(partial: unknown): NudgeConfig`, `loadConfig(path?: string): NudgeConfig`, `escalateDelayFor(cfg, tier, idleMs): number | null`.

`escalateDelayFor` is where the spec's precedence rule lives: per-tier override wins over the idle-adaptive base, and `escalates: false` returns `null` meaning "never reaches a channel".

- [ ] **Step 1: Write the failing test**

`packages/shared/test/config.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, mergeConfig, escalateDelayFor } from '../src/config.js'

describe('config defaults', () => {
  it('matches the spec values', () => {
    expect(DEFAULT_CONFIG.detailLevel).toBe('minimal')
    expect(DEFAULT_CONFIG.escalation.activeDelayMs).toBe(180_000)
    expect(DEFAULT_CONFIG.escalation.idleDelayMs).toBe(45_000)
    expect(DEFAULT_CONFIG.escalation.idleThresholdMs).toBe(60_000)
    expect(DEFAULT_CONFIG.escalation.longTurnMs).toBe(180_000)
    expect(DEFAULT_CONFIG.escalation.localRepeat).toBe(3)
    expect(DEFAULT_CONFIG.escalation.phoneRepeat).toBe(0)
    expect(DEFAULT_CONFIG.watchdog.stallAfterMs).toBe(900_000)
    expect(DEFAULT_CONFIG.watchdog.sessionTtlMs).toBe(86_400_000)
    expect(DEFAULT_CONFIG.retentionDays).toBe(30)
  })

  it('makes idle-short silent and non-escalating', () => {
    expect(DEFAULT_CONFIG.tiers['idle-short'].sound).toBeNull()
    expect(DEFAULT_CONFIG.tiers['idle-short'].escalates).toBe(false)
  })

  it('escalates blocked and idle-long, and stalled only if configured', () => {
    expect(DEFAULT_CONFIG.tiers['blocked'].escalates).toBe(true)
    expect(DEFAULT_CONFIG.tiers['idle-long'].escalates).toBe(true)
    expect(DEFAULT_CONFIG.tiers['stalled'].escalates).toBe(false)
  })
})

describe('mergeConfig', () => {
  it('deep-merges partial user config over defaults', () => {
    const cfg = mergeConfig({ escalation: { activeDelayMs: 60_000 } })
    expect(cfg.escalation.activeDelayMs).toBe(60_000)
    expect(cfg.escalation.idleDelayMs).toBe(45_000)
  })

  it('rejects an unknown detailLevel', () => {
    expect(() => mergeConfig({ detailLevel: 'loud' })).toThrow(/detailLevel/)
  })

  it('rejects a negative delay', () => {
    expect(() => mergeConfig({ escalation: { activeDelayMs: -1 } })).toThrow(/activeDelayMs/)
  })
})

describe('escalateDelayFor', () => {
  it('uses the active delay when the machine is in use', () => {
    expect(escalateDelayFor(DEFAULT_CONFIG, 'blocked', 0)).toBe(180_000)
  })

  it('uses the idle delay once idle passes the threshold', () => {
    expect(escalateDelayFor(DEFAULT_CONFIG, 'blocked', 90_000)).toBe(45_000)
  })

  it('returns null for a tier that never escalates', () => {
    expect(escalateDelayFor(DEFAULT_CONFIG, 'idle-short', 90_000)).toBeNull()
  })

  it('lets a per-tier override beat the adaptive base', () => {
    const cfg = mergeConfig({ tiers: { blocked: { escalateDelayMs: 5_000 } } })
    expect(escalateDelayFor(cfg, 'blocked', 0)).toBe(5_000)
    expect(escalateDelayFor(cfg, 'blocked', 90_000)).toBe(5_000)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/shared/test/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 3: Implement config**

`packages/shared/src/config.ts`:

```ts
import { readFileSync } from 'node:fs'
import type { Tier } from './types.js'
import { configPath } from './paths.js'

export interface TierConfig {
  enabled: boolean
  sound: string | null
  escalates: boolean
  escalateDelayMs?: number
}

export interface NudgeConfig {
  detailLevel: 'minimal' | 'full'
  muted: boolean
  escalation: {
    activeDelayMs: number
    idleDelayMs: number
    idleThresholdMs: number
    /** A turn at or above this duration is idle-long rather than idle-short. */
    longTurnMs: number
    localRepeat: number
    localRepeatIntervalMs: number
    phoneRepeat: number
    phoneRepeatIntervalMs: number
  }
  quietHours: { start: string; end: string } | null
  watchdog: { stallAfterMs: number; sessionTtlMs: number; tickMs: number }
  tiers: Record<Tier, TierConfig>
  channel: { id: string; options: Record<string, unknown> } | null
  retentionDays: number
  projects: Record<string, { muted?: boolean }>
}

export const DEFAULT_CONFIG: NudgeConfig = {
  detailLevel: 'minimal',
  muted: false,
  escalation: {
    activeDelayMs: 180_000,
    idleDelayMs: 45_000,
    idleThresholdMs: 60_000,
    longTurnMs: 180_000,
    localRepeat: 3,
    localRepeatIntervalMs: 60_000,
    phoneRepeat: 0,
    phoneRepeatIntervalMs: 300_000,
  },
  quietHours: null,
  watchdog: { stallAfterMs: 900_000, sessionTtlMs: 86_400_000, tickMs: 30_000 },
  tiers: {
    'blocked':    { enabled: true, sound: 'blocked',   escalates: true },
    'idle-long':  { enabled: true, sound: 'done',      escalates: true },
    'idle-short': { enabled: true, sound: null,        escalates: false },
    'stalled':    { enabled: true, sound: 'stalled',   escalates: false },
  },
  channel: null,
  retentionDays: 30,
  projects: {},
}

const TIERS: Tier[] = ['blocked', 'idle-long', 'idle-short', 'stalled']

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireNonNegative(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`config: ${name} must be a non-negative number, got ${JSON.stringify(v)}`)
  }
  return v
}

export function mergeConfig(partial: unknown): NudgeConfig {
  if (partial === undefined || partial === null) return structuredClone(DEFAULT_CONFIG)
  if (!isObj(partial)) throw new Error('config: top level must be an object')

  const cfg = structuredClone(DEFAULT_CONFIG)

  if ('detailLevel' in partial) {
    const d = partial.detailLevel
    if (d !== 'minimal' && d !== 'full') {
      throw new Error(`config: detailLevel must be "minimal" or "full", got ${JSON.stringify(d)}`)
    }
    cfg.detailLevel = d
  }

  if ('muted' in partial) {
    if (typeof partial.muted !== 'boolean') throw new Error('config: muted must be a boolean')
    cfg.muted = partial.muted
  }

  if (isObj(partial.escalation)) {
    for (const [k, v] of Object.entries(partial.escalation)) {
      if (!(k in cfg.escalation)) throw new Error(`config: unknown escalation key "${k}"`)
      ;(cfg.escalation as Record<string, number>)[k] = requireNonNegative(v, `escalation.${k}`)
    }
  }

  if (isObj(partial.watchdog)) {
    for (const [k, v] of Object.entries(partial.watchdog)) {
      if (!(k in cfg.watchdog)) throw new Error(`config: unknown watchdog key "${k}"`)
      ;(cfg.watchdog as Record<string, number>)[k] = requireNonNegative(v, `watchdog.${k}`)
    }
  }

  if (partial.quietHours === null) cfg.quietHours = null
  else if (isObj(partial.quietHours)) {
    const { start, end } = partial.quietHours
    const re = /^([01]\d|2[0-3]):[0-5]\d$/
    if (typeof start !== 'string' || !re.test(start)) throw new Error('config: quietHours.start must be "HH:MM"')
    if (typeof end !== 'string' || !re.test(end)) throw new Error('config: quietHours.end must be "HH:MM"')
    cfg.quietHours = { start, end }
  }

  if (isObj(partial.tiers)) {
    for (const [name, raw] of Object.entries(partial.tiers)) {
      if (!TIERS.includes(name as Tier)) throw new Error(`config: unknown tier "${name}"`)
      if (!isObj(raw)) throw new Error(`config: tiers.${name} must be an object`)
      const t = cfg.tiers[name as Tier]
      if ('enabled' in raw) {
        if (typeof raw.enabled !== 'boolean') throw new Error(`config: tiers.${name}.enabled must be a boolean`)
        t.enabled = raw.enabled
      }
      if ('escalates' in raw) {
        if (typeof raw.escalates !== 'boolean') throw new Error(`config: tiers.${name}.escalates must be a boolean`)
        t.escalates = raw.escalates
      }
      if ('sound' in raw) {
        if (raw.sound !== null && typeof raw.sound !== 'string') {
          throw new Error(`config: tiers.${name}.sound must be a string or null`)
        }
        t.sound = raw.sound as string | null
      }
      if ('escalateDelayMs' in raw) {
        t.escalateDelayMs = requireNonNegative(raw.escalateDelayMs, `tiers.${name}.escalateDelayMs`)
      }
    }
  }

  if (partial.channel === null) cfg.channel = null
  else if (isObj(partial.channel)) {
    if (typeof partial.channel.id !== 'string' || partial.channel.id.length === 0) {
      throw new Error('config: channel.id must be a non-empty string')
    }
    cfg.channel = {
      id: partial.channel.id,
      options: isObj(partial.channel.options) ? partial.channel.options : {},
    }
  }

  if ('retentionDays' in partial) {
    cfg.retentionDays = requireNonNegative(partial.retentionDays, 'retentionDays')
  }

  if (isObj(partial.projects)) {
    for (const [k, v] of Object.entries(partial.projects)) {
      if (!isObj(v)) throw new Error(`config: projects["${k}"] must be an object`)
      cfg.projects[k] = { muted: v.muted === true }
    }
  }

  return cfg
}

export function loadConfig(path = configPath()): NudgeConfig {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_CONFIG)
    throw err
  }
  return mergeConfig(JSON.parse(raw))
}

/**
 * Resolve the escalation delay for a tier.
 * Precedence: per-tier override -> idle-adaptive base.
 * Returns null when the tier must never reach a channel.
 */
export function escalateDelayFor(cfg: NudgeConfig, tier: Tier, idleMs: number): number | null {
  const t = cfg.tiers[tier]
  if (!t.enabled || !t.escalates) return null
  if (t.escalateDelayMs !== undefined) return t.escalateDelayMs
  return idleMs >= cfg.escalation.idleThresholdMs
    ? cfg.escalation.idleDelayMs
    : cfg.escalation.activeDelayMs
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/shared/test/config.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/test/config.test.ts
git commit -m "feat(shared): config with spec defaults, validation, and escalation precedence"
```

---

## Task 4: Capture real Claude Code hook payloads as fixtures

**Files:**
- Create: `tools/capture-hooks.mjs`
- Create: `packages/engine/test/fixtures/README.md`
- Create: `packages/engine/test/fixtures/*.json` (generated)

**Interfaces:**
- Consumes: nothing.
- Produces: `packages/engine/test/fixtures/<HookName>.json` — one real captured payload per hook, used by Task 5's normalizer tests.

The spec states this explicitly: **do not code against assumed field names.** Capture first, then normalize against what Claude Code actually sends. This task is the reason the rest of the plan can be confident.

- [ ] **Step 1: Write the capture script**

`tools/capture-hooks.mjs`:

```js
#!/usr/bin/env node
// Appends every hook payload Claude Code sends to a JSONL file, then exits 0.
// Wire this in temporarily via a settings.json hook entry, run a real session,
// then convert the JSONL into per-hook fixture files.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const OUT = process.env.NUDGE_CAPTURE_OUT ?? '/tmp/nudge-hook-capture.jsonl'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  try {
    mkdirSync(dirname(OUT), { recursive: true })
    appendFileSync(OUT, raw.trim() + '\n')
  } catch {
    // Capture must never break the session being observed.
  }
  process.exit(0)
})
setTimeout(() => process.exit(0), 500).unref()
```

- [ ] **Step 2: Wire it into settings.json temporarily and run a real session**

Add this to `~/.claude/settings.json` under `hooks` (back the file up first — `cp ~/.claude/settings.json ~/.claude/settings.json.capture-backup`):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/tools/capture-hooks.mjs" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/tools/capture-hooks.mjs" }] }],
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/tools/capture-hooks.mjs" }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/tools/capture-hooks.mjs" }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/tools/capture-hooks.mjs" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/tools/capture-hooks.mjs" }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "node /ABSOLUTE/PATH/tools/capture-hooks.mjs" }] }]
  }
}
```

Then, in a scratch directory, run a Claude Code session that exercises every hook: send a prompt, let it read a file (PreToolUse/PostToolUse), trigger a permission prompt by asking it to run a command not on the allowlist (Notification), let the turn end (Stop), then exit the session (SessionEnd).

- [ ] **Step 3: Verify every hook was captured**

Run:

```bash
node -e "const l=require('fs').readFileSync('/tmp/nudge-hook-capture.jsonl','utf8').trim().split('\n');\
const s=new Set(l.map(x=>JSON.parse(x).hook_event_name));console.log([...s].sort())"
```

Expected: all seven of `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`.

If any is missing, exercise that path and re-check before continuing. **Do not proceed with a missing hook** — Task 5 depends on real field names.

- [ ] **Step 4: Convert to fixtures and restore settings.json**

```bash
mkdir -p packages/engine/test/fixtures
node -e "const fs=require('fs');\
const l=fs.readFileSync('/tmp/nudge-hook-capture.jsonl','utf8').trim().split('\n').map(JSON.parse);\
const seen={};for(const e of l){if(!seen[e.hook_event_name])seen[e.hook_event_name]=e;}\
for(const[k,v]of Object.entries(seen))fs.writeFileSync('packages/engine/test/fixtures/'+k+'.json',JSON.stringify(v,null,2)+'\n');\
console.log('wrote',Object.keys(seen).length,'fixtures')"

cp ~/.claude/settings.json.capture-backup ~/.claude/settings.json
```

- [ ] **Step 5: Scrub the fixtures**

Open each file in `packages/engine/test/fixtures/`. Replace real absolute paths with `/tmp/fixture-project`, real session ids with `fixture-session-1`, and any command text that contains a host, token, or credential with a harmless placeholder. **These files go into a public repo.**

Write `packages/engine/test/fixtures/README.md`:

```markdown
# Captured hook fixtures

Real Claude Code hook payloads, captured with `tools/capture-hooks.mjs`,
then scrubbed of absolute paths, session ids, and anything resembling a
credential.

Regenerate when Claude Code changes its hook payload shape. The normalizer
tests in `packages/engine/test/normalize.test.ts` read these directly, so a
payload change surfaces as a test failure rather than a silent runtime bug.
```

- [ ] **Step 6: Commit**

```bash
git add tools/capture-hooks.mjs packages/engine/test/fixtures
git commit -m "test(engine): capture and scrub real Claude Code hook payload fixtures"
```

---

## Task 5: Event normalization

**Files:**
- Create: `packages/engine/src/normalize.ts`
- Test: `packages/engine/test/normalize.test.ts`

**Interfaces:**
- Consumes: `NudgeEvent`, `HookName`, `Surface` from `@nudge/shared/types`; fixtures from Task 4.
- Produces: `normalize(raw: unknown, surface: Surface | undefined, ts: number): NudgeEvent | null` — returns `null` for a payload that is not a hook Nudge subscribes to, rather than throwing.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { normalize } from '../src/normalize.js'
import { UNKNOWN_SURFACE } from '@nudge/shared/types'

const FIXTURES = join(import.meta.dirname, 'fixtures')
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))

describe('normalize against real captured payloads', () => {
  const names = readdirSync(FIXTURES)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))

  it('has fixtures for all seven subscribed hooks', () => {
    expect(names.sort()).toEqual([
      'Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd',
      'SessionStart', 'Stop', 'UserPromptSubmit',
    ])
  })

  for (const name of names) {
    it(`normalizes ${name} into a complete NudgeEvent`, () => {
      const ev = normalize(load(name), UNKNOWN_SURFACE, 1234)
      expect(ev).not.toBeNull()
      expect(ev!.source).toBe('claude-code')
      expect(ev!.hook).toBe(name)
      expect(ev!.sessionId).toBeTruthy()
      expect(ev!.cwd).toBeTruthy()
      expect(ev!.project).toBe('fixture-project')
      expect(ev!.ts).toBe(1234)
    })
  }

  it('carries the Notification message through', () => {
    const ev = normalize(load('Notification'), UNKNOWN_SURFACE, 1)
    expect(typeof ev!.message).toBe('string')
    expect(ev!.message!.length).toBeGreaterThan(0)
  })

  it('carries the tool name through on PreToolUse', () => {
    const ev = normalize(load('PreToolUse'), UNKNOWN_SURFACE, 1)
    expect(typeof ev!.tool).toBe('string')
  })
})

describe('normalize edge cases', () => {
  it('returns null for a hook we do not subscribe to', () => {
    const ev = normalize(
      { hook_event_name: 'SubagentStop', session_id: 's', cwd: '/tmp/x' },
      UNKNOWN_SURFACE, 1,
    )
    expect(ev).toBeNull()
  })

  it('returns null for a payload missing session_id', () => {
    expect(normalize({ hook_event_name: 'Stop', cwd: '/tmp/x' }, UNKNOWN_SURFACE, 1)).toBeNull()
  })

  it('returns null for a non-object payload', () => {
    expect(normalize('nope', UNKNOWN_SURFACE, 1)).toBeNull()
    expect(normalize(null, UNKNOWN_SURFACE, 1)).toBeNull()
  })

  it('derives project from the last path segment, trailing slash or not', () => {
    const a = normalize({ hook_event_name: 'Stop', session_id: 's', cwd: '/a/b/my-repo' }, UNKNOWN_SURFACE, 1)
    const b = normalize({ hook_event_name: 'Stop', session_id: 's', cwd: '/a/b/my-repo/' }, UNKNOWN_SURFACE, 1)
    expect(a!.project).toBe('my-repo')
    expect(b!.project).toBe('my-repo')
  })

  it('attaches the surface only on SessionStart', () => {
    const surface = { kind: 'vscode' as const, termProgram: 'vscode' }
    const start = normalize({ hook_event_name: 'SessionStart', session_id: 's', cwd: '/a/p' }, surface, 1)
    const stop = normalize({ hook_event_name: 'Stop', session_id: 's', cwd: '/a/p' }, surface, 1)
    expect(start!.surface).toEqual(surface)
    expect(stop!.surface).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/normalize.test.ts`
Expected: FAIL — `Cannot find module '../src/normalize.js'`

- [ ] **Step 3: Implement the normalizer**

Before writing this, **open the captured fixtures and confirm the field names below match**. Adjust the implementation to reality, not the other way around — then adjust these notes.

`packages/engine/src/normalize.ts`:

```ts
import { basename } from 'node:path'
import type { HookName, NudgeEvent, Surface } from '@nudge/shared/types'

const SUBSCRIBED: readonly HookName[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
]

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Strip trailing separators so `/a/b/repo/` and `/a/b/repo` agree. */
function projectOf(cwd: string): string {
  return basename(cwd.replace(/[\/\\]+$/, '')) || cwd
}

/**
 * Convert a raw Claude Code hook payload into a NudgeEvent.
 * Returns null for anything we do not subscribe to or cannot identify —
 * the engine drops nulls silently rather than failing a session's hook.
 */
export function normalize(raw: unknown, surface: Surface | undefined, ts: number): NudgeEvent | null {
  if (!isObj(raw)) return null

  const hook = str(raw.hook_event_name) as HookName | undefined
  if (!hook || !SUBSCRIBED.includes(hook)) return null

  const sessionId = str(raw.session_id)
  const cwd = str(raw.cwd)
  if (!sessionId || !cwd) return null

  const ev: NudgeEvent = {
    source: 'claude-code',
    sessionId,
    hook,
    cwd,
    project: projectOf(cwd),
    ts,
  }

  const message = str(raw.message)
  if (message) ev.message = message

  const tool = str(raw.tool_name)
  if (tool) ev.tool = tool

  // The surface fingerprint is only meaningful at session start; carrying it
  // on every event would bloat the wire format for no gain.
  if (hook === 'SessionStart' && surface) ev.surface = surface

  return ev
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/normalize.test.ts`
Expected: PASS

If the fixture-driven tests fail on `message` or `tool`, the real field names differ from `message` / `tool_name`. **Fix `normalize.ts` to match the fixtures**, and note the actual names in `packages/engine/test/fixtures/README.md`.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/normalize.ts packages/engine/test/normalize.test.ts
git commit -m "feat(engine): normalize Claude Code hook payloads, verified against real fixtures"
```

---

## Task 6: Session state machine and tier assignment

**Files:**
- Create: `packages/engine/src/state.ts`
- Test: `packages/engine/test/state.test.ts`

**Interfaces:**
- Consumes: `NudgeEvent`, `SessionState`, `Tier`, `UNKNOWN_SURFACE` from `@nudge/shared/types`; `NudgeConfig` from `@nudge/shared/config`; `Clock` from `./clock.js`.
- Produces:
  - `type Transition = { session: SessionState; started: Tier | null; cleared: Tier | null; duplicate: boolean }`
  - `class SessionStore` with `apply(ev: NudgeEvent): Transition`, `list(): SessionState[]`, `get(id: string): SessionState | undefined`, `snooze(id: string, ms: number): void`, `resolve(id: string): Transition | null`, `markStalled(id: string): Transition | null`, `drop(id: string): void`, `idsOlderThan(ms: number): string[]`.

`started` is the tier that just began waiting (null if none), `cleared` is the tier that just stopped waiting, `duplicate` is true when a repeat `Notification` matched the existing message — the de-duplication rule from spec §6.6.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SessionStore } from '../src/state.js'
import { FakeClock } from '../src/clock.js'
import { DEFAULT_CONFIG } from '@nudge/shared/config'
import type { HookName, NudgeEvent } from '@nudge/shared/types'

let clock: FakeClock
let store: SessionStore

const ev = (hook: HookName, extra: Partial<NudgeEvent> = {}): NudgeEvent => ({
  source: 'claude-code',
  sessionId: 's1',
  hook,
  cwd: '/a/my-repo',
  project: 'my-repo',
  ts: clock.now(),
  ...extra,
})

beforeEach(() => {
  clock = new FakeClock(0)
  store = new SessionStore(DEFAULT_CONFIG, clock)
})

describe('the governing rule: any event clears prior waiting state', () => {
  it('clears a blocked session when the tool actually runs', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    const blocked = store.apply(ev('Notification', { message: 'Allow Bash?' }))
    expect(blocked.started).toBe('blocked')
    expect(blocked.session.status).toBe('blocked')

    clock.advance(5_000)
    const cleared = store.apply(ev('PostToolUse', { tool: 'Bash' }))
    expect(cleared.cleared).toBe('blocked')
    expect(cleared.session.status).toBe('running')
    expect(cleared.session.waitingSince).toBeNull()
  })

  it('clears a blocked session when the user types a reply', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('Notification', { message: 'Which file?' }))
    const cleared = store.apply(ev('UserPromptSubmit'))
    expect(cleared.cleared).toBe('blocked')
    expect(cleared.session.status).toBe('running')
  })

  it('clears an idle session when the user sends the next prompt', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    store.apply(ev('Stop'))
    const cleared = store.apply(ev('UserPromptSubmit'))
    expect(cleared.cleared).toBe('idle-short')
    expect(cleared.session.status).toBe('running')
  })
})

describe('tier assignment', () => {
  it('assigns idle-short when the turn was quick', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    clock.advance(60_000)
    const t = store.apply(ev('Stop'))
    expect(t.started).toBe('idle-short')
  })

  it('assigns idle-long when the turn ran past three minutes', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    clock.advance(200_000)
    const t = store.apply(ev('Stop'))
    expect(t.started).toBe('idle-long')
  })

  it('treats a Stop with no known turn start as idle-short', () => {
    const t = store.apply(ev('Stop'))
    expect(t.started).toBe('idle-short')
  })

  it('records the notification message on a blocked session', () => {
    store.apply(ev('Notification', { message: 'Allow Bash(rm)?' }))
    expect(store.get('s1')!.message).toBe('Allow Bash(rm)?')
  })
})

describe('de-duplication', () => {
  it('flags a repeat Notification with the same message as duplicate', () => {
    store.apply(ev('Notification', { message: 'Allow Bash?' }))
    clock.advance(60_000)
    const again = store.apply(ev('Notification', { message: 'Allow Bash?' }))
    expect(again.duplicate).toBe(true)
    expect(again.started).toBeNull()
  })

  it('does not flag a Notification with a different message', () => {
    store.apply(ev('Notification', { message: 'Allow Bash?' }))
    const other = store.apply(ev('Notification', { message: 'Allow Write?' }))
    expect(other.duplicate).toBe(false)
    expect(other.started).toBe('blocked')
  })

  it('keeps the original waitingSince across a duplicate', () => {
    store.apply(ev('Notification', { message: 'Allow Bash?' }))
    const first = store.get('s1')!.waitingSince
    clock.advance(60_000)
    store.apply(ev('Notification', { message: 'Allow Bash?' }))
    expect(store.get('s1')!.waitingSince).toBe(first)
  })
})

describe('session identity and lifecycle', () => {
  it('tracks concurrent sessions independently', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('SessionStart', { sessionId: 's2', cwd: '/a/other', project: 'other' }))
    store.apply(ev('Notification', { message: 'Allow?' }))
    expect(store.get('s1')!.status).toBe('blocked')
    expect(store.get('s2')!.status).toBe('running')
    expect(store.list()).toHaveLength(2)
  })

  it('retains the surface captured at SessionStart', () => {
    store.apply(ev('SessionStart', { surface: { kind: 'vscode', termProgram: 'vscode' } }))
    store.apply(ev('Stop'))
    expect(store.get('s1')!.surface.kind).toBe('vscode')
  })

  it('removes a session on SessionEnd', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('Notification', { message: 'Allow?' }))
    const t = store.apply(ev('SessionEnd'))
    expect(t.cleared).toBe('blocked')
    expect(store.get('s1')).toBeUndefined()
  })

  it('lists sessions with no SessionStart, created lazily', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    expect(store.get('s1')!.project).toBe('my-repo')
  })
})

describe('snooze and manual resolve', () => {
  it('records a snooze deadline', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    store.snooze('s1', 600_000)
    expect(store.get('s1')!.snoozedUntil).toBe(600_000)
  })

  it('clears waiting state on manual resolve', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    const t = store.resolve('s1')
    expect(t!.cleared).toBe('blocked')
    expect(store.get('s1')!.status).toBe('running')
  })

  it('returns null resolving a session that is not waiting', () => {
    store.apply(ev('SessionStart'))
    expect(store.resolve('s1')).toBeNull()
  })
})

describe('stall marking and TTL', () => {
  it('marks a running session stalled', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('PreToolUse', { tool: 'Bash' }))
    const t = store.markStalled('s1')
    expect(t!.started).toBe('stalled')
    expect(store.get('s1')!.status).toBe('stalled')
  })

  it('refuses to mark a blocked session stalled', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    expect(store.markStalled('s1')).toBeNull()
  })

  it('reports sessions older than a cutoff', () => {
    store.apply(ev('SessionStart'))
    clock.advance(100_000)
    store.apply(ev('SessionStart', { sessionId: 's2' }))
    expect(store.idsOlderThan(50_000)).toEqual(['s1'])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/state.test.ts`
Expected: FAIL — `Cannot find module '../src/state.js'`

- [ ] **Step 3: Implement the store**

`packages/engine/src/state.ts`:

```ts
import type { NudgeEvent, SessionState, Tier } from '@nudge/shared/types'
import { UNKNOWN_SURFACE } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'
import type { Clock } from './clock.js'

export interface Transition {
  session: SessionState
  started: Tier | null
  cleared: Tier | null
  duplicate: boolean
}

export class SessionStore {
  #sessions = new Map<string, SessionState>()

  constructor(private cfg: NudgeConfig, private clock: Clock) {}

  list(): SessionState[] { return [...this.#sessions.values()] }
  get(id: string): SessionState | undefined { return this.#sessions.get(id) }
  drop(id: string): void { this.#sessions.delete(id) }

  idsOlderThan(ms: number): string[] {
    const cutoff = this.clock.now() - ms
    return this.list().filter(s => s.lastEventAt < cutoff).map(s => s.sessionId)
  }

  #ensure(ev: NudgeEvent): SessionState {
    let s = this.#sessions.get(ev.sessionId)
    if (!s) {
      s = {
        sessionId: ev.sessionId,
        project: ev.project,
        cwd: ev.cwd,
        surface: ev.surface ?? UNKNOWN_SURFACE,
        status: 'running',
        tier: null,
        waitingSince: null,
        turnStartedAt: null,
        lastEventAt: ev.ts,
        message: null,
        snoozedUntil: null,
        pushFailed: false,
      }
      this.#sessions.set(ev.sessionId, s)
    }
    // A surface only ever arrives on SessionStart; never downgrade a known one.
    if (ev.surface && ev.surface.kind !== 'unknown') s.surface = ev.surface
    return s
  }

  #clearWaiting(s: SessionState): Tier | null {
    if (s.status !== 'blocked' && s.status !== 'idle' && s.status !== 'stalled') return null
    const was = s.tier
    s.status = 'running'
    s.tier = null
    s.waitingSince = null
    s.message = null
    s.pushFailed = false
    return was
  }

  /**
   * The governing rule: every event first clears any pending waiting state,
   * then applies whatever the new event implies.
   */
  apply(ev: NudgeEvent): Transition {
    const s = this.#ensure(ev)

    // De-duplication: a repeat Notification with the same message keeps the
    // original waitingSince and does not re-alert (spec 6.6).
    if (ev.hook === 'Notification' && s.status === 'blocked' && s.message === (ev.message ?? null)) {
      s.lastEventAt = ev.ts
      return { session: s, started: null, cleared: null, duplicate: true }
    }

    const cleared = this.#clearWaiting(s)
    s.lastEventAt = ev.ts

    let started: Tier | null = null

    switch (ev.hook) {
      case 'UserPromptSubmit':
        s.turnStartedAt = ev.ts
        break

      case 'Notification':
        s.status = 'blocked'
        s.tier = 'blocked'
        s.waitingSince = ev.ts
        s.message = ev.message ?? null
        started = 'blocked'
        break

      case 'Stop': {
        const ranFor = s.turnStartedAt === null ? 0 : ev.ts - s.turnStartedAt
        const tier: Tier = ranFor >= this.cfg.escalation.longTurnMs ? 'idle-long' : 'idle-short'
        s.status = 'idle'
        s.tier = tier
        s.waitingSince = ev.ts
        s.turnStartedAt = null
        started = tier
        break
      }

      case 'SessionEnd':
        s.status = 'gone'
        this.#sessions.delete(ev.sessionId)
        break

      case 'SessionStart':
      case 'PreToolUse':
      case 'PostToolUse':
        break
    }

    return { session: s, started, cleared, duplicate: false }
  }

  snooze(id: string, ms: number): void {
    const s = this.#sessions.get(id)
    if (s) s.snoozedUntil = this.clock.now() + ms
  }

  resolve(id: string): Transition | null {
    const s = this.#sessions.get(id)
    if (!s) return null
    const cleared = this.#clearWaiting(s)
    if (cleared === null) return null
    return { session: s, started: null, cleared, duplicate: false }
  }

  /** Only a session believed to be mid-turn can stall. */
  markStalled(id: string): Transition | null {
    const s = this.#sessions.get(id)
    if (!s || s.status !== 'running') return null
    s.status = 'stalled'
    s.tier = 'stalled'
    s.waitingSince = this.clock.now()
    return { session: s, started: 'stalled', cleared: null, duplicate: false }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/state.test.ts`
Expected: PASS, 18 tests

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/state.ts packages/engine/test/state.test.ts
git commit -m "feat(engine): session state machine, tier assignment, and notification de-duplication"
```

---

## Task 7: Watchdog — stall detection and session TTL

**Files:**
- Create: `packages/engine/src/watchdog.ts`
- Test: `packages/engine/test/watchdog.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `Transition` from `./state.js`; `Clock`, `Cancel` from `./clock.js`; `NudgeConfig` from `@nudge/shared/config`.
- Produces: `class Watchdog` with `constructor(cfg: NudgeConfig, clock: Clock, store: SessionStore, onStall: (t: Transition) => void)`, `start(): Cancel`, `tick(): void`.

`tick()` is public so tests drive it directly rather than through timer plumbing.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/watchdog.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { SessionStore } from '../src/state.js'
import { Watchdog } from '../src/watchdog.js'
import { FakeClock } from '../src/clock.js'
import { mergeConfig } from '@nudge/shared/config'
import type { HookName, NudgeEvent } from '@nudge/shared/types'
import type { Transition } from '../src/state.js'

let clock: FakeClock
let store: SessionStore
let stalls: Transition[]
let wd: Watchdog

const cfg = mergeConfig({ watchdog: { stallAfterMs: 900_000, sessionTtlMs: 86_400_000, tickMs: 30_000 } })

const ev = (hook: HookName, extra: Partial<NudgeEvent> = {}): NudgeEvent => ({
  source: 'claude-code', sessionId: 's1', hook,
  cwd: '/a/my-repo', project: 'my-repo', ts: clock.now(), ...extra,
})

beforeEach(() => {
  clock = new FakeClock(0)
  store = new SessionStore(cfg, clock)
  stalls = []
  wd = new Watchdog(cfg, clock, store, t => stalls.push(t))
})

describe('stall detection', () => {
  it('does not stall a session that is still emitting events', () => {
    store.apply(ev('SessionStart'))
    clock.advance(800_000)
    store.apply(ev('PreToolUse', { tool: 'Bash', ts: clock.now() }))
    clock.advance(800_000)
    wd.tick()
    expect(stalls).toHaveLength(0)
  })

  it('stalls a running session silent past the threshold', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('PreToolUse', { tool: 'Bash' }))
    clock.advance(900_001)
    wd.tick()
    expect(stalls).toHaveLength(1)
    expect(stalls[0].started).toBe('stalled')
    expect(store.get('s1')!.status).toBe('stalled')
  })

  it('never stalls a blocked session — it is waiting on the human, not hung', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    clock.advance(900_001)
    wd.tick()
    expect(stalls).toHaveLength(0)
    expect(store.get('s1')!.status).toBe('blocked')
  })

  it('never stalls an idle session', () => {
    store.apply(ev('UserPromptSubmit'))
    store.apply(ev('Stop'))
    clock.advance(900_001)
    wd.tick()
    expect(stalls).toHaveLength(0)
  })

  it('stalls a session only once', () => {
    store.apply(ev('SessionStart'))
    clock.advance(900_001)
    wd.tick()
    clock.advance(900_001)
    wd.tick()
    expect(stalls).toHaveLength(1)
  })
})

describe('session TTL', () => {
  it('drops a session with no events past the TTL', () => {
    store.apply(ev('SessionStart'))
    clock.advance(86_400_001)
    wd.tick()
    expect(store.get('s1')).toBeUndefined()
  })

  it('keeps a session inside the TTL', () => {
    store.apply(ev('SessionStart'))
    clock.advance(86_000_000)
    wd.tick()
    expect(store.get('s1')).toBeDefined()
  })

  it('drops rather than stalls when both thresholds have passed', () => {
    store.apply(ev('SessionStart'))
    clock.advance(900_001)
    wd.tick()
    stalls.length = 0
    clock.advance(86_400_001)
    wd.tick()
    expect(store.get('s1')).toBeUndefined()
    expect(stalls).toHaveLength(0)
  })
})

describe('start/stop', () => {
  it('ticks on the configured interval until cancelled', () => {
    store.apply(ev('SessionStart'))
    const cancel = wd.start()
    clock.advance(900_001)
    expect(stalls).toHaveLength(1)
    cancel()
    expect(clock.pendingCount()).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/watchdog.test.ts`
Expected: FAIL — `Cannot find module '../src/watchdog.js'`

- [ ] **Step 3: Implement the watchdog**

`packages/engine/src/watchdog.ts`:

```ts
import type { NudgeConfig } from '@nudge/shared/config'
import type { Clock, Cancel } from './clock.js'
import type { SessionStore, Transition } from './state.js'

/**
 * Heuristic, and honest about it: a session sitting in PreToolUse on a
 * nine-minute test script is indistinguishable from a crashed one. Hence the
 * conservative default and no phone escalation unless explicitly enabled.
 */
export class Watchdog {
  constructor(
    private cfg: NudgeConfig,
    private clock: Clock,
    private store: SessionStore,
    private onStall: (t: Transition) => void,
  ) {}

  start(): Cancel {
    let cancelled = false
    let cancelTimer: Cancel = () => {}
    const loop = () => {
      if (cancelled) return
      this.tick()
      cancelTimer = this.clock.schedule(this.cfg.watchdog.tickMs, loop)
    }
    cancelTimer = this.clock.schedule(this.cfg.watchdog.tickMs, loop)
    return () => { cancelled = true; cancelTimer() }
  }

  tick(): void {
    // TTL first: an expired session should be dropped, not resurrected as stalled.
    for (const id of this.store.idsOlderThan(this.cfg.watchdog.sessionTtlMs)) {
      this.store.drop(id)
    }

    const cutoff = this.clock.now() - this.cfg.watchdog.stallAfterMs
    for (const s of this.store.list()) {
      if (s.status !== 'running') continue
      if (s.lastEventAt > cutoff) continue
      const t = this.store.markStalled(s.sessionId)
      if (t) this.onStall(t)
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/watchdog.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/watchdog.ts packages/engine/test/watchdog.test.ts
git commit -m "feat(engine): watchdog for stalled sessions and TTL expiry"
```

---

## Task 8: Suppression rules

**Files:**
- Create: `packages/engine/src/suppression.ts`
- Test: `packages/engine/test/suppression.test.ts`

**Interfaces:**
- Consumes: `SessionState`, `Tier` from `@nudge/shared/types`; `NudgeConfig` from `@nudge/shared/config`.
- Produces:
  - `type Suppression = 'none' | 'tier-disabled' | 'frontmost' | 'muted' | 'project-muted' | 'snoozed' | 'quiet-hours'`
  - `minutesOfDay(ts: number): number`
  - `inQuietHours(q: { start: string; end: string } | null, minutes: number): boolean`
  - `localSuppression(cfg, session, tier, frontmostSessionId, now): Suppression`
  - `phoneSuppression(cfg, session, tier, now, minutes): Suppression`

Priority order is the spec's: frontmost → mute → snooze → quiet hours. Quiet hours holds phone push only; local alerts still show.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/suppression.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { inQuietHours, localSuppression, phoneSuppression, minutesOfDay } from '../src/suppression.js'
import { mergeConfig, DEFAULT_CONFIG } from '@nudge/shared/config'
import type { SessionState } from '@nudge/shared/types'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 0, turnStartedAt: null, lastEventAt: 0,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

describe('inQuietHours', () => {
  it('handles a window that does not cross midnight', () => {
    const q = { start: '13:00', end: '14:00' }
    expect(inQuietHours(q, 12 * 60 + 59)).toBe(false)
    expect(inQuietHours(q, 13 * 60)).toBe(true)
    expect(inQuietHours(q, 13 * 60 + 59)).toBe(true)
    expect(inQuietHours(q, 14 * 60)).toBe(false)
  })

  it('handles a window that crosses midnight', () => {
    const q = { start: '23:00', end: '08:00' }
    expect(inQuietHours(q, 22 * 60 + 59)).toBe(false)
    expect(inQuietHours(q, 23 * 60)).toBe(true)
    expect(inQuietHours(q, 3 * 60)).toBe(true)
    expect(inQuietHours(q, 7 * 60 + 59)).toBe(true)
    expect(inQuietHours(q, 8 * 60)).toBe(false)
  })

  it('is never active when unconfigured', () => {
    expect(inQuietHours(null, 3 * 60)).toBe(false)
  })
})

describe('minutesOfDay', () => {
  it('derives local minutes from a timestamp', () => {
    const d = new Date(2026, 7, 10, 14, 30, 0)
    expect(minutesOfDay(d.getTime())).toBe(14 * 60 + 30)
  })
})

describe('localSuppression, in priority order', () => {
  it('passes an ordinary blocked session through', () => {
    expect(localSuppression(DEFAULT_CONFIG, session(), 'blocked', null, 0)).toBe('none')
  })

  it('suppresses a disabled tier', () => {
    const cfg = mergeConfig({ tiers: { blocked: { enabled: false } } })
    expect(localSuppression(cfg, session(), 'blocked', null, 0)).toBe('tier-disabled')
  })

  it('suppresses when the session window is already frontmost', () => {
    expect(localSuppression(DEFAULT_CONFIG, session(), 'blocked', 's1', 0)).toBe('frontmost')
  })

  it('does not suppress when a different session is frontmost', () => {
    expect(localSuppression(DEFAULT_CONFIG, session(), 'blocked', 's2', 0)).toBe('none')
  })

  it('suppresses under global mute', () => {
    const cfg = mergeConfig({ muted: true })
    expect(localSuppression(cfg, session(), 'blocked', null, 0)).toBe('muted')
  })

  it('suppresses under a per-project mute keyed by cwd', () => {
    const cfg = mergeConfig({ projects: { '/a/my-repo': { muted: true } } })
    expect(localSuppression(cfg, session(), 'blocked', null, 0)).toBe('project-muted')
  })

  it('suppresses while snoozed and resumes after', () => {
    const s = session({ snoozedUntil: 600_000 })
    expect(localSuppression(DEFAULT_CONFIG, s, 'blocked', null, 500_000)).toBe('snoozed')
    expect(localSuppression(DEFAULT_CONFIG, s, 'blocked', null, 600_001)).toBe('none')
  })

  it('ranks frontmost above mute', () => {
    const cfg = mergeConfig({ muted: true })
    expect(localSuppression(cfg, session(), 'blocked', 's1', 0)).toBe('frontmost')
  })
})

describe('phoneSuppression', () => {
  it('passes a blocked session through outside quiet hours', () => {
    expect(phoneSuppression(DEFAULT_CONFIG, session(), 'blocked', 0, 12 * 60)).toBe('none')
  })

  it('holds phone push during quiet hours', () => {
    const cfg = mergeConfig({ quietHours: { start: '23:00', end: '08:00' } })
    expect(phoneSuppression(cfg, session(), 'blocked', 0, 3 * 60)).toBe('quiet-hours')
  })

  it('still allows local alerts during quiet hours', () => {
    const cfg = mergeConfig({ quietHours: { start: '23:00', end: '08:00' } })
    expect(localSuppression(cfg, session(), 'blocked', null, 0)).toBe('none')
  })

  it('suppresses a non-escalating tier', () => {
    expect(phoneSuppression(DEFAULT_CONFIG, session(), 'idle-short', 0, 12 * 60)).toBe('tier-disabled')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/suppression.test.ts`
Expected: FAIL — `Cannot find module '../src/suppression.js'`

- [ ] **Step 3: Implement suppression**

`packages/engine/src/suppression.ts`:

```ts
import type { SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

export type Suppression =
  | 'none' | 'tier-disabled' | 'frontmost'
  | 'muted' | 'project-muted' | 'snoozed' | 'quiet-hours'

export function minutesOfDay(ts: number): number {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes()
}

function parseHM(hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}

/** Half-open [start, end); handles windows that cross midnight. */
export function inQuietHours(q: { start: string; end: string } | null, minutes: number): boolean {
  if (!q) return false
  const start = parseHM(q.start)
  const end = parseHM(q.end)
  if (start === end) return false
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

function shared(cfg: NudgeConfig, s: SessionState, now: number): Suppression {
  if (cfg.muted) return 'muted'
  if (cfg.projects[s.cwd]?.muted) return 'project-muted'
  if (s.snoozedUntil !== null && now < s.snoozedUntil) return 'snoozed'
  return 'none'
}

/**
 * Priority: tier disabled -> frontmost -> mute -> project mute -> snooze.
 * Quiet hours deliberately does NOT suppress local alerts.
 */
export function localSuppression(
  cfg: NudgeConfig,
  s: SessionState,
  tier: Tier,
  frontmostSessionId: string | null,
  now: number,
): Suppression {
  if (!cfg.tiers[tier].enabled) return 'tier-disabled'
  if (frontmostSessionId !== null && frontmostSessionId === s.sessionId) return 'frontmost'
  return shared(cfg, s, now)
}

export function phoneSuppression(
  cfg: NudgeConfig,
  s: SessionState,
  tier: Tier,
  now: number,
  minutes: number,
): Suppression {
  const t = cfg.tiers[tier]
  if (!t.enabled || !t.escalates) return 'tier-disabled'
  const base = shared(cfg, s, now)
  if (base !== 'none') return base
  if (inQuietHours(cfg.quietHours, minutes)) return 'quiet-hours'
  return 'none'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/suppression.test.ts`
Expected: PASS, 16 tests

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/suppression.ts packages/engine/test/suppression.test.ts
git commit -m "feat(engine): suppression rules for mute, snooze, frontmost, and quiet hours"
```

---

## Task 9: The escalation ladder

**Files:**
- Create: `packages/engine/src/escalation.ts`
- Test: `packages/engine/test/escalation.test.ts`

**Interfaces:**
- Consumes: `SessionState`, `Tier`; `NudgeConfig`, `escalateDelayFor`; `Clock`, `Cancel`.
- Produces:
  - `interface EscalatorDeps { cfg: NudgeConfig; clock: Clock; idleMs: () => number; onLocal: (s: SessionState, tier: Tier, repeat: number) => void; onPhone: (s: SessionState, tier: Tier, repeat: number) => void }`
  - `class Escalator` with `begin(s: SessionState, tier: Tier): void`, `cancel(sessionId: string): void`, `cancelAll(): void`, `activeCount(): number`.

This implements spec §7.1 exactly: local at t=0, local repeats, phone at the adaptive delay, optional phone repeats, everything cancelled the moment the session stops waiting.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/escalation.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { Escalator } from '../src/escalation.js'
import { FakeClock } from '../src/clock.js'
import { mergeConfig, DEFAULT_CONFIG } from '@nudge/shared/config'
import type { SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 0, turnStartedAt: null, lastEventAt: 0,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

let clock: FakeClock
let local: Array<{ tier: Tier; repeat: number }>
let phone: Array<{ tier: Tier; repeat: number }>

function build(cfg = DEFAULT_CONFIG, idleMs = 0) {
  clock = new FakeClock(0)
  local = []
  phone = []
  return new Escalator({
    cfg, clock,
    idleMs: () => idleMs,
    onLocal: (_s, tier, repeat) => local.push({ tier, repeat }),
    onPhone: (_s, tier, repeat) => phone.push({ tier, repeat }),
  })
}

describe('local alerting', () => {
  it('fires immediately at t=0', () => {
    const e = build()
    e.begin(session(), 'blocked')
    expect(local).toEqual([{ tier: 'blocked', repeat: 0 }])
  })

  it('repeats three times at sixty seconds apart, then stops', () => {
    const e = build()
    e.begin(session(), 'blocked')
    clock.advance(60_000); expect(local).toHaveLength(2)
    clock.advance(60_000); expect(local).toHaveLength(3)
    clock.advance(60_000); expect(local).toHaveLength(4)
    clock.advance(600_000); expect(local).toHaveLength(4)
    expect(local.map(l => l.repeat)).toEqual([0, 1, 2, 3])
  })
})

describe('phone escalation timing', () => {
  it('pushes after the active delay when the machine is in use', () => {
    const e = build(DEFAULT_CONFIG, 0)
    e.begin(session(), 'blocked')
    clock.advance(179_999); expect(phone).toHaveLength(0)
    clock.advance(2); expect(phone).toEqual([{ tier: 'blocked', repeat: 0 }])
  })

  it('pushes after the idle delay when the human has walked away', () => {
    const e = build(DEFAULT_CONFIG, 90_000)
    e.begin(session(), 'blocked')
    clock.advance(44_999); expect(phone).toHaveLength(0)
    clock.advance(2); expect(phone).toHaveLength(1)
  })

  it('never pushes for a non-escalating tier', () => {
    const e = build()
    e.begin(session({ tier: 'idle-short' }), 'idle-short')
    clock.advance(3_600_000)
    expect(phone).toHaveLength(0)
  })

  it('still fires the local alert for a non-escalating but enabled tier', () => {
    const e = build()
    e.begin(session({ tier: 'idle-short' }), 'idle-short')
    expect(local).toHaveLength(1)
  })

  it('honours a per-tier delay override regardless of idle state', () => {
    const cfg = mergeConfig({ tiers: { blocked: { escalateDelayMs: 5_000 } } })
    const e = build(cfg as NudgeConfig, 90_000)
    e.begin(session(), 'blocked')
    clock.advance(5_001)
    expect(phone).toHaveLength(1)
  })

  it('does not repeat the phone push by default', () => {
    const e = build()
    e.begin(session(), 'blocked')
    clock.advance(3_600_000)
    expect(phone).toHaveLength(1)
  })

  it('repeats the phone push when configured', () => {
    const cfg = mergeConfig({ escalation: { phoneRepeat: 2, phoneRepeatIntervalMs: 300_000 } })
    const e = build(cfg as NudgeConfig)
    e.begin(session(), 'blocked')
    clock.advance(180_000); expect(phone).toHaveLength(1)
    clock.advance(300_000); expect(phone).toHaveLength(2)
    clock.advance(300_000); expect(phone).toHaveLength(3)
    clock.advance(900_000); expect(phone).toHaveLength(3)
  })

  it('reads idle state at push time, not at begin time', () => {
    let idle = 0
    clock = new FakeClock(0)
    local = []; phone = []
    const e = new Escalator({
      cfg: DEFAULT_CONFIG, clock,
      idleMs: () => idle,
      onLocal: (_s, tier, repeat) => local.push({ tier, repeat }),
      onPhone: (_s, tier, repeat) => phone.push({ tier, repeat }),
    })
    e.begin(session(), 'blocked')
    idle = 90_000
    clock.advance(45_001)
    expect(phone).toHaveLength(1)
  })
})

describe('cancellation', () => {
  it('cancels every pending timer for a session', () => {
    const e = build()
    e.begin(session(), 'blocked')
    e.cancel('s1')
    clock.advance(3_600_000)
    expect(local).toHaveLength(1)
    expect(phone).toHaveLength(0)
    expect(e.activeCount()).toBe(0)
    expect(clock.pendingCount()).toBe(0)
  })

  it('replaces timers when begin is called twice for one session', () => {
    const e = build()
    e.begin(session(), 'blocked')
    e.begin(session(), 'blocked')
    expect(e.activeCount()).toBe(1)
    clock.advance(180_001)
    expect(phone).toHaveLength(1)
  })

  it('cancelAll clears every session', () => {
    const e = build()
    e.begin(session(), 'blocked')
    e.begin(session({ sessionId: 's2' }), 'blocked')
    expect(e.activeCount()).toBe(2)
    e.cancelAll()
    expect(e.activeCount()).toBe(0)
    expect(clock.pendingCount()).toBe(0)
  })

  it('runs two sessions on independent ladders', () => {
    const e = build()
    e.begin(session(), 'blocked')
    clock.advance(100_000)
    e.begin(session({ sessionId: 's2' }), 'blocked')
    clock.advance(80_001)
    expect(phone).toHaveLength(1)
    clock.advance(100_000)
    expect(phone).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/escalation.test.ts`
Expected: FAIL — `Cannot find module '../src/escalation.js'`

- [ ] **Step 3: Implement the ladder**

`packages/engine/src/escalation.ts`:

```ts
import type { SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'
import { escalateDelayFor } from '@nudge/shared/config'
import type { Clock, Cancel } from './clock.js'

export interface EscalatorDeps {
  cfg: NudgeConfig
  clock: Clock
  /** How long the machine has been idle, read at the moment of decision. */
  idleMs: () => number
  onLocal: (s: SessionState, tier: Tier, repeat: number) => void
  onPhone: (s: SessionState, tier: Tier, repeat: number) => void
}

export class Escalator {
  #timers = new Map<string, Cancel[]>()

  constructor(private d: EscalatorDeps) {}

  activeCount(): number { return this.#timers.size }

  #track(sessionId: string, cancel: Cancel): void {
    const list = this.#timers.get(sessionId)
    if (list) list.push(cancel)
    else this.#timers.set(sessionId, [cancel])
  }

  /** Start the ladder for a session that has just begun waiting. */
  begin(s: SessionState, tier: Tier): void {
    this.cancel(s.sessionId)
    this.#timers.set(s.sessionId, [])

    const d = this.d
    const { cfg, clock } = d

    // t=0 — local alert.
    d.onLocal(s, tier, 0)

    // Local repeats.
    for (let i = 1; i <= cfg.escalation.localRepeat; i++) {
      const at = cfg.escalation.localRepeatIntervalMs * i
      this.#track(s.sessionId, clock.schedule(at, () => d.onLocal(s, tier, i)))
    }

    // Phone escalation. The delay is resolved now (it decides *when* to look),
    // but the idle reading that picks active-vs-idle is taken at schedule time
    // and re-checked at fire time so a human who walks away mid-wait still gets
    // the faster path on the repeat.
    const schedulePhone = () => {
      const delay = escalateDelayFor(cfg, tier, d.idleMs())
      if (delay === null) return
      this.#track(s.sessionId, clock.schedule(delay, () => {
        d.onPhone(s, tier, 0)
        for (let i = 1; i <= cfg.escalation.phoneRepeat; i++) {
          const at = cfg.escalation.phoneRepeatIntervalMs * i
          this.#track(s.sessionId, clock.schedule(at, () => d.onPhone(s, tier, i)))
        }
      }))
    }
    schedulePhone()
  }

  cancel(sessionId: string): void {
    const list = this.#timers.get(sessionId)
    if (!list) return
    for (const c of list) c()
    this.#timers.delete(sessionId)
  }

  cancelAll(): void {
    for (const id of [...this.#timers.keys()]) this.cancel(id)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/escalation.test.ts`
Expected: PASS, 14 tests

The "reads idle state at push time" test will fail if `escalateDelayFor` is called eagerly outside the closure. If it fails, confirm `d.idleMs()` is invoked inside `schedulePhone()` and not hoisted.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/escalation.ts packages/engine/test/escalation.test.ts
git commit -m "feat(engine): escalation ladder with adaptive phone delay and full cancellation"
```

---

## Task 10: Channel interface, ntfy adapter, and registry

**Files:**
- Create: `packages/channels/package.json`, `packages/channels/tsconfig.json`
- Create: `packages/channels/src/types.ts`
- Create: `packages/channels/src/ntfy.ts`
- Create: `packages/channels/src/registry.ts`
- Test: `packages/channels/test/ntfy.test.ts`
- Test: `packages/channels/test/registry.test.ts`

**Interfaces:**
- Consumes: `Alert`, `Tier` from `@nudge/shared/types`; `channelsDir()` from `@nudge/shared/paths`.
- Produces:
  - `interface Channel { id: string; configSchema: object; send(alert: Alert, cfg: Record<string, unknown>): Promise<void>; verify?(cfg: Record<string, unknown>): Promise<void> }`
  - `const ntfyChannel: Channel`
  - `builtinChannels(): Channel[]`
  - `loadChannels(dir?: string): Promise<Map<string, Channel>>`

`Alert.detail` is populated by the caller only when `detailLevel: 'full'`; a channel never decides that itself. This keeps the privacy rule in one place.

- [ ] **Step 1: Create the package**

`packages/channels/package.json`:

```json
{
  "name": "@nudge/channels",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/registry.js",
  "exports": {
    ".": "./dist/registry.js",
    "./types": "./dist/types.js",
    "./ntfy": "./dist/ntfy.js"
  },
  "engines": { "node": ">=22.5.0" },
  "dependencies": { "@nudge/shared": "0.1.0" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/channels/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 2: Write the failing tests**

`packages/channels/test/ntfy.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ntfyChannel } from '../src/ntfy.js'
import type { Alert } from '@nudge/shared/types'

const alert: Alert = {
  sessionId: 's1', project: 'Sales-Dashboard',
  tier: 'blocked', waitingSince: 1_700_000_000_000,
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('ntfy send', () => {
  it('posts to serverUrl/topic', async () => {
    await ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 'my-topic' })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://ntfy.sh/my-topic')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
  })

  it('strips a trailing slash from serverUrl', async () => {
    await ntfyChannel.send(alert, { serverUrl: 'http://192.168.1.10:8080/', topic: 't' })
    expect(fetchMock.mock.calls[0][0]).toBe('http://192.168.1.10:8080/t')
  })

  it('sends project and tier only when detail is absent', async () => {
    await ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 't' })
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers.Title).toBe('Sales-Dashboard needs you')
    expect(init.body).toBe('Waiting on you: permission or question')
    expect(JSON.stringify(init)).not.toContain('/a/')
  })

  it('includes detail when the caller supplies it', async () => {
    await ntfyChannel.send({ ...alert, detail: 'Allow Bash(ls)?' }, { serverUrl: 'https://ntfy.sh', topic: 't' })
    expect(fetchMock.mock.calls[0][1].body).toBe('Allow Bash(ls)?')
  })

  it('maps tiers to distinct priorities and bodies', async () => {
    await ntfyChannel.send({ ...alert, tier: 'idle-long' }, { serverUrl: 'https://ntfy.sh', topic: 't' })
    expect(fetchMock.mock.calls[0][1].headers.Priority).toBe('default')
    await ntfyChannel.send({ ...alert, tier: 'blocked' }, { serverUrl: 'https://ntfy.sh', topic: 't' })
    expect(fetchMock.mock.calls[1][1].headers.Priority).toBe('high')
  })

  it('sends an auth header when a token is configured', async () => {
    await ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 't', token: 'tk_abc' })
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tk_abc')
  })

  it('throws on a non-2xx response so dispatch can retry', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))
    await expect(ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh', topic: 't' }))
      .rejects.toThrow(/503/)
  })

  it('rejects config with no topic', async () => {
    await expect(ntfyChannel.send(alert, { serverUrl: 'https://ntfy.sh' }))
      .rejects.toThrow(/topic/)
  })
})

describe('ntfy verify', () => {
  it('posts a test message', async () => {
    await ntfyChannel.verify!({ serverUrl: 'https://ntfy.sh', topic: 't' })
    expect(fetchMock.mock.calls[0][1].headers.Title).toBe('Nudge test')
  })
})
```

`packages/channels/test/registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinChannels, loadChannels } from '../src/registry.js'

describe('registry', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-ch-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('includes ntfy as a built-in', async () => {
    expect(builtinChannels().map(c => c.id)).toContain('ntfy')
  })

  it('returns built-ins when the user channel directory is absent', async () => {
    const m = await loadChannels(join(dir, 'does-not-exist'))
    expect(m.has('ntfy')).toBe(true)
  })

  it('loads a user channel from disk', async () => {
    writeFileSync(join(dir, 'mine.js'),
      `export default { id: 'mine', configSchema: {}, async send() {} }\n`)
    const m = await loadChannels(dir)
    expect(m.has('mine')).toBe(true)
  })

  it('lets a user channel override a built-in of the same id', async () => {
    writeFileSync(join(dir, 'ntfy.js'),
      `export default { id: 'ntfy', configSchema: {}, async send() {} }\n`)
    const m = await loadChannels(dir)
    expect(m.get('ntfy')!.configSchema).toEqual({})
  })

  it('skips a malformed channel file without throwing', async () => {
    writeFileSync(join(dir, 'broken.js'), `this is not javascript {{{\n`)
    writeFileSync(join(dir, 'good.js'),
      `export default { id: 'good', configSchema: {}, async send() {} }\n`)
    const m = await loadChannels(dir)
    expect(m.has('good')).toBe(true)
    expect(m.has('broken')).toBe(false)
  })

  it('skips a file whose default export is not a Channel', async () => {
    writeFileSync(join(dir, 'nope.js'), `export default { notAChannel: true }\n`)
    const m = await loadChannels(dir)
    expect(m.has('nope')).toBe(false)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/channels`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement the interface, adapter, and registry**

`packages/channels/src/types.ts`:

```ts
import type { Alert } from '@nudge/shared/types'

export interface Channel {
  id: string
  configSchema: object
  send(alert: Alert, cfg: Record<string, unknown>): Promise<void>
  verify?(cfg: Record<string, unknown>): Promise<void>
}

export function isChannel(v: unknown): v is Channel {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Partial<Channel>
  return typeof c.id === 'string' && c.id.length > 0 && typeof c.send === 'function'
}
```

`packages/channels/src/ntfy.ts`:

```ts
import type { Alert, Tier } from '@nudge/shared/types'
import type { Channel } from './types.js'

const TIER_BODY: Record<Tier, string> = {
  'blocked': 'Waiting on you: permission or question',
  'idle-long': 'Long task finished — your move',
  'idle-short': 'Turn finished — your move',
  'stalled': 'Session may have stalled',
}

const TIER_PRIORITY: Record<Tier, string> = {
  'blocked': 'high',
  'idle-long': 'default',
  'idle-short': 'low',
  'stalled': 'default',
}

function endpoint(cfg: Record<string, unknown>): string {
  const server = typeof cfg.serverUrl === 'string' && cfg.serverUrl.length > 0
    ? cfg.serverUrl : 'https://ntfy.sh'
  const topic = cfg.topic
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('ntfy: "topic" is required')
  }
  return `${server.replace(/\/+$/, '')}/${topic}`
}

function headers(cfg: Record<string, unknown>, title: string, priority: string): Record<string, string> {
  const h: Record<string, string> = { Title: title, Priority: priority, Tags: 'robot' }
  if (typeof cfg.token === 'string' && cfg.token.length > 0) {
    h.Authorization = `Bearer ${cfg.token}`
  }
  return h
}

async function post(url: string, h: Record<string, string>, body: string): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: h, body })
  if (!res.ok) throw new Error(`ntfy: HTTP ${res.status}`)
}

export const ntfyChannel: Channel = {
  id: 'ntfy',
  configSchema: {
    type: 'object',
    required: ['topic'],
    properties: {
      serverUrl: { type: 'string', description: 'Defaults to https://ntfy.sh. Point at your own server for LAN-only delivery.' },
      topic: { type: 'string' },
      token: { type: 'string', description: 'Optional bearer token for a protected server.' },
    },
  },

  async send(alert: Alert, cfg: Record<string, unknown>): Promise<void> {
    // `detail` is populated by the engine only when detailLevel is 'full'.
    // The channel never makes that decision itself.
    const body = alert.detail ?? TIER_BODY[alert.tier]
    await post(endpoint(cfg), headers(cfg, `${alert.project} needs you`, TIER_PRIORITY[alert.tier]), body)
  },

  async verify(cfg: Record<string, unknown>): Promise<void> {
    await post(endpoint(cfg), headers(cfg, 'Nudge test', 'default'),
      'If you can read this, your phone channel works.')
  },
}
```

`packages/channels/src/registry.ts`:

```ts
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { channelsDir } from '@nudge/shared/paths'
import { ntfyChannel } from './ntfy.js'
import { isChannel, type Channel } from './types.js'

export type { Channel } from './types.js'
export { ntfyChannel } from './ntfy.js'

export function builtinChannels(): Channel[] {
  return [ntfyChannel]
}

/**
 * Built-ins plus anything in ~/.nudge/channels/*.js. A user file may override a
 * built-in by reusing its id. A broken file is skipped, never fatal — a bad
 * third-party adapter must not stop local alerting.
 */
export async function loadChannels(dir = channelsDir()): Promise<Map<string, Channel>> {
  const map = new Map<string, Channel>()
  for (const c of builtinChannels()) map.set(c.id, c)

  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.js') || f.endsWith('.mjs'))
  } catch {
    return map
  }

  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href)
      const candidate = mod.default
      if (isChannel(candidate)) map.set(candidate.id, candidate)
    } catch {
      // Skip silently; `nudge status` surfaces the count of loaded channels.
    }
  }
  return map
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/channels`
Expected: PASS, 15 tests

- [ ] **Step 6: Commit**

```bash
git add packages/channels
git commit -m "feat(channels): Channel interface, ntfy adapter, and user-extensible registry"
```

---

## Task 11: Channel dispatch with retry

**Files:**
- Create: `packages/engine/src/dispatch.ts`
- Test: `packages/engine/test/dispatch.test.ts`

**Interfaces:**
- Consumes: `Channel` from `@nudge/channels`; `Alert`, `SessionState`, `Tier`; `NudgeConfig`; `Clock`.
- Produces:
  - `interface DispatchResult { ok: boolean; attempts: number; error?: string }`
  - `buildAlert(cfg: NudgeConfig, s: SessionState, tier: Tier): Alert` — the single place the privacy rule is enforced.
  - `class Dispatcher` with `constructor(cfg: NudgeConfig, clock: Clock, resolve: () => Promise<Channel | null>)` and `dispatch(s: SessionState, tier: Tier): Promise<DispatchResult>`.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/dispatch.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { Dispatcher, buildAlert } from '../src/dispatch.js'
import { FakeClock } from '../src/clock.js'
import { mergeConfig, DEFAULT_CONFIG } from '@nudge/shared/config'
import type { Channel } from '@nudge/channels'
import type { SessionState } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'Sales-Dashboard', cwd: '/a/Sales-Dashboard',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 5_000, turnStartedAt: null, lastEventAt: 5_000,
  message: 'Allow Bash(rsync root@10.0.0.1)?', snoozedUntil: null, pushFailed: false, ...over,
})

const withChannel = (cfg: NudgeConfig, send: Channel['send']) => {
  const clock = new FakeClock(0)
  const ch: Channel = { id: 'test', configSchema: {}, send }
  const d = new Dispatcher(cfg, clock, async () => ch)
  return { d, clock }
}

describe('buildAlert enforces the privacy rule', () => {
  it('omits detail under the minimal default', () => {
    const a = buildAlert(DEFAULT_CONFIG, session(), 'blocked')
    expect(a.project).toBe('Sales-Dashboard')
    expect(a.tier).toBe('blocked')
    expect(a.waitingSince).toBe(5_000)
    expect(a.detail).toBeUndefined()
    expect(JSON.stringify(a)).not.toContain('rsync')
    expect(JSON.stringify(a)).not.toContain('/a/Sales-Dashboard')
  })

  it('includes the message only when full detail is opted into', () => {
    const cfg = mergeConfig({ detailLevel: 'full' })
    const a = buildAlert(cfg, session(), 'blocked')
    expect(a.detail).toBe('Allow Bash(rsync root@10.0.0.1)?')
  })

  it('omits detail under full when there is no message', () => {
    const cfg = mergeConfig({ detailLevel: 'full' })
    expect(buildAlert(cfg, session({ message: null }), 'idle-long').detail).toBeUndefined()
  })
})

describe('dispatch', () => {
  const cfg = mergeConfig({ channel: { id: 'test', options: {} } })

  it('sends once on success', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const { d } = withChannel(cfg as NudgeConfig, send)
    const r = await d.dispatch(session(), 'blocked')
    expect(r).toEqual({ ok: true, attempts: 1 })
    expect(send).toHaveBeenCalledOnce()
  })

  it('passes the configured channel options through', async () => {
    const send = vi.fn().mockResolvedValue(undefined)
    const c = mergeConfig({ channel: { id: 'test', options: { topic: 'abc' } } })
    const { d } = withChannel(c as NudgeConfig, send)
    await d.dispatch(session(), 'blocked')
    expect(send.mock.calls[0][1]).toEqual({ topic: 'abc' })
  })

  it('retries three times with backoff then reports failure', async () => {
    const send = vi.fn().mockRejectedValue(new Error('network down'))
    const { d, clock } = withChannel(cfg as NudgeConfig, send)
    const p = d.dispatch(session(), 'blocked')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    clock.advance(1_000)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    clock.advance(2_000)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3))
    clock.advance(4_000)
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(3)
    expect(r.error).toMatch(/network down/)
  })

  it('succeeds on a retry after a transient failure', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined)
    const { d, clock } = withChannel(cfg as NudgeConfig, send)
    const p = d.dispatch(session(), 'blocked')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    clock.advance(1_000)
    const r = await p
    expect(r).toEqual({ ok: true, attempts: 2 })
  })

  it('reports failure without sending when no channel is configured', async () => {
    const clock = new FakeClock(0)
    const d = new Dispatcher(DEFAULT_CONFIG, clock, async () => null)
    const r = await d.dispatch(session(), 'blocked')
    expect(r.ok).toBe(false)
    expect(r.attempts).toBe(0)
    expect(r.error).toMatch(/no channel configured/i)
  })

  it('never throws — a dead channel must not crash the engine', async () => {
    const send = vi.fn().mockImplementation(() => { throw new Error('boom') })
    const { d, clock } = withChannel(cfg as NudgeConfig, send)
    const p = d.dispatch(session(), 'blocked')
    clock.advance(10_000)
    await expect(p).resolves.toMatchObject({ ok: false })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/dispatch.test.ts`
Expected: FAIL — `Cannot find module '../src/dispatch.js'`

- [ ] **Step 3: Implement the dispatcher**

`packages/engine/src/dispatch.ts`:

```ts
import type { Alert, SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'
import type { Channel } from '@nudge/channels'
import type { Clock } from './clock.js'

export interface DispatchResult {
  ok: boolean
  attempts: number
  error?: string
}

const MAX_ATTEMPTS = 3
const BASE_BACKOFF_MS = 1_000

/**
 * The single place the privacy rule lives: project and tier always, message
 * only when the user has explicitly opted into full detail. No channel and no
 * caller gets to make this decision independently.
 */
export function buildAlert(cfg: NudgeConfig, s: SessionState, tier: Tier): Alert {
  const alert: Alert = {
    sessionId: s.sessionId,
    project: s.project,
    tier,
    waitingSince: s.waitingSince ?? s.lastEventAt,
  }
  if (cfg.detailLevel === 'full' && s.message) alert.detail = s.message
  return alert
}

export class Dispatcher {
  constructor(
    private cfg: NudgeConfig,
    private clock: Clock,
    private resolveChannel: () => Promise<Channel | null>,
  ) {}

  async dispatch(s: SessionState, tier: Tier): Promise<DispatchResult> {
    const channel = await this.resolveChannel()
    if (!channel || !this.cfg.channel) {
      return { ok: false, attempts: 0, error: 'no channel configured' }
    }

    const alert = buildAlert(this.cfg, s, tier)
    const options = this.cfg.channel.options
    let lastError = ''

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await channel.send(alert, options)
        return { ok: true, attempts: attempt }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        if (attempt === MAX_ATTEMPTS) break
        await new Promise<void>(resolve => {
          this.clock.schedule(BASE_BACKOFF_MS * 2 ** (attempt - 1), resolve)
        })
      }
    }

    return { ok: false, attempts: MAX_ATTEMPTS, error: lastError }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/dispatch.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/dispatch.ts packages/engine/test/dispatch.test.ts
git commit -m "feat(engine): channel dispatch with backoff retry and minimal-payload enforcement"
```

---

## Task 12: Desktop notification and sound

**Files:**
- Create: `packages/engine/src/desktop.ts`
- Create: `packages/engine/assets/blocked.aiff`, `done.aiff`, `stalled.aiff` (short generated tones)
- Test: `packages/engine/test/desktop.test.ts`

**Interfaces:**
- Consumes: `SessionState`, `Tier`; `NudgeConfig`.
- Produces:
  - `interface Spawner { run(cmd: string, args: string[]): void }`
  - `notifyCommand(platform: NodeJS.Platform, title: string, body: string): { cmd: string; args: string[] } | null`
  - `soundCommand(platform: NodeJS.Platform, file: string): { cmd: string; args: string[] } | null`
  - `class DesktopNotifier` with `constructor(cfg: NudgeConfig, spawner?: Spawner, platform?: NodeJS.Platform)` and `alert(s: SessionState, tier: Tier): void`.

Phase 1 uses platform CLIs and therefore has **no click-to-jump** — that arrives with the Electron shell in Phase 2. Say so in the README rather than implying otherwise.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/desktop.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { DesktopNotifier, notifyCommand, soundCommand } from '../src/desktop.js'
import { mergeConfig, DEFAULT_CONFIG } from '@nudge/shared/config'
import type { SessionState } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'Sales-Dashboard', cwd: '/a/Sales-Dashboard',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 0, turnStartedAt: null, lastEventAt: 0,
  message: 'Allow Bash(ls)?', snoozedUntil: null, pushFailed: false, ...over,
})

describe('notifyCommand', () => {
  it('uses osascript on darwin', () => {
    const c = notifyCommand('darwin', 'T', 'B')!
    expect(c.cmd).toBe('osascript')
    expect(c.args.join(' ')).toContain('display notification')
  })

  it('uses notify-send on linux', () => {
    const c = notifyCommand('linux', 'T', 'B')!
    expect(c.cmd).toBe('notify-send')
    expect(c.args).toContain('T')
  })

  it('uses powershell on win32', () => {
    const c = notifyCommand('win32', 'T', 'B')!
    expect(c.cmd).toBe('powershell')
  })

  it('returns null for an unsupported platform', () => {
    expect(notifyCommand('aix' as NodeJS.Platform, 'T', 'B')).toBeNull()
  })

  it('escapes double quotes so a message cannot break out of the script', () => {
    const c = notifyCommand('darwin', 'T', 'Allow "rm -rf"?')!
    expect(c.args.join(' ')).not.toMatch(/[^\\]"rm/)
  })
})

describe('soundCommand', () => {
  it('uses afplay on darwin', () => {
    expect(soundCommand('darwin', '/s/a.aiff')!.cmd).toBe('afplay')
  })
  it('uses paplay on linux', () => {
    expect(soundCommand('linux', '/s/a.aiff')!.cmd).toBe('paplay')
  })
  it('uses powershell on win32', () => {
    expect(soundCommand('win32', 'C:\\s\\a.wav')!.cmd).toBe('powershell')
  })
})

describe('DesktopNotifier', () => {
  const spy = () => {
    const calls: Array<{ cmd: string; args: string[] }> = []
    return { spawner: { run: (cmd: string, args: string[]) => calls.push({ cmd, args }) }, calls }
  }

  it('shows the full message on the desktop — detail never leaves the machine here', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin').alert(session(), 'blocked')
    const joined = calls.map(c => c.args.join(' ')).join(' ')
    expect(joined).toContain('Sales-Dashboard')
    expect(joined).toContain('Allow Bash(ls)?')
  })

  it('plays a sound for a tier that has one', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin').alert(session(), 'blocked')
    expect(calls.some(c => c.cmd === 'afplay')).toBe(true)
  })

  it('stays silent for idle-short', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin').alert(session({ tier: 'idle-short' }), 'idle-short')
    expect(calls.some(c => c.cmd === 'afplay')).toBe(false)
    expect(calls.some(c => c.cmd === 'osascript')).toBe(true)
  })

  it('falls back to the tier description when there is no message', () => {
    const { spawner, calls } = spy()
    new DesktopNotifier(DEFAULT_CONFIG, spawner, 'darwin')
      .alert(session({ message: null, tier: 'idle-long' }), 'idle-long')
    expect(calls.map(c => c.args.join(' ')).join(' ')).toContain('finished')
  })

  it('honours a custom sound path', () => {
    const cfg = mergeConfig({ tiers: { blocked: { sound: '/custom/ping.aiff' } } })
    const { spawner, calls } = spy()
    new DesktopNotifier(cfg as NudgeConfig, spawner, 'darwin').alert(session(), 'blocked')
    expect(calls.find(c => c.cmd === 'afplay')!.args[0]).toBe('/custom/ping.aiff')
  })

  it('does nothing on an unsupported platform rather than throwing', () => {
    const { spawner, calls } = spy()
    expect(() => new DesktopNotifier(DEFAULT_CONFIG, spawner, 'aix' as NodeJS.Platform)
      .alert(session(), 'blocked')).not.toThrow()
    expect(calls).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/desktop.test.ts`
Expected: FAIL — `Cannot find module '../src/desktop.js'`

- [ ] **Step 3: Generate the bundled sounds**

```bash
mkdir -p packages/engine/assets
# Three short, distinguishable tones. On macOS these ship as .aiff; the same
# files play fine via paplay/PowerShell after conversion in the installer.
python3 - <<'PY'
import math, struct, wave, os
def tone(path, freqs, ms=180):
    rate = 44100
    with wave.open(path, 'w') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        frames = b''
        per = int(rate * ms / 1000 / len(freqs))
        for f in freqs:
            for i in range(per):
                env = min(1.0, i / 400) * min(1.0, (per - i) / 400)
                frames += struct.pack('<h', int(12000 * env * math.sin(2 * math.pi * f * i / rate)))
        w.writeframes(frames)
os.makedirs('packages/engine/assets', exist_ok=True)
tone('packages/engine/assets/blocked.wav', [880, 1174])
tone('packages/engine/assets/done.wav',    [659, 880])
tone('packages/engine/assets/stalled.wav', [440, 330])
print('wrote 3 sounds')
PY
```

- [ ] **Step 4: Implement the notifier**

`packages/engine/src/desktop.ts`:

```ts
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

export interface Spawner { run(cmd: string, args: string[]): void }

const TIER_TEXT: Record<Tier, string> = {
  'blocked': 'Waiting on you: permission or question',
  'idle-long': 'Long task finished — your move',
  'idle-short': 'Turn finished — your move',
  'stalled': 'Session may have stalled',
}

const ASSETS = join(import.meta.dirname, '..', 'assets')

const realSpawner: Spawner = {
  run(cmd, args) {
    try {
      const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
      p.on('error', () => {})   // a missing notify-send must never crash the engine
      p.unref()
    } catch { /* ignore */ }
  },
}

function esc(s: string): string { return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') }

export function notifyCommand(
  platform: NodeJS.Platform, title: string, body: string,
): { cmd: string; args: string[] } | null {
  switch (platform) {
    case 'darwin':
      return { cmd: 'osascript', args: ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`] }
    case 'linux':
      return { cmd: 'notify-send', args: ['-a', 'Nudge', title, body] }
    case 'win32':
      return {
        cmd: 'powershell',
        args: ['-NoProfile', '-Command',
          `[reflection.assembly]::LoadWithPartialName('System.Windows.Forms')>$null;` +
          `$n=New-Object System.Windows.Forms.NotifyIcon;` +
          `$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
          `$n.ShowBalloonTip(10000,"${esc(title)}","${esc(body)}",'Info');Start-Sleep -s 6`],
      }
    default:
      return null
  }
}

export function soundCommand(
  platform: NodeJS.Platform, file: string,
): { cmd: string; args: string[] } | null {
  switch (platform) {
    case 'darwin': return { cmd: 'afplay', args: [file] }
    case 'linux':  return { cmd: 'paplay', args: [file] }
    case 'win32':  return {
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer "${file}").PlaySync()`],
    }
    default: return null
  }
}

/**
 * Phase 1 notifications are fire-and-forget platform CLIs, so there is no
 * click-to-jump. That arrives with the Electron shell in Phase 2.
 */
export class DesktopNotifier {
  constructor(
    private cfg: NudgeConfig,
    private spawner: Spawner = realSpawner,
    private platform: NodeJS.Platform = process.platform,
  ) {}

  alert(s: SessionState, tier: Tier): void {
    const title = `${s.project} needs you`
    const body = s.message ?? TIER_TEXT[tier]

    const n = notifyCommand(this.platform, title, body)
    if (n) this.spawner.run(n.cmd, n.args)

    const configured = this.cfg.tiers[tier].sound
    if (!configured) return
    const file = configured.includes('/') || configured.includes('\\')
      ? configured
      : join(ASSETS, `${configured}.wav`)
    const snd = soundCommand(this.platform, file)
    if (snd) this.spawner.run(snd.cmd, snd.args)
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/desktop.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 6: Verify a real notification and sound appear**

Run: `node -e "import('./packages/engine/dist/desktop.js').then(m=>new m.DesktopNotifier(JSON.parse(process.env.C)).alert({sessionId:'s',project:'Demo',cwd:'/x',surface:{kind:'unknown'},status:'blocked',tier:'blocked',waitingSince:0,turnStartedAt:null,lastEventAt:0,message:'Allow Bash(ls)?',snoozedUntil:null,pushFailed:false},'blocked'))" C="$(node -e "import('./packages/shared/dist/config.js').then(m=>console.log(JSON.stringify(m.DEFAULT_CONFIG)))")"`

Expected: a visible desktop notification reading "Demo needs you / Allow Bash(ls)?" and an audible tone. If nothing appears on Linux, install `libnotify-bin`; if silent, install `pulseaudio-utils`. Document both in the README.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/desktop.ts packages/engine/test/desktop.test.ts packages/engine/assets
git commit -m "feat(engine): cross-platform desktop notification and per-tier sound"
```

---

## Task 13: SQLite persistence

**Files:**
- Create: `packages/engine/src/db.ts`
- Test: `packages/engine/test/db.test.ts`

**Interfaces:**
- Consumes: `NudgeEvent`, `SessionState`, `Tier`; `dbPath()`.
- Produces:
  - `interface WaitRow { id: number; sessionId: string; project: string; tier: Tier; waitingSince: number; resolvedAt: number | null; resolvedBy: string | null }`
  - `class Db` with `constructor(path?: string)`, `recordEvent(ev: NudgeEvent): void`, `eventCount(): number`, `openWait(s: SessionState, tier: Tier): number`, `closeWait(sessionId: string, at: number, by: string): void`, `openWaits(): WaitRow[]`, `waitsSince(ts: number): WaitRow[]`, `prune(olderThan: number): number`, `close(): void`.

Uses `node:sqlite` — built into Node 22.5+, so no native compilation and no Electron rebuild step in Phase 2.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/db.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from '../src/db.js'
import type { NudgeEvent, SessionState } from '@nudge/shared/types'

let dir: string
let db: Db

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1000, turnStartedAt: null, lastEventAt: 1000,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

const ev = (over: Partial<NudgeEvent> = {}): NudgeEvent => ({
  source: 'claude-code', sessionId: 's1', hook: 'Notification',
  cwd: '/a/my-repo', project: 'my-repo', ts: 1000, message: 'Allow?', ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-db-'))
  db = new Db(join(dir, 'test.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('schema', () => {
  it('creates the file and is reopenable', () => {
    db.recordEvent(ev())
    db.close()
    const again = new Db(join(dir, 'test.db'))
    expect(again.waitsSince(0)).toEqual([])
    again.close()
  })
})

describe('waits', () => {
  it('opens a wait and lists it as unresolved', () => {
    db.openWait(session(), 'blocked')
    const open = db.openWaits()
    expect(open).toHaveLength(1)
    expect(open[0].project).toBe('my-repo')
    expect(open[0].tier).toBe('blocked')
    expect(open[0].resolvedAt).toBeNull()
  })

  it('closes a wait with a timestamp and reason', () => {
    db.openWait(session(), 'blocked')
    db.closeWait('s1', 4000, 'PostToolUse')
    expect(db.openWaits()).toHaveLength(0)
    const all = db.waitsSince(0)
    expect(all[0].resolvedAt).toBe(4000)
    expect(all[0].resolvedBy).toBe('PostToolUse')
  })

  it('closes only the newest open wait for a session', () => {
    db.openWait(session(), 'idle-short')
    db.closeWait('s1', 2000, 'UserPromptSubmit')
    db.openWait(session({ waitingSince: 3000 }), 'blocked')
    db.closeWait('s1', 5000, 'PostToolUse')
    const all = db.waitsSince(0)
    expect(all).toHaveLength(2)
    expect(all.every(w => w.resolvedAt !== null)).toBe(true)
  })

  it('ignores closing a session with no open wait', () => {
    expect(() => db.closeWait('nope', 1, 'x')).not.toThrow()
  })

  it('filters by timestamp', () => {
    db.openWait(session({ waitingSince: 1000 }), 'blocked')
    db.openWait(session({ sessionId: 's2', waitingSince: 9000 }), 'blocked')
    expect(db.waitsSince(5000)).toHaveLength(1)
  })
})

describe('events and pruning', () => {
  it('records events', () => {
    db.recordEvent(ev())
    db.recordEvent(ev({ hook: 'Stop', ts: 2000 }))
    expect(db.eventCount()).toBe(2)
  })

  it('prunes rows older than the cutoff from both tables', () => {
    db.recordEvent(ev({ ts: 1000 }))
    db.recordEvent(ev({ ts: 90_000 }))
    db.openWait(session({ waitingSince: 1000 }), 'blocked')
    db.closeWait('s1', 1500, 'x')
    db.openWait(session({ sessionId: 's2', waitingSince: 90_000 }), 'blocked')
    const removed = db.prune(50_000)
    expect(removed).toBeGreaterThan(0)
    expect(db.eventCount()).toBe(1)
    expect(db.waitsSince(0)).toHaveLength(1)
  })

  it('never prunes a still-open wait', () => {
    db.openWait(session({ waitingSince: 1000 }), 'blocked')
    db.prune(50_000)
    expect(db.openWaits()).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/db.test.ts`
Expected: FAIL — `Cannot find module '../src/db.js'`

- [ ] **Step 3: Implement the store**

`packages/engine/src/db.ts`:

```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NudgeEvent, SessionState, Tier } from '@nudge/shared/types'
import { dbPath } from '@nudge/shared/paths'

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
    this.#db = new DatabaseSync(path)
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

  close(): void { this.#db.close() }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/db.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/db.ts packages/engine/test/db.test.ts
git commit -m "feat(engine): SQLite event log and wait history via node:sqlite"
```

---

## Task 14: Wire protocol and socket server

**Files:**
- Create: `packages/shared/src/protocol.ts`
- Create: `packages/engine/src/server.ts`
- Test: `packages/shared/test/protocol.test.ts`
- Test: `packages/engine/test/server.test.ts`

**Interfaces:**
- Consumes: `NudgeEvent`, `SessionState`; `socketPath()`.
- Produces:
  - `type ClientMessage` and `type ServerMessage` (below)
  - `encode(msg: unknown): string`, `class NdjsonDecoder` with `push(chunk: string): unknown[]`
  - `interface ServerHandlers { onEvent, onList, onSnooze, onMute, onResolve, onIdle, onFrontmost }`
  - `class EngineServer` with `listen(path?: string): Promise<void>`, `broadcast(sessions: SessionState[]): void`, `close(): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/protocol.test.ts`:

```ts
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
```

`packages/engine/test/server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EngineServer } from '../src/server.js'
import { encode, NdjsonDecoder } from '@nudge/shared/protocol'
import type { NudgeEvent, SessionState } from '@nudge/shared/types'

let dir: string
let sock: string
let server: EngineServer
let received: NudgeEvent[]

const session = (): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false,
})

function client(): Promise<{ s: Socket; next: () => Promise<unknown> }> {
  return new Promise(resolve => {
    const s = connect(sock, () => {
      const d = new NdjsonDecoder()
      const queue: unknown[] = []
      let waiter: ((v: unknown) => void) | null = null
      s.setEncoding('utf8')
      s.on('data', chunk => {
        for (const m of d.push(chunk as unknown as string)) {
          if (waiter) { waiter(m); waiter = null } else queue.push(m)
        }
      })
      resolve({
        s,
        next: () => queue.length
          ? Promise.resolve(queue.shift())
          : new Promise(res => { waiter = res }),
      })
    })
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-srv-'))
  sock = join(dir, 'engine.sock')
  received = []
  server = new EngineServer({
    onEvent: ev => { received.push(ev) },
    onList: () => [session()],
    onSnooze: vi.fn(),
    onMute: vi.fn(),
    onResolve: vi.fn(),
    onIdle: vi.fn(),
    onFrontmost: vi.fn(),
  })
  await server.listen(sock)
})

afterEach(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('EngineServer', () => {
  it('accepts an event and hands it to the handler', async () => {
    const { s } = await client()
    const ev: NudgeEvent = {
      source: 'claude-code', sessionId: 's1', hook: 'Notification',
      cwd: '/a/my-repo', project: 'my-repo', ts: 1, message: 'Allow?',
    }
    s.write(encode({ t: 'event', event: ev }))
    await vi.waitFor(() => expect(received).toHaveLength(1))
    expect(received[0].sessionId).toBe('s1')
    s.end()
  })

  it('answers list with the current sessions', async () => {
    const { s, next } = await client()
    s.write(encode({ t: 'list', id: 7 }))
    const reply = await next() as { t: string; id: number; data: SessionState[] }
    expect(reply.t).toBe('ok')
    expect(reply.id).toBe(7)
    expect(reply.data[0].sessionId).toBe('s1')
    s.end()
  })

  it('answers ping', async () => {
    const { s, next } = await client()
    s.write(encode({ t: 'ping', id: 3 }))
    expect(await next()).toMatchObject({ t: 'ok', id: 3 })
    s.end()
  })

  it('returns an error for an unknown message type', async () => {
    const { s, next } = await client()
    s.write(encode({ t: 'nonsense', id: 9 }))
    expect(await next()).toMatchObject({ t: 'err', id: 9 })
    s.end()
  })

  it('broadcasts state to subscribers only', async () => {
    const a = await client()
    const b = await client()
    a.s.write(encode({ t: 'subscribe', id: 1 }))
    await a.next()
    server.broadcast([session()])
    const msg = await a.next() as { t: string; sessions: SessionState[] }
    expect(msg.t).toBe('state')
    expect(msg.sessions).toHaveLength(1)
    b.s.write(encode({ t: 'ping', id: 2 }))
    expect(await b.next()).toMatchObject({ t: 'ok', id: 2 })
    a.s.end(); b.s.end()
  })

  it('survives a client disconnecting mid-broadcast', async () => {
    const a = await client()
    a.s.write(encode({ t: 'subscribe', id: 1 }))
    await a.next()
    a.s.destroy()
    await new Promise(r => setTimeout(r, 50))
    expect(() => server.broadcast([session()])).not.toThrow()
  })

  it('survives a garbage line without dropping the connection', async () => {
    const { s, next } = await client()
    s.write('garbage\n')
    s.write(encode({ t: 'ping', id: 5 }))
    expect(await next()).toMatchObject({ t: 'ok', id: 5 })
    s.end()
  })

  it.skipIf(process.platform === 'win32')('creates the socket with 0600 permissions', () => {
    expect(statSync(sock).mode & 0o777).toBe(0o600)
  })

  it('replaces a stale socket file left by a crashed engine', async () => {
    await server.close()
    const again = new EngineServer({
      onEvent: () => {}, onList: () => [], onSnooze: vi.fn(), onMute: vi.fn(),
      onResolve: vi.fn(), onIdle: vi.fn(), onFrontmost: vi.fn(),
    })
    await expect(again.listen(sock)).resolves.toBeUndefined()
    await again.close()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/shared/test/protocol.test.ts packages/engine/test/server.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement the protocol**

`packages/shared/src/protocol.ts`:

```ts
import type { NudgeEvent, SessionState } from './types.js'

export type ClientMessage =
  | { t: 'event'; event: NudgeEvent }
  | { t: 'list'; id: number }
  | { t: 'subscribe'; id: number }
  | { t: 'snooze'; id: number; sessionId: string; ms: number }
  | { t: 'mute'; id: number; on: boolean }
  | { t: 'resolve'; id: number; sessionId: string }
  | { t: 'idle'; idleMs: number }
  | { t: 'frontmost'; sessionId: string | null }
  | { t: 'ping'; id: number }

export type ServerMessage =
  | { t: 'ok'; id: number; data?: unknown }
  | { t: 'err'; id: number; message: string }
  | { t: 'state'; sessions: SessionState[] }

export function encode(msg: unknown): string {
  return JSON.stringify(msg) + '\n'
}

/** Line-buffered NDJSON decoder. A malformed line is skipped, never fatal. */
export class NdjsonDecoder {
  #buf = ''

  push(chunk: string): unknown[] {
    this.#buf += chunk
    const out: unknown[] = []
    let nl: number
    while ((nl = this.#buf.indexOf('\n')) !== -1) {
      const line = this.#buf.slice(0, nl).trim()
      this.#buf = this.#buf.slice(nl + 1)
      if (line.length === 0) continue
      try { out.push(JSON.parse(line)) } catch { /* skip */ }
    }
    return out
  }
}
```

- [ ] **Step 4: Implement the server**

`packages/engine/src/server.ts`:

```ts
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NudgeEvent, SessionState } from '@nudge/shared/types'
import { encode, NdjsonDecoder, type ClientMessage } from '@nudge/shared/protocol'
import { socketPath } from '@nudge/shared/paths'

export interface ServerHandlers {
  onEvent(ev: NudgeEvent): void
  onList(): SessionState[]
  onSnooze(sessionId: string, ms: number): void
  onMute(on: boolean): void
  onResolve(sessionId: string): void
  onIdle(idleMs: number): void
  onFrontmost(sessionId: string | null): void
}

export class EngineServer {
  #server: Server | null = null
  #subscribers = new Set<Socket>()

  constructor(private h: ServerHandlers) {}

  async listen(path = socketPath()): Promise<void> {
    if (process.platform !== 'win32') {
      mkdirSync(dirname(path), { recursive: true })
      // A crashed engine leaves the socket file behind; unlink before binding.
      try { unlinkSync(path) } catch { /* not present */ }
    }

    const server = createServer(sock => this.#attach(sock))
    this.#server = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    if (process.platform !== 'win32') chmodSync(path, 0o600)
  }

  #attach(sock: Socket): void {
    const dec = new NdjsonDecoder()
    sock.setEncoding('utf8')
    sock.on('error', () => { this.#subscribers.delete(sock) })
    sock.on('close', () => { this.#subscribers.delete(sock) })
    sock.on('data', chunk => {
      for (const raw of dec.push(chunk as unknown as string)) {
        this.#handle(sock, raw as ClientMessage)
      }
    })
  }

  #reply(sock: Socket, msg: unknown): void {
    try { sock.write(encode(msg)) } catch { /* peer vanished */ }
  }

  #handle(sock: Socket, m: ClientMessage): void {
    switch (m?.t) {
      case 'event':    this.h.onEvent(m.event); return
      case 'idle':     this.h.onIdle(m.idleMs); return
      case 'frontmost': this.h.onFrontmost(m.sessionId); return
      case 'ping':     this.#reply(sock, { t: 'ok', id: m.id }); return
      case 'list':     this.#reply(sock, { t: 'ok', id: m.id, data: this.h.onList() }); return
      case 'subscribe':
        this.#subscribers.add(sock)
        this.#reply(sock, { t: 'ok', id: m.id })
        return
      case 'snooze':
        this.h.onSnooze(m.sessionId, m.ms)
        this.#reply(sock, { t: 'ok', id: m.id })
        return
      case 'mute':
        this.h.onMute(m.on)
        this.#reply(sock, { t: 'ok', id: m.id })
        return
      case 'resolve':
        this.h.onResolve(m.sessionId)
        this.#reply(sock, { t: 'ok', id: m.id })
        return
      default:
        this.#reply(sock, {
          t: 'err',
          id: (m as { id?: number })?.id ?? 0,
          message: `unknown message type: ${String((m as { t?: string })?.t)}`,
        })
    }
  }

  broadcast(sessions: SessionState[]): void {
    const payload = encode({ t: 'state', sessions })
    for (const sock of this.#subscribers) {
      try { sock.write(payload) } catch { this.#subscribers.delete(sock) }
    }
  }

  async close(): Promise<void> {
    for (const s of this.#subscribers) s.destroy()
    this.#subscribers.clear()
    const server = this.#server
    if (!server) return
    this.#server = null
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/shared/test/protocol.test.ts packages/engine/test/server.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/test/protocol.test.ts packages/engine/src/server.ts packages/engine/test/server.test.ts
git commit -m "feat: NDJSON wire protocol and 0600 socket server with subscriptions"
```

---

## Task 15: Engine composition root and daemon entrypoint

**Files:**
- Create: `packages/engine/src/engine.ts`
- Create: `packages/engine/src/bin.ts`
- Test: `packages/engine/test/engine.test.ts`

**Interfaces:**
- Consumes: every module built so far.
- Produces: `interface EngineDeps { cfg, clock, store, db, escalator, dispatcher, notifier, watchdog, server }`, `class Engine` with `handle(ev: NudgeEvent): void`, `start(): Promise<void>`, `stop(): Promise<void>`, `setIdle(ms)`, `setFrontmost(id)`, `snooze(id, ms)`, `mute(on)`, `resolve(id)`, `sessions(): SessionState[]`.

This is where the pieces meet and where the two rules that span modules are enforced: a cleared wait cancels its ladder, and a suppressed alert still records history.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/engine.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.js'
import { FakeClock } from '../src/clock.js'
import { SessionStore } from '../src/state.js'
import { Escalator } from '../src/escalation.js'
import { Dispatcher } from '../src/dispatch.js'
import { Watchdog } from '../src/watchdog.js'
import { Db } from '../src/db.js'
import { mergeConfig } from '@nudge/shared/config'
import type { HookName, NudgeEvent } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'

let dir: string, clock: FakeClock, db: Db, engine: Engine
let local: string[], phone: string[]

const ev = (hook: HookName, extra: Partial<NudgeEvent> = {}): NudgeEvent => ({
  source: 'claude-code', sessionId: 's1', hook,
  cwd: '/a/my-repo', project: 'my-repo', ts: clock.now(), ...extra,
})

function build(over: Record<string, unknown> = {}) {
  const cfg = mergeConfig({ channel: { id: 'test', options: {} }, ...over }) as NudgeConfig
  clock = new FakeClock(0)
  db = new Db(join(dir, 'e.db'))
  local = []; phone = []

  const store = new SessionStore(cfg, clock)
  const notifier = { alert: (s: { project: string }, tier: string) => local.push(`${s.project}:${tier}`) }
  const dispatcher = new Dispatcher(cfg, clock, async () => ({
    id: 'test', configSchema: {},
    send: async (a: { project: string; tier: string }) => { phone.push(`${a.project}:${a.tier}`) },
  }))
  let idle = 0
  const escalator = new Escalator({
    cfg, clock, idleMs: () => idle,
    onLocal: (s, t) => engine.onLocal(s, t),
    onPhone: (s, t) => { void engine.onPhone(s, t) },
  })
  const watchdog = new Watchdog(cfg, clock, store, t => engine.onWatchdogStall(t))
  const server = { broadcast: vi.fn(), listen: vi.fn(), close: vi.fn() }

  engine = new Engine({
    cfg, clock, store, db, escalator, dispatcher,
    notifier: notifier as never, watchdog, server: server as never,
  })
  return { cfg, store, server, setIdle: (v: number) => { idle = v } }
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-eng-')) })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('end-to-end within the engine', () => {
  it('alerts locally then escalates to phone when nobody responds', async () => {
    build()
    engine.handle(ev('SessionStart'))
    engine.handle(ev('UserPromptSubmit'))
    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    expect(local).toEqual(['my-repo:blocked'])
    expect(phone).toEqual([])
    clock.advance(180_001)
    await vi.waitFor(() => expect(phone).toEqual(['my-repo:blocked']))
  })

  it('cancels the phone push when the human responds in time', async () => {
    build()
    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    clock.advance(120_000)
    engine.handle(ev('PostToolUse', { tool: 'Bash', ts: clock.now() }))
    clock.advance(600_000)
    expect(phone).toEqual([])
  })

  it('does not re-alert on a duplicate notification', () => {
    build()
    engine.handle(ev('Notification', { message: 'Allow Bash?' }))
    clock.advance(60_000)
    engine.handle(ev('Notification', { message: 'Allow Bash?', ts: clock.now() }))
    expect(local).toEqual(['my-repo:blocked'])
  })

  it('records a wait row that closes when resolved', () => {
    build()
    engine.handle(ev('Notification', { message: 'Allow?' }))
    expect(db.openWaits()).toHaveLength(1)
    clock.advance(10_000)
    engine.handle(ev('PostToolUse', { tool: 'Bash', ts: clock.now() }))
    expect(db.openWaits()).toHaveLength(0)
    expect(db.waitsSince(0)[0].resolvedBy).toBe('PostToolUse')
  })

  it('records history even when the alert is suppressed', () => {
    build({ muted: true })
    engine.handle(ev('Notification', { message: 'Allow?' }))
    expect(local).toEqual([])
    expect(db.openWaits()).toHaveLength(1)
  })

  it('logs every event, including ones that start no wait', () => {
    build()
    engine.handle(ev('SessionStart'))
    engine.handle(ev('PreToolUse', { tool: 'Read' }))
    expect(db.eventCount()).toBe(2)
  })

  it('stays silent for idle-short but still shows the notification', async () => {
    build()
    engine.handle(ev('UserPromptSubmit'))
    clock.advance(10_000)
    engine.handle(ev('Stop', { ts: clock.now() }))
    expect(local).toEqual(['my-repo:idle-short'])
    clock.advance(600_000)
    expect(phone).toEqual([])
  })

  it('escalates a long turn', async () => {
    build()
    engine.handle(ev('UserPromptSubmit'))
    clock.advance(240_000)
    engine.handle(ev('Stop', { ts: clock.now() }))
    expect(local).toEqual(['my-repo:idle-long'])
    clock.advance(180_001)
    await vi.waitFor(() => expect(phone).toEqual(['my-repo:idle-long']))
  })

  it('marks pushFailed when the channel keeps failing', async () => {
    const cfg = mergeConfig({ channel: { id: 'bad', options: {} } }) as NudgeConfig
    clock = new FakeClock(0); db = new Db(join(dir, 'f.db')); local = []; phone = []
    const store = new SessionStore(cfg, clock)
    const dispatcher = new Dispatcher(cfg, clock, async () => ({
      id: 'bad', configSchema: {}, send: async () => { throw new Error('offline') },
    }))
    const escalator = new Escalator({
      cfg, clock, idleMs: () => 0,
      onLocal: (s, t) => engine.onLocal(s, t),
      onPhone: (s, t) => { void engine.onPhone(s, t) },
    })
    engine = new Engine({
      cfg, clock, store, db, escalator, dispatcher,
      notifier: { alert: () => {} } as never,
      watchdog: new Watchdog(cfg, clock, store, () => {}),
      server: { broadcast: vi.fn(), listen: vi.fn(), close: vi.fn() } as never,
    })
    engine.handle(ev('Notification', { message: 'Allow?' }))
    clock.advance(180_001)
    for (let i = 0; i < 6; i++) { clock.advance(5_000); await Promise.resolve() }
    await vi.waitFor(() => expect(store.get('s1')!.pushFailed).toBe(true))
  })

  it('broadcasts state after every handled event', () => {
    const { server } = build()
    engine.handle(ev('SessionStart'))
    expect(server.broadcast).toHaveBeenCalled()
  })

  it('drops an unrecognised payload without throwing', () => {
    build()
    expect(() => engine.handle({ ...ev('Stop'), hook: 'SubagentStop' as never })).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/engine.test.ts`
Expected: FAIL — `Cannot find module '../src/engine.js'`

- [ ] **Step 3: Implement the composition root**

`packages/engine/src/engine.ts`:

```ts
import type { NudgeEvent, SessionState, Tier } from '@nudge/shared/types'
import type { NudgeConfig } from '@nudge/shared/config'
import type { Clock } from './clock.js'
import type { SessionStore, Transition } from './state.js'
import type { Escalator } from './escalation.js'
import type { Dispatcher } from './dispatch.js'
import type { DesktopNotifier } from './desktop.js'
import type { Watchdog } from './watchdog.js'
import type { EngineServer } from './server.js'
import type { Db } from './db.js'
import { localSuppression, phoneSuppression, minutesOfDay } from './suppression.js'

export interface EngineDeps {
  cfg: NudgeConfig
  clock: Clock
  store: SessionStore
  db: Db
  escalator: Escalator
  dispatcher: Dispatcher
  notifier: DesktopNotifier
  watchdog: Watchdog
  server: EngineServer
}

export class Engine {
  #idleMs = 0
  #frontmost: string | null = null
  #stopWatchdog: (() => void) | null = null

  constructor(private d: EngineDeps) {}

  sessions(): SessionState[] { return this.d.store.list() }
  setIdle(ms: number): void { this.#idleMs = ms }
  setFrontmost(id: string | null): void { this.#frontmost = id }
  idleMs(): number { return this.#idleMs }

  async start(): Promise<void> {
    await this.d.server.listen()
    this.#stopWatchdog = this.d.watchdog.start()
    this.d.db.prune(this.d.clock.now() - this.d.cfg.retentionDays * 86_400_000)
  }

  async stop(): Promise<void> {
    this.#stopWatchdog?.()
    this.d.escalator.cancelAll()
    await this.d.server.close()
    this.d.db.close()
  }

  handle(ev: NudgeEvent): void {
    const t = this.d.store.apply(ev)
    this.d.db.recordEvent(ev)
    this.#applyTransition(t, ev.hook, ev.ts)
    this.d.server.broadcast(this.d.store.list())
  }

  onWatchdogStall(t: Transition): void {
    this.#applyTransition(t, 'watchdog', this.d.clock.now())
    this.d.server.broadcast(this.d.store.list())
  }

  snooze(id: string, ms: number): void {
    this.d.store.snooze(id, ms)
    this.d.escalator.cancel(id)
    this.d.server.broadcast(this.d.store.list())
  }

  mute(on: boolean): void {
    this.d.cfg.muted = on
    if (on) this.d.escalator.cancelAll()
    this.d.server.broadcast(this.d.store.list())
  }

  resolve(id: string): void {
    const t = this.d.store.resolve(id)
    if (t) this.#applyTransition(t, 'manual', this.d.clock.now())
    this.d.server.broadcast(this.d.store.list())
  }

  /** Local alert callback, invoked by the Escalator at t=0 and on each repeat. */
  onLocal(s: SessionState, tier: Tier): void {
    const sup = localSuppression(this.d.cfg, s, tier, this.#frontmost, this.d.clock.now())
    if (sup !== 'none') return
    this.d.notifier.alert(s, tier)
  }

  /** Phone escalation callback, invoked by the Escalator when the delay expires. */
  async onPhone(s: SessionState, tier: Tier): Promise<void> {
    const now = this.d.clock.now()
    const sup = phoneSuppression(this.d.cfg, s, tier, now, minutesOfDay(now))
    if (sup !== 'none') return
    const result = await this.d.dispatcher.dispatch(s, tier)
    const live = this.d.store.get(s.sessionId)
    if (live) {
      live.pushFailed = !result.ok
      this.d.server.broadcast(this.d.store.list())
    }
  }

  /**
   * One place enforces the two cross-module rules: a cleared wait always
   * cancels its ladder and closes its history row, and history is recorded
   * even when the alert itself is suppressed.
   */
  #applyTransition(t: Transition, reason: string, at: number): void {
    if (t.duplicate) return

    if (t.cleared) {
      this.d.escalator.cancel(t.session.sessionId)
      this.d.db.closeWait(t.session.sessionId, at, reason)
    }

    if (t.started) {
      this.d.db.openWait(t.session, t.started)
      this.d.escalator.begin(t.session, t.started)
    }
  }
}
```

- [ ] **Step 4: Implement the daemon entrypoint**

`packages/engine/src/bin.ts`:

```ts
#!/usr/bin/env node
import { loadConfig } from '@nudge/shared/config'
import { loadChannels } from '@nudge/channels'
import { SystemClock } from './clock.js'
import { SessionStore } from './state.js'
import { Escalator } from './escalation.js'
import { Dispatcher } from './dispatch.js'
import { DesktopNotifier } from './desktop.js'
import { Watchdog } from './watchdog.js'
import { EngineServer } from './server.js'
import { Db } from './db.js'
import { Engine } from './engine.js'
import { drainSpool } from './drain.js'

const cfg = loadConfig()
const clock = new SystemClock()
const store = new SessionStore(cfg, clock)
const db = new Db()
const notifier = new DesktopNotifier(cfg)

const dispatcher = new Dispatcher(cfg, clock, async () => {
  if (!cfg.channel) return null
  const channels = await loadChannels()
  return channels.get(cfg.channel.id) ?? null
})

let engine: Engine

const escalator = new Escalator({
  cfg, clock,
  idleMs: () => engine.idleMs(),
  onLocal: (s, tier) => engine.onLocal(s, tier),
  onPhone: (s, tier) => { void engine.onPhone(s, tier) },
})

const watchdog = new Watchdog(cfg, clock, store, t => engine.onWatchdogStall(t))

const server = new EngineServer({
  onEvent: ev => engine.handle(ev),
  onList: () => engine.sessions(),
  onSnooze: (id, ms) => engine.snooze(id, ms),
  onMute: on => engine.mute(on),
  onResolve: id => engine.resolve(id),
  onIdle: ms => engine.setIdle(ms),
  onFrontmost: id => engine.setFrontmost(id),
})

engine = new Engine({ cfg, clock, store, db, escalator, dispatcher, notifier, watchdog, server })

await engine.start()
await drainSpool(ev => engine.handle(ev))

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void engine.stop().then(() => process.exit(0)) })
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/engine/test/engine.test.ts`
Expected: PASS, 11 tests

`bin.ts` will not compile until Task 17 creates `drain.ts`. That is expected — run `npx vitest run packages/engine` (which does not typecheck `bin.ts`) and defer `npm run build` until Task 17.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/engine.ts packages/engine/src/bin.ts packages/engine/test/engine.test.ts
git commit -m "feat(engine): composition root wiring state, escalation, dispatch, and history"
```

---

## Task 16: The hook binary

**Files:**
- Create: `packages/hook/package.json`, `packages/hook/tsconfig.json`
- Create: `packages/hook/src/read-stdin.ts`, `src/surface.ts`, `src/spool.ts`, `src/send.ts`, `src/bin.ts`
- Test: `packages/hook/test/surface.test.ts`, `packages/hook/test/send.test.ts`, `packages/hook/test/bin.test.ts`

**Interfaces:**
- Consumes: `Surface`, `NudgeEvent`; `socketPath()`, `spoolDir()`; `encode` from `@nudge/shared/protocol`.
- Produces: `readStdin(timeoutMs: number): Promise<string>`, `detectSurface(env: NodeJS.ProcessEnv): Surface`, `spoolEvent(raw: string, dir?: string): void`, `sendEvent(payload: string, deadlineMs: number, path?: string): Promise<boolean>`.

The three global constraints are enforced here and verified by test: **500ms, always exit 0, never stdout.**

- [ ] **Step 1: Create the package**

`packages/hook/package.json`:

```json
{
  "name": "@nudge/hook",
  "version": "0.1.0",
  "type": "module",
  "bin": { "nudge-hook": "./dist/bin.js" },
  "engines": { "node": ">=22.5.0" },
  "dependencies": { "@nudge/shared": "0.1.0" },
  "scripts": { "build": "tsc --build" }
}
```

`packages/hook/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 2: Write the failing tests**

`packages/hook/test/surface.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { detectSurface } from '../src/surface.js'

describe('detectSurface', () => {
  it('identifies VSCode from TERM_PROGRAM', () => {
    const s = detectSurface({ TERM_PROGRAM: 'vscode', TERM_SESSION_ID: 'abc' })
    expect(s.kind).toBe('vscode')
    expect(s.termProgram).toBe('vscode')
    expect(s.termSessionId).toBe('abc')
  })

  it('identifies Cursor and Windsurf', () => {
    expect(detectSurface({ TERM_PROGRAM: 'cursor' }).kind).toBe('cursor')
    expect(detectSurface({ TERM_PROGRAM: 'windsurf' }).kind).toBe('windsurf')
  })

  it('identifies a macOS terminal', () => {
    expect(detectSurface({ TERM_PROGRAM: 'iTerm.app' }).kind).toBe('terminal')
    expect(detectSurface({ TERM_PROGRAM: 'Apple_Terminal' }).kind).toBe('terminal')
  })

  it('identifies Windows Terminal and records its session', () => {
    const s = detectSurface({ WT_SESSION: 'w-1' })
    expect(s.kind).toBe('terminal')
    expect(s.wtSession).toBe('w-1')
  })

  it('flags tmux', () => {
    expect(detectSurface({ TMUX: '/tmp/tmux-501/default,1,0' }).tmux).toBe(true)
  })

  it('falls back to unknown with no signals', () => {
    expect(detectSurface({}).kind).toBe('unknown')
  })

  it('is case-insensitive about TERM_PROGRAM', () => {
    expect(detectSurface({ TERM_PROGRAM: 'VSCode' }).kind).toBe('vscode')
  })
})
```

`packages/hook/test/send.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendEvent } from '../src/send.js'
import { spoolEvent } from '../src/spool.js'

let dir: string
let server: Server | null = null

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-hook-')) })
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('sendEvent', () => {
  it('delivers the payload to a listening engine', async () => {
    const sock = join(dir, 'e.sock')
    const got: string[] = []
    server = createServer(s => { s.setEncoding('utf8'); s.on('data', d => got.push(d as string)) })
    await new Promise<void>(r => server!.listen(sock, () => r()))

    const ok = await sendEvent('{"t":"event"}\n', 500, sock)
    expect(ok).toBe(true)
    await new Promise(r => setTimeout(r, 50))
    expect(got.join('')).toContain('"t":"event"')
  })

  it('returns false rather than throwing when nothing is listening', async () => {
    const ok = await sendEvent('{"t":"event"}\n', 300, join(dir, 'absent.sock'))
    expect(ok).toBe(false)
  })

  it('gives up within the deadline when the peer never accepts', async () => {
    const started = Date.now()
    await sendEvent('{}\n', 200, join(dir, 'absent.sock'))
    expect(Date.now() - started).toBeLessThan(1500)
  })
})

describe('spoolEvent', () => {
  it('writes the raw payload to a uniquely named file', () => {
    spoolEvent('{"a":1}', dir)
    spoolEvent('{"a":2}', dir)
    const files = readdirSync(dir)
    expect(files).toHaveLength(2)
    expect(readFileSync(join(dir, files[0]), 'utf8')).toMatch(/\{"a":[12]\}/)
  })

  it('does not throw when the directory cannot be created', () => {
    expect(() => spoolEvent('{}', '/proc/definitely/not/writable')).not.toThrow()
  })
})
```

`packages/hook/test/bin.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)
const BIN = join(import.meta.dirname, '..', 'dist', 'bin.js')

let home: string
let server: Server | null = null

const payload = JSON.stringify({
  hook_event_name: 'Notification',
  session_id: 's1',
  cwd: '/a/my-repo',
  message: 'Allow Bash(ls)?',
})

async function invoke(env: Record<string, string> = {}) {
  const child = execFile('node', [BIN], { env: { ...process.env, NUDGE_HOME: home, ...env } })
  child.child.stdin!.end(payload)
  return child
}

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'nudge-bin-')) })
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(home, { recursive: true, force: true })
})

describe('hook binary contract', () => {
  it('exits 0 and writes nothing to stdout when the engine is listening', async () => {
    const got: string[] = []
    server = createServer(s => { s.setEncoding('utf8'); s.on('data', d => got.push(d as string)) })
    await new Promise<void>(r => server!.listen(join(home, 'engine.sock'), () => r()))

    const { stdout } = await invoke({ NUDGE_NO_SPAWN: '1' })
    expect(stdout).toBe('')
    expect(got.join('')).toContain('"hook":"Notification"')
    expect(got.join('')).toContain('"project":"my-repo"')
  })

  it('exits 0 and spools when the engine is absent', async () => {
    const { stdout } = await invoke({ NUDGE_NO_SPAWN: '1' })
    expect(stdout).toBe('')
    expect(readdirSync(join(home, 'spool'))).toHaveLength(1)
  })

  it('exits 0 on malformed stdin and spools nothing', async () => {
    const child = execFile('node', [BIN], {
      env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1' },
    })
    child.child.stdin!.end('not json at all')
    const { stdout } = await child
    expect(stdout).toBe('')
    expect(existsSync(join(home, 'spool')) ? readdirSync(join(home, 'spool')) : []).toHaveLength(0)
  })

  it('exits 0 on empty stdin', async () => {
    const child = execFile('node', [BIN], {
      env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1' },
    })
    child.child.stdin!.end('')
    await expect(child).resolves.toMatchObject({ stdout: '' })
  })

  it('completes well inside the 500ms budget with no engine', async () => {
    const started = Date.now()
    await invoke({ NUDGE_NO_SPAWN: '1' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('ignores a hook it does not subscribe to', async () => {
    const child = execFile('node', [BIN], {
      env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1' },
    })
    child.child.stdin!.end(JSON.stringify({
      hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/a/my-repo',
    }))
    await child
    expect(existsSync(join(home, 'spool')) ? readdirSync(join(home, 'spool')) : []).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run packages/hook`
Expected: FAIL — modules not found

- [ ] **Step 4: Implement the hook**

`packages/hook/src/read-stdin.ts`:

```ts
/** Reads stdin with a hard deadline. Returns whatever arrived if time runs out. */
export function readStdin(timeoutMs: number): Promise<string> {
  return new Promise(resolve => {
    let data = ''
    let done = false
    const finish = () => { if (!done) { done = true; resolve(data) } }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', c => { data += c })
    process.stdin.on('end', () => { clearTimeout(timer); finish() })
    process.stdin.on('error', () => { clearTimeout(timer); finish() })
  })
}
```

> **AMENDED 2026-08-10 during execution.** The original `detectSurface` keyed only off
> terminal environment variables (`TERM_PROGRAM`, `WT_SESSION`, `TMUX`). The **Claude Code
> desktop app sets none of those**, so it would fingerprint as `unknown` and Phase 2's
> jump-back would degrade to copying the path to the clipboard — even though the design doc
> claims desktop-app focusing is "solid". Since the fingerprint is captured once per session
> and is what Phase 2 acts on, fixing it later would mean changing the hook *and* re-capturing
> every already-running session. The additions below close that gap.
>
> **Additional requirements for this task:**
>
> 1. Extend `Surface` in `packages/shared/src/types.ts` with an optional host-app field.
>    Additive and optional, so no existing code or test changes:
>    ```ts
>    export interface Surface {
>      kind: SurfaceKind
>      // ... existing optional fields unchanged ...
>      /** Host application identified by walking the parent-process chain (SessionStart only). */
>      app?: { name: string; path?: string; pid?: number }
>    }
>    ```
>    Add `'desktop'` to `SurfaceKind` if it is not already present.
>
> 2. Add `detectHostApp(): Surface['app'] | undefined` to `surface.ts`. It walks the
>    parent-process chain from `process.ppid` upward, at most **5 hops**, looking for a
>    recognisable host application, and returns the first match.
>    - macOS/Linux: `execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeout: 150, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })`
>    - Windows: `execFileSync('powershell', ['-NoProfile','-Command', `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").ParentProcessId,(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").Name`], { timeout: 300, encoding: 'utf8' })`
>
>    Match on the executable name containing `Claude` (case-insensitive) for the desktop app,
>    and on `Code`/`Cursor`/`Windsurf` as a fallback when the env vars are absent.
>
> 3. **This must never violate the hook's contract.** Three rules, all testable:
>    - `detectHostApp` is called **only** when the hook is handling `SessionStart`. Every
>      other hook event skips it entirely — it must not add latency to a `PreToolUse` that
>      fires on every tool call.
>    - The whole function is wrapped in try/catch and returns `undefined` on any failure,
>      timeout, or missing `ps`. A fingerprint is a nice-to-have; the event is not.
>    - Each `execFileSync` carries an explicit `timeout`, and the total walk is bounded by
>      the hop limit. The hook's 500ms budget and `exit 0` guarantee still hold.
>
> 4. **Precedence:** an environment-variable match wins over the process walk. If
>    `TERM_PROGRAM=vscode`, the kind stays `vscode` even if the parent chain also mentions
>    an app — the env var is the more specific signal. The process walk only sets `kind` when
>    the env vars produced `unknown`, and it always populates `app` when it finds something.
>
> 5. **Tests to add** (alongside the brief's existing seven): `detectHostApp` returns
>    `undefined` rather than throwing when the probe command is missing or times out; the hop
>    limit is respected; an env-var match takes precedence over a process-walk match; and a
>    non-`SessionStart` event never invokes the walk (assert via an injected probe spy that it
>    was not called). Inject the process-probe function so no test spawns a real `ps`.

`packages/hook/src/surface.ts`:

```ts
import type { Surface, SurfaceKind } from '@nudge/shared/types'

const EDITORS: Record<string, SurfaceKind> = {
  vscode: 'vscode',
  cursor: 'cursor',
  windsurf: 'windsurf',
}

export function detectSurface(env: NodeJS.ProcessEnv): Surface {
  const termProgram = env.TERM_PROGRAM
  const lower = termProgram?.toLowerCase() ?? ''

  let kind: SurfaceKind = 'unknown'
  if (EDITORS[lower]) kind = EDITORS[lower]
  else if (lower.length > 0) kind = 'terminal'
  else if (env.WT_SESSION) kind = 'terminal'

  const s: Surface = { kind }
  if (termProgram) s.termProgram = termProgram
  if (env.TERM_SESSION_ID) s.termSessionId = env.TERM_SESSION_ID
  if (env.WT_SESSION) s.wtSession = env.WT_SESSION
  if (env.TMUX) s.tmux = true
  if (process.ppid) s.ppid = process.ppid
  try {
    const tty = process.stderr.isTTY ? String(process.stderr.fd) : undefined
    if (tty) s.tty = tty
  } catch { /* ignore */ }
  return s
}
```

`packages/hook/src/spool.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spoolDir } from '@nudge/shared/paths'

/** Last resort when the engine is unreachable. Must never throw. */
export function spoolEvent(raw: string, dir = spoolDir()): void {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), raw, 'utf8')
  } catch { /* the hook must never fail the session */ }
}
```

`packages/hook/src/send.ts`:

```ts
import { connect } from 'node:net'
import { socketPath } from '@nudge/shared/paths'

/** Writes a payload to the engine socket. Resolves false instead of throwing. */
export function sendEvent(payload: string, deadlineMs: number, path = socketPath()): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* ignore */ }
      resolve(ok)
    }

    const timer = setTimeout(() => finish(false), deadlineMs)
    timer.unref?.()

    const sock = connect(path)
    sock.on('error', () => finish(false))
    sock.on('connect', () => { sock.write(payload, () => finish(true)) })
  })
}
```

`packages/hook/src/bin.ts`:

```ts
#!/usr/bin/env node
/**
 * Invoked by Claude Code on every subscribed hook.
 *
 * Three inviolable rules, each covered by a test in test/bin.test.ts:
 *   1. finish within 500ms
 *   2. always exit 0
 *   3. never write to stdout
 * A notifier that can stall or break the agent is worse than no notifier.
 */
import { basename } from 'node:path'
import { spawn } from 'node:child_process'
import { encode } from '@nudge/shared/protocol'
import type { HookName, NudgeEvent } from '@nudge/shared/types'
import { readStdin } from './read-stdin.js'
import { detectSurface } from './surface.js'
import { sendEvent } from './send.js'
import { spoolEvent } from './spool.js'

const BUDGET_MS = 500
const SUBSCRIBED: readonly HookName[] = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
]

// Backstop: exit 0 no matter what, even if something below hangs unexpectedly.
const guard = setTimeout(() => process.exit(0), BUDGET_MS + 200)
guard.unref?.()

function buildEvent(raw: string): NudgeEvent | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null

  const p = parsed as Record<string, unknown>
  const hook = p.hook_event_name
  const sessionId = p.session_id
  const cwd = p.cwd
  if (typeof hook !== 'string' || !SUBSCRIBED.includes(hook as HookName)) return null
  if (typeof sessionId !== 'string' || typeof cwd !== 'string') return null

  const ev: NudgeEvent = {
    source: 'claude-code',
    sessionId,
    hook: hook as HookName,
    cwd,
    project: basename(cwd.replace(/[\/\\]+$/, '')) || cwd,
    ts: Date.now(),
  }
  if (typeof p.message === 'string' && p.message.length > 0) ev.message = p.message
  if (typeof p.tool_name === 'string' && p.tool_name.length > 0) ev.tool = p.tool_name
  if (ev.hook === 'SessionStart') ev.surface = detectSurface(process.env)
  return ev
}

function trySpawnEngine(): void {
  if (process.env.NUDGE_NO_SPAWN === '1') return
  try {
    const child = spawn(process.execPath, [new URL('../../engine/dist/bin.js', import.meta.url).pathname], {
      detached: true, stdio: 'ignore',
    })
    child.on('error', () => {})
    child.unref()
  } catch { /* ignore */ }
}

const raw = await readStdin(BUDGET_MS / 2)
const ev = buildEvent(raw)

if (ev) {
  const payload = encode({ t: 'event', event: ev })
  const ok = await sendEvent(payload, BUDGET_MS / 2)
  if (!ok) {
    spoolEvent(payload)
    trySpawnEngine()
  }
}

process.exit(0)
```

- [ ] **Step 5: Build and run the tests**

Run: `npx tsc --build && npx vitest run packages/hook`
Expected: PASS, 16 tests

- [ ] **Step 6: Verify the stdout rule directly**

Run: `echo '{"hook_event_name":"Stop","session_id":"s","cwd":"/tmp/x"}' | NUDGE_HOME=/tmp/nudge-check NUDGE_NO_SPAWN=1 node packages/hook/dist/bin.js; echo "exit=$?"`
Expected: exactly `exit=0` and no other output whatsoever.

- [ ] **Step 7: Commit**

```bash
git add packages/hook
git commit -m "feat(hook): 500ms, exit-0, stdout-silent hook binary with spool fallback"
```

---

## Task 17: Spool drain

**Files:**
- Create: `packages/engine/src/drain.ts`
- Test: `packages/engine/test/drain.test.ts`

**Interfaces:**
- Consumes: `NudgeEvent`; `spoolDir()`.
- Produces: `drainSpool(handle: (ev: NudgeEvent) => void, dir?: string): Promise<number>` — returns the count of events replayed.

Closes the reliability loop: an alert that arrived while the engine was down is not lost.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/drain.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainSpool } from '../src/drain.js'
import type { NudgeEvent } from '@nudge/shared/types'

let dir: string

const spooled = (sessionId: string, ts: number) => JSON.stringify({
  t: 'event',
  event: {
    source: 'claude-code', sessionId, hook: 'Notification',
    cwd: '/a/my-repo', project: 'my-repo', ts, message: 'Allow?',
  },
})

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nudge-drain-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('drainSpool', () => {
  it('returns zero when the directory does not exist', async () => {
    expect(await drainSpool(() => {}, join(dir, 'nope'))).toBe(0)
  })

  it('replays spooled events and deletes the files', async () => {
    writeFileSync(join(dir, '1-a.json'), spooled('s1', 1000))
    writeFileSync(join(dir, '2-b.json'), spooled('s2', 2000))
    const seen: NudgeEvent[] = []
    expect(await drainSpool(ev => seen.push(ev), dir)).toBe(2)
    expect(seen).toHaveLength(2)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('replays in timestamp order so the state machine sees a coherent sequence', async () => {
    writeFileSync(join(dir, '9-late.json'), spooled('late', 9000))
    writeFileSync(join(dir, '1-early.json'), spooled('early', 1000))
    const seen: NudgeEvent[] = []
    await drainSpool(ev => seen.push(ev), dir)
    expect(seen.map(e => e.sessionId)).toEqual(['early', 'late'])
  })

  it('discards a malformed spool file instead of stalling the drain', async () => {
    writeFileSync(join(dir, '1-bad.json'), 'not json')
    writeFileSync(join(dir, '2-good.json'), spooled('s1', 2000))
    expect(await drainSpool(() => {}, dir)).toBe(1)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('does not let a throwing handler abort the drain', async () => {
    writeFileSync(join(dir, '1-a.json'), spooled('s1', 1000))
    writeFileSync(join(dir, '2-b.json'), spooled('s2', 2000))
    let calls = 0
    const count = await drainSpool(() => { calls++; if (calls === 1) throw new Error('boom') }, dir)
    expect(calls).toBe(2)
    expect(count).toBe(1)
    expect(readdirSync(dir)).toHaveLength(0)
  })

  it('ignores non-json files', async () => {
    mkdirSync(join(dir, 'subdir'))
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    writeFileSync(join(dir, '1-a.json'), spooled('s1', 1000))
    expect(await drainSpool(() => {}, dir)).toBe(1)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/drain.test.ts`
Expected: FAIL — `Cannot find module '../src/drain.js'`

- [ ] **Step 3: Implement the drain**

`packages/engine/src/drain.ts`:

```ts
import { readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { NudgeEvent } from '@nudge/shared/types'
import { spoolDir } from '@nudge/shared/paths'

/**
 * Replays events the hook spooled while the engine was down, oldest first so
 * the state machine sees a coherent sequence. Every file is removed whether or
 * not it parsed — a poison file must not wedge the drain on every boot.
 */
export async function drainSpool(
  handle: (ev: NudgeEvent) => void,
  dir = spoolDir(),
): Promise<number> {
  let files: string[]
  try {
    files = (await readdir(dir)).filter(f => f.endsWith('.json'))
  } catch {
    return 0
  }

  const parsed: NudgeEvent[] = []
  for (const f of files) {
    const path = join(dir, f)
    try {
      const raw = await readFile(path, 'utf8')
      const msg = JSON.parse(raw) as { t?: string; event?: NudgeEvent }
      if (msg?.t === 'event' && msg.event) parsed.push(msg.event)
    } catch { /* discard */ }
    try { await unlink(path) } catch { /* already gone */ }
  }

  parsed.sort((a, b) => a.ts - b.ts)

  let replayed = 0
  for (const ev of parsed) {
    try { handle(ev); replayed++ } catch { /* one bad event must not stop the rest */ }
  }
  return replayed
}
```

- [ ] **Step 4: Run the test and a full build**

Run: `npx vitest run packages/engine/test/drain.test.ts && npx tsc --build`
Expected: PASS, 6 tests, and a clean build now that `bin.ts` can resolve `drain.js`

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/drain.ts packages/engine/test/drain.test.ts
git commit -m "feat(engine): drain spooled events on boot so nothing is lost when the daemon was down"
```

---

## Task 18: CLI setup — safe `settings.json` surgery

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`
- Create: `packages/cli/src/settings.ts`, `packages/cli/src/setup.ts`
- Test: `packages/cli/test/settings.test.ts`

**Interfaces:**
- Consumes: `claudeSettingsPath()`.
- Produces:
  - `const NUDGE_MARK = 'nudge-hook'`
  - `hookEntriesFor(command: string): Record<string, unknown[]>`
  - `mergeHooks(existing: unknown, command: string): { merged: Record<string, unknown>; added: number }`
  - `removeHooks(existing: unknown): { merged: Record<string, unknown>; removed: number }`
  - `backupSettings(path?: string): string | null`
  - `applySetup(opts: { command: string; dryRun: boolean; path?: string }): { added: number; backup: string | null; diff: string }`

Every Nudge hook command contains the literal `nudge-hook`, which is how `removeHooks` finds exactly its own entries and nothing else.

- [ ] **Step 1: Create the package**

`packages/cli/package.json`:

```json
{
  "name": "nudge-cli",
  "version": "0.1.0",
  "type": "module",
  "bin": { "nudge": "./dist/bin.js" },
  "engines": { "node": ">=22.5.0" },
  "dependencies": {
    "@nudge/shared": "0.1.0",
    "@nudge/channels": "0.1.0",
    "@nudge/engine": "0.1.0"
  },
  "scripts": { "build": "tsc --build" }
}
```

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*.ts"],
  "references": [
    { "path": "../shared" }, { "path": "../channels" }, { "path": "../engine" }
  ]
}
```

- [ ] **Step 2: Write the failing test**

`packages/cli/test/settings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeHooks, removeHooks, backupSettings, applySetup, NUDGE_MARK } from '../src/settings.ts'

const CMD = 'node /opt/nudge/packages/hook/dist/bin.js'
let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-set-'))
  file = join(dir, 'settings.json')
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('mergeHooks preserves everything it did not add', () => {
  it('keeps a large permissions block byte-for-byte', () => {
    const existing = {
      permissions: { allow: ['Bash(ls:*)', 'Read(/x/**)'], additionalDirectories: ['/tmp'] },
      model: 'opus[1m]',
      enabledPlugins: { 'superpowers@official': true },
    }
    const { merged } = mergeHooks(existing, CMD)
    expect(merged.permissions).toEqual(existing.permissions)
    expect(merged.model).toBe('opus[1m]')
    expect(merged.enabledPlugins).toEqual(existing.enabledPlugins)
  })

  it('adds all seven hooks to a file that has none', () => {
    const { merged, added } = mergeHooks({ model: 'opus' }, CMD)
    expect(added).toBe(7)
    const hooks = merged.hooks as Record<string, unknown[]>
    expect(Object.keys(hooks).sort()).toEqual([
      'Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd',
      'SessionStart', 'Stop', 'UserPromptSubmit',
    ])
  })

  it('appends to an existing hooks array without disturbing the user entry', () => {
    const existing = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-script.sh' }] }] },
    }
    const { merged } = mergeHooks(existing, CMD)
    const stop = (merged.hooks as Record<string, unknown[]>).Stop
    expect(stop).toHaveLength(2)
    expect(JSON.stringify(stop[0])).toContain('my-own-script.sh')
    expect(JSON.stringify(stop[1])).toContain(NUDGE_MARK)
  })

  it('is idempotent — running setup twice adds nothing the second time', () => {
    const once = mergeHooks({}, CMD)
    const twice = mergeHooks(once.merged, CMD)
    expect(twice.added).toBe(0)
    expect(JSON.stringify(twice.merged)).toBe(JSON.stringify(once.merged))
  })

  it('updates the command in place when the install path changed', () => {
    const once = mergeHooks({}, CMD)
    const moved = mergeHooks(once.merged, '/new/path/nudge-hook/dist/bin.js')
    const stop = (moved.merged.hooks as Record<string, unknown[]>).Stop
    expect(stop).toHaveLength(1)
    expect(JSON.stringify(stop)).toContain('/new/path')
  })

  it('rejects a settings file that is not an object', () => {
    expect(() => mergeHooks([1, 2, 3], CMD)).toThrow(/object/)
  })
})

describe('removeHooks takes back exactly what it added', () => {
  it('restores the file to its pre-setup state', () => {
    const original = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-script.sh' }] }] },
    }
    const { merged } = mergeHooks(original, CMD)
    const { merged: back, removed } = removeHooks(merged)
    expect(removed).toBe(7)
    expect(JSON.stringify(back)).toBe(JSON.stringify(original))
  })

  it('drops the hooks key entirely when nothing else lived there', () => {
    const { merged } = mergeHooks({ model: 'opus' }, CMD)
    const { merged: back } = removeHooks(merged)
    expect(back).toEqual({ model: 'opus' })
  })

  it('removes nothing from a file Nudge never touched', () => {
    const other = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other.sh' }] }] } }
    const { merged, removed } = removeHooks(other)
    expect(removed).toBe(0)
    expect(merged).toEqual(other)
  })
})

describe('backupSettings', () => {
  it('writes a timestamped copy alongside the original', () => {
    writeFileSync(file, '{"model":"opus"}')
    const backup = backupSettings(file)
    expect(backup).toBeTruthy()
    expect(readFileSync(backup!, 'utf8')).toBe('{"model":"opus"}')
    expect(readdirSync(dir).some(f => f.startsWith('settings.json.nudge-backup'))).toBe(true)
  })

  it('returns null when there is nothing to back up', () => {
    expect(backupSettings(join(dir, 'absent.json'))).toBeNull()
  })
})

describe('applySetup', () => {
  it('dry-run reports the diff and writes nothing', () => {
    writeFileSync(file, '{"model":"opus"}')
    const r = applySetup({ command: CMD, dryRun: true, path: file })
    expect(r.added).toBe(7)
    expect(r.backup).toBeNull()
    expect(r.diff).toContain('Notification')
    expect(readFileSync(file, 'utf8')).toBe('{"model":"opus"}')
  })

  it('a real run backs up, writes valid JSON, and preserves other keys', () => {
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2))
    const r = applySetup({ command: CMD, dryRun: false, path: file })
    expect(r.backup).toBeTruthy()
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.permissions.allow).toEqual(['Bash(ls:*)'])
    expect(Object.keys(after.hooks)).toHaveLength(7)
  })

  it('refuses to write when the existing file is not valid JSON', () => {
    writeFileSync(file, '{ this is broken')
    expect(() => applySetup({ command: CMD, dryRun: false, path: file })).toThrow(/parse/i)
    expect(readFileSync(file, 'utf8')).toBe('{ this is broken')
  })

  it('creates the file when absent', () => {
    const r = applySetup({ command: CMD, dryRun: false, path: file })
    expect(r.added).toBe(7)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).hooks)).toHaveLength(7)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/cli/test/settings.test.ts`
Expected: FAIL — `Cannot find module '../src/settings.ts'`

- [ ] **Step 4: Implement settings surgery**

`packages/cli/src/settings.ts`:

```ts
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { claudeSettingsPath } from '@nudge/shared/paths'

/** Every hook Nudge installs carries this marker so uninstall is exact. */
export const NUDGE_MARK = 'nudge-hook'

const HOOKS_WITH_MATCHER = ['PreToolUse', 'PostToolUse'] as const
const ALL_HOOKS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Notification', 'Stop', 'SessionEnd',
] as const

interface HookEntry { matcher?: string; hooks: Array<{ type: string; command: string }> }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNudgeEntry(e: unknown): boolean {
  return isObj(e) && Array.isArray(e.hooks)
    && e.hooks.some(h => isObj(h) && typeof h.command === 'string' && h.command.includes(NUDGE_MARK))
}

function entryFor(hook: string, command: string): HookEntry {
  const e: HookEntry = { hooks: [{ type: 'command', command }] }
  if ((HOOKS_WITH_MATCHER as readonly string[]).includes(hook)) e.matcher = '*'
  return e
}

export function hookEntriesFor(command: string): Record<string, HookEntry[]> {
  const out: Record<string, HookEntry[]> = {}
  for (const h of ALL_HOOKS) out[h] = [entryFor(h, command)]
  return out
}

/**
 * Append-only merge. Never rewrites a key it did not create; an existing Nudge
 * entry is updated in place so a moved install path does not leave a stale one.
 */
export function mergeHooks(existing: unknown, command: string): {
  merged: Record<string, unknown>; added: number
} {
  if (!isObj(existing)) throw new Error('settings.json: top level must be an object')

  const merged = structuredClone(existing) as Record<string, unknown>
  const hooks: Record<string, unknown[]> = isObj(merged.hooks)
    ? structuredClone(merged.hooks) as Record<string, unknown[]>
    : {}

  let added = 0
  for (const name of ALL_HOOKS) {
    const list = Array.isArray(hooks[name]) ? [...hooks[name]] : []
    const idx = list.findIndex(isNudgeEntry)
    const wanted = entryFor(name, command)
    if (idx === -1) { list.push(wanted); added++ }
    else if (JSON.stringify(list[idx]) !== JSON.stringify(wanted)) { list[idx] = wanted }
    hooks[name] = list
  }

  merged.hooks = hooks
  return { merged, added }
}

export function removeHooks(existing: unknown): {
  merged: Record<string, unknown>; removed: number
} {
  if (!isObj(existing)) throw new Error('settings.json: top level must be an object')
  const merged = structuredClone(existing) as Record<string, unknown>
  if (!isObj(merged.hooks)) return { merged, removed: 0 }

  const hooks = structuredClone(merged.hooks) as Record<string, unknown[]>
  let removed = 0

  for (const [name, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue
    const kept = list.filter(e => { const drop = isNudgeEntry(e); if (drop) removed++; return !drop })
    if (kept.length === 0) delete hooks[name]
    else hooks[name] = kept
  }

  if (Object.keys(hooks).length === 0) delete merged.hooks
  else merged.hooks = hooks

  return { merged, removed }
}

export function backupSettings(path = claudeSettingsPath()): string | null {
  if (!existsSync(path)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${path}.nudge-backup-${stamp}`
  copyFileSync(path, dest)
  return dest
}

function readSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  try {
    const parsed = JSON.parse(raw)
    if (!isObj(parsed)) throw new Error('not an object')
    return parsed
  } catch (err) {
    throw new Error(
      `Refusing to touch ${path}: could not parse it as JSON (${(err as Error).message}). ` +
      `Fix or move the file, then re-run setup.`,
    )
  }
}

export function applySetup(opts: { command: string; dryRun: boolean; path?: string }): {
  added: number; backup: string | null; diff: string
} {
  const path = opts.path ?? claudeSettingsPath()
  const existing = readSettings(path)
  const { merged, added } = mergeHooks(existing, opts.command)

  const diff = [
    `--- ${path} (current)`,
    `+++ ${path} (after setup)`,
    ...ALL_HOOKS.map(h => `+ hooks.${h}[]  ->  ${opts.command}`),
  ].join('\n')

  if (opts.dryRun) return { added, backup: null, diff }

  const backup = backupSettings(path)
  const serialized = JSON.stringify(merged, null, 2) + '\n'
  JSON.parse(serialized)   // validate before it ever reaches disk
  writeFileSync(path, serialized, 'utf8')
  return { added, backup, diff }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/cli/test/settings.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 6: Verify against a copy of a real settings file**

Run:

```bash
cp ~/.claude/settings.json /tmp/real-settings.json
node -e "import('./packages/cli/dist/settings.js').then(m=>{const r=m.applySetup({command:'node /opt/nudge-hook/bin.js',dryRun:false,path:'/tmp/real-settings.json'});console.log('added',r.added,'backup',r.backup)})"
node -e "const a=require('/tmp/real-settings.json');console.log('permissions intact:',a.permissions.allow.length,'rules; hooks:',Object.keys(a.hooks).length)"
```

Expected: the original permission count is unchanged and 7 hooks are present. **This is the check that protects a real user's file** — do not skip it.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/package.json packages/cli/tsconfig.json packages/cli/src/settings.ts packages/cli/test/settings.test.ts
git commit -m "feat(cli): append-only settings.json merge with backup, dry-run, and exact uninstall"
```

---

## Task 19: CLI commands and service installation

**Files:**
- Create: `packages/cli/src/service.ts`, `packages/cli/src/commands.ts`, `packages/cli/src/bin.ts`
- Test: `packages/cli/test/service.test.ts`, `packages/cli/test/commands.test.ts`

**Interfaces:**
- Consumes: `settings.ts`; `loadChannels` from `@nudge/channels`; `socketPath()`, `configPath()`.
- Produces:
  - `serviceUnit(platform: NodeJS.Platform, execPath: string, scriptPath: string): { path: string; contents: string; installCmd: string[] } | null`
  - `request(msg: unknown, path?: string): Promise<unknown>` — one-shot socket request/response
  - `cmdStatus()`, `cmdList()`, `cmdTest(channelId?)`, `cmdSnooze(id, ms)`, `cmdMute(on)`, `cmdUninstall()`

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/service.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { serviceUnit } from '../src/service.js'

describe('serviceUnit', () => {
  it('produces a launchd plist on darwin with KeepAlive', () => {
    const u = serviceUnit('darwin', '/usr/bin/node', '/opt/nudge/engine/bin.js')!
    expect(u.path).toMatch(/Library\/LaunchAgents\/com\.nudge\.engine\.plist$/)
    expect(u.contents).toContain('<key>KeepAlive</key>')
    expect(u.contents).toContain('/opt/nudge/engine/bin.js')
    expect(u.installCmd[0]).toBe('launchctl')
  })

  it('produces a systemd user unit on linux with Restart=always', () => {
    const u = serviceUnit('linux', '/usr/bin/node', '/opt/nudge/engine/bin.js')!
    expect(u.path).toMatch(/systemd\/user\/nudge-engine\.service$/)
    expect(u.contents).toContain('Restart=always')
    expect(u.installCmd[0]).toBe('systemctl')
  })

  it('produces a schtasks invocation on win32 that runs at logon', () => {
    const u = serviceUnit('win32', 'C:\\node.exe', 'C:\\nudge\\bin.js')!
    expect(u.installCmd[0]).toBe('schtasks')
    expect(u.installCmd.join(' ')).toContain('ONLOGON')
  })

  it('returns null on an unsupported platform', () => {
    expect(serviceUnit('aix' as NodeJS.Platform, '/n', '/s')).toBeNull()
  })
})
```

`packages/cli/test/commands.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from '../src/commands.js'
import { encode, NdjsonDecoder } from '@nudge/shared/protocol'

let dir: string
let sock: string
let server: Server | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nudge-cmd-'))
  sock = join(dir, 'e.sock')
})
afterEach(async () => {
  if (server) await new Promise<void>(r => server!.close(() => r()))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('request', () => {
  it('returns the engine reply', async () => {
    server = createServer(s => {
      const d = new NdjsonDecoder()
      s.setEncoding('utf8')
      s.on('data', chunk => {
        for (const m of d.push(chunk as string)) {
          s.write(encode({ t: 'ok', id: (m as { id: number }).id, data: ['x'] }))
        }
      })
    })
    await new Promise<void>(r => server!.listen(sock, () => r()))
    const reply = await request({ t: 'list', id: 1 }, sock)
    expect(reply).toMatchObject({ t: 'ok', data: ['x'] })
  })

  it('rejects with a clear message when the engine is not running', async () => {
    await expect(request({ t: 'ping', id: 1 }, join(dir, 'absent.sock')))
      .rejects.toThrow(/not running/i)
  })

  it('rejects rather than hanging when the engine never replies', async () => {
    server = createServer(() => { /* accept and stay silent */ })
    await new Promise<void>(r => server!.listen(sock, () => r()))
    await expect(request({ t: 'ping', id: 1 }, sock, 300)).rejects.toThrow(/timed out/i)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/cli/test/service.test.ts packages/cli/test/commands.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement service units**

`packages/cli/src/service.ts`:

```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ServiceUnit {
  path: string
  contents: string
  installCmd: string[]
}

export function serviceUnit(
  platform: NodeJS.Platform, execPath: string, scriptPath: string,
): ServiceUnit | null {
  switch (platform) {
    case 'darwin': {
      const path = join(homedir(), 'Library', 'LaunchAgents', 'com.nudge.engine.plist')
      return {
        path,
        contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.nudge.engine</string>
  <key>ProgramArguments</key>
  <array><string>${execPath}</string><string>${scriptPath}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`,
        installCmd: ['launchctl', 'bootstrap', `gui/${process.getuid?.() ?? 501}`, path],
      }
    }

    case 'linux': {
      const path = join(homedir(), '.config', 'systemd', 'user', 'nudge-engine.service')
      return {
        path,
        contents: `[Unit]
Description=Nudge engine

[Service]
ExecStart=${execPath} ${scriptPath}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`,
        installCmd: ['systemctl', '--user', 'enable', '--now', 'nudge-engine.service'],
      }
    }

    case 'win32':
      return {
        path: '',
        contents: '',
        installCmd: [
          'schtasks', '/Create', '/F', '/TN', 'NudgeEngine',
          '/SC', 'ONLOGON', '/TR', `"${execPath}" "${scriptPath}"`,
        ],
      }

    default:
      return null
  }
}
```

- [ ] **Step 4: Implement the commands and entrypoint**

`packages/cli/src/commands.ts`:

```ts
import { connect } from 'node:net'
import { socketPath, configPath } from '@nudge/shared/paths'
import { loadConfig } from '@nudge/shared/config'
import { loadChannels } from '@nudge/channels'
import type { SessionState } from '@nudge/shared/types'
import { encode, NdjsonDecoder } from '@nudge/shared/protocol'

/** One-shot request/response against the engine socket. */
export function request(msg: unknown, path = socketPath(), timeoutMs = 3_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const dec = new NdjsonDecoder()
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { sock.destroy() } catch { /* ignore */ }
      fn()
    }

    const timer = setTimeout(
      () => done(() => reject(new Error('Engine timed out — it accepted the connection but did not reply.'))),
      timeoutMs,
    )

    const sock = connect(path)
    sock.setEncoding('utf8')
    sock.on('error', () => done(() =>
      reject(new Error('Nudge engine is not running. Start it with `nudge start`.'))))
    sock.on('connect', () => sock.write(encode(msg)))
    sock.on('data', chunk => {
      for (const m of dec.push(chunk as string)) done(() => resolve(m))
    })
  })
}

const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export async function cmdList(): Promise<void> {
  const reply = await request({ t: 'list', id: 1 }) as { data: SessionState[] }
  const waiting = reply.data.filter(s => s.waitingSince !== null)
  if (waiting.length === 0) { console.log('Nothing waiting on you.'); return }
  for (const s of waiting) {
    console.log(`${s.tier?.padEnd(11)} ${s.project.padEnd(24)} ${ago(s.waitingSince!).padStart(8)}  ${s.message ?? ''}`)
  }
}

export async function cmdStatus(): Promise<void> {
  const cfg = loadConfig()
  const channels = await loadChannels()
  console.log(`config    ${configPath()}`)
  console.log(`socket    ${socketPath()}`)
  console.log(`detail    ${cfg.detailLevel}`)
  console.log(`muted     ${cfg.muted}`)
  console.log(`channel   ${cfg.channel?.id ?? '(none configured)'}`)
  console.log(`adapters  ${[...channels.keys()].join(', ')}`)
  try {
    await request({ t: 'ping', id: 1 })
    console.log('engine    running')
  } catch (err) {
    console.log(`engine    ${(err as Error).message}`)
  }
}

export async function cmdTest(channelId?: string): Promise<void> {
  const cfg = loadConfig()
  const id = channelId ?? cfg.channel?.id
  if (!id) throw new Error('No channel configured. Set channel.id in ' + configPath())
  const channel = (await loadChannels()).get(id)
  if (!channel) throw new Error(`Unknown channel "${id}".`)
  if (!channel.verify) throw new Error(`Channel "${id}" does not support testing.`)
  await channel.verify(cfg.channel?.options ?? {})
  console.log(`Sent a test alert via ${id}. Check your phone.`)
}

export async function cmdSnooze(sessionId: string, ms: number): Promise<void> {
  await request({ t: 'snooze', id: 1, sessionId, ms })
  console.log(`Snoozed ${sessionId} for ${Math.round(ms / 60_000)}m.`)
}

export async function cmdMute(on: boolean): Promise<void> {
  await request({ t: 'mute', id: 1, on })
  console.log(on ? 'Muted.' : 'Unmuted.')
}
```

`packages/cli/src/bin.ts`:

```ts
#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeSettingsPath } from '@nudge/shared/paths'
import { applySetup, backupSettings, removeHooks } from './settings.js'
import { serviceUnit } from './service.js'
import { cmdList, cmdMute, cmdSnooze, cmdStatus, cmdTest } from './commands.js'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const HOOK_BIN = join(here, '..', '..', 'hook', 'dist', 'bin.js')
const ENGINE_BIN = join(here, '..', '..', 'engine', 'dist', 'bin.js')

const [cmd, ...rest] = process.argv.slice(2)

function installService(): void {
  const unit = serviceUnit(process.platform, process.execPath, ENGINE_BIN)
  if (!unit) { console.log('No service manager for this platform; start the engine manually.'); return }
  if (unit.path) {
    mkdirSync(dirname(unit.path), { recursive: true })
    writeFileSync(unit.path, unit.contents, 'utf8')
  }
  const p = spawn(unit.installCmd[0], unit.installCmd.slice(1), { stdio: 'inherit' })
  p.on('error', e => console.log(`Could not register the service: ${e.message}`))
}

try {
  switch (cmd) {
    case 'setup': {
      const dryRun = rest.includes('--dry-run')
      const r = applySetup({ command: `node ${HOOK_BIN}`, dryRun })
      if (dryRun) { console.log(r.diff); console.log(`\n${r.added} hook(s) would be added.`); break }
      console.log(`Added ${r.added} hook(s) to ${claudeSettingsPath()}`)
      if (r.backup) console.log(`Backup: ${r.backup}`)
      installService()
      console.log('Run `nudge test` once you have set channel.id in your config.')
      break
    }
    case 'uninstall': {
      const path = claudeSettingsPath()
      const backup = backupSettings(path)
      const existing = JSON.parse(readFileSync(path, 'utf8'))
      const { merged, removed } = removeHooks(existing)
      writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf8')
      console.log(`Removed ${removed} Nudge hook(s). Backup: ${backup}`)
      break
    }
    case 'start': {
      const p = spawn(process.execPath, [ENGINE_BIN], { detached: true, stdio: 'ignore' })
      p.unref()
      console.log('Engine started.')
      break
    }
    case 'status': await cmdStatus(); break
    case 'list':   await cmdList(); break
    case 'test':   await cmdTest(rest[0]); break
    case 'snooze': await cmdSnooze(rest[0], Number(rest[1] ?? 10) * 60_000); break
    case 'mute':   await cmdMute(rest[0] !== 'off'); break
    default:
      console.log(`nudge <command>

  setup [--dry-run]   install hooks into Claude Code and register the engine
  uninstall           remove exactly the hooks Nudge added
  start               start the engine in the background
  status              config, channel, and engine health
  list                what is waiting on you right now
  test [channel]      send a test alert to your phone
  snooze <id> [min]   snooze a session (default 10 minutes)
  mute [off]          mute or unmute all alerts
`)
  }
} catch (err) {
  console.error(`nudge: ${(err as Error).message}`)
  process.exit(1)
}
```

- [ ] **Step 5: Run the tests and build**

Run: `npx tsc --build && npx vitest run packages/cli`
Expected: PASS, 22 tests

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/service.ts packages/cli/src/commands.ts packages/cli/src/bin.ts packages/cli/test
git commit -m "feat(cli): status/list/test/snooze/mute commands and per-platform service registration"
```

---

## Task 20: Integration test, real end-to-end verification, CI, and README

**Files:**
- Create: `packages/engine/test/integration.test.ts`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: proof that a real hook process reaching a real engine over a real socket produces a real channel call.

- [ ] **Step 1: Write the integration test**

`packages/engine/test/integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine } from '../src/engine.js'
import { FakeClock } from '../src/clock.js'
import { SessionStore } from '../src/state.js'
import { Escalator } from '../src/escalation.js'
import { Dispatcher } from '../src/dispatch.js'
import { Watchdog } from '../src/watchdog.js'
import { EngineServer } from '../src/server.js'
import { Db } from '../src/db.js'
import { mergeConfig } from '@nudge/shared/config'
import type { NudgeConfig } from '@nudge/shared/config'

const HOOK = join(import.meta.dirname, '..', '..', 'hook', 'dist', 'bin.js')

let home: string, clock: FakeClock, db: Db, engine: Engine
let phone: Array<{ project: string; tier: string; detail?: string }>
let local: string[]

async function fireHook(payload: Record<string, unknown>): Promise<void> {
  const child = execFile('node', [HOOK], {
    env: { ...process.env, NUDGE_HOME: home, NUDGE_NO_SPAWN: '1' },
  })
  child.child.stdin!.end(JSON.stringify(payload))
  await child
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'nudge-int-'))
  mkdirSync(join(home, 'spool'), { recursive: true })
  clock = new FakeClock(0)
  db = new Db(join(home, 'n.db'))
  phone = []; local = []

  const cfg = mergeConfig({ channel: { id: 'spy', options: {} } }) as NudgeConfig
  const store = new SessionStore(cfg, clock)
  const dispatcher = new Dispatcher(cfg, clock, async () => ({
    id: 'spy', configSchema: {},
    send: async (a) => { phone.push({ project: a.project, tier: a.tier, detail: a.detail }) },
  }))
  const escalator = new Escalator({
    cfg, clock, idleMs: () => 0,
    onLocal: (s, t) => engine.onLocal(s, t),
    onPhone: (s, t) => { void engine.onPhone(s, t) },
  })
  const server = new EngineServer({
    onEvent: ev => engine.handle(ev),
    onList: () => engine.sessions(),
    onSnooze: (id, ms) => engine.snooze(id, ms),
    onMute: on => engine.mute(on),
    onResolve: id => engine.resolve(id),
    onIdle: ms => engine.setIdle(ms),
    onFrontmost: id => engine.setFrontmost(id),
  })
  engine = new Engine({
    cfg, clock, store, db, escalator, dispatcher,
    notifier: { alert: (s, t) => local.push(`${s.project}:${t}`) } as never,
    watchdog: new Watchdog(cfg, clock, store, t => engine.onWatchdogStall(t)),
    server,
  })
  await server.listen(join(home, 'engine.sock'))
})

afterEach(async () => {
  await engine.stop()
  rmSync(home, { recursive: true, force: true })
})

describe('hook process -> socket -> engine -> channel', () => {
  it('runs the realistic sequence and escalates once nobody responds', async () => {
    await fireHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/tmp/fixture-project' })
    await fireHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/tmp/fixture-project' })
    await fireHook({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/tmp/fixture-project', tool_name: 'Bash' })
    await fireHook({
      hook_event_name: 'Notification', session_id: 's1',
      cwd: '/tmp/fixture-project', message: 'Allow Bash(rsync secret-host)?',
    })

    await vi.waitFor(() => expect(local).toContain('fixture-project:blocked'))

    clock.advance(180_001)
    await vi.waitFor(() => expect(phone).toHaveLength(1))

    // The privacy rule, verified across the real wire: nothing sensitive left.
    expect(phone[0].project).toBe('fixture-project')
    expect(phone[0].tier).toBe('blocked')
    expect(phone[0].detail).toBeUndefined()
    expect(JSON.stringify(phone)).not.toContain('rsync')
    expect(JSON.stringify(phone)).not.toContain('secret-host')
  })

  it('cancels the escalation when the tool actually runs', async () => {
    await fireHook({ hook_event_name: 'Notification', session_id: 's2', cwd: '/tmp/fixture-project', message: 'Allow?' })
    await vi.waitFor(() => expect(local).toHaveLength(1))
    clock.advance(60_000)
    await fireHook({ hook_event_name: 'PostToolUse', session_id: 's2', cwd: '/tmp/fixture-project', tool_name: 'Bash' })
    await vi.waitFor(() => expect(engine.sessions()[0].status).toBe('running'))
    clock.advance(600_000)
    expect(phone).toHaveLength(0)
  })

  it('records the wait in history with a resolution reason', async () => {
    await fireHook({ hook_event_name: 'Notification', session_id: 's3', cwd: '/tmp/fixture-project', message: 'Allow?' })
    await vi.waitFor(() => expect(db.openWaits()).toHaveLength(1))
    await fireHook({ hook_event_name: 'UserPromptSubmit', session_id: 's3', cwd: '/tmp/fixture-project' })
    await vi.waitFor(() => expect(db.openWaits()).toHaveLength(0))
    expect(db.waitsSince(0).at(-1)!.resolvedBy).toBe('UserPromptSubmit')
  })
})

describe('spool recovery', () => {
  it('replays an event spooled while the engine was down', async () => {
    const { drainSpool } = await import('../src/drain.js')
    writeFileSync(join(home, 'spool', '1-x.json'), JSON.stringify({
      t: 'event',
      event: {
        source: 'claude-code', sessionId: 's9', hook: 'Notification',
        cwd: '/tmp/fixture-project', project: 'fixture-project', ts: 500, message: 'Allow?',
      },
    }))
    const n = await drainSpool(ev => engine.handle(ev), join(home, 'spool'))
    expect(n).toBe(1)
    expect(local).toContain('fixture-project:blocked')
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `npx tsc --build && npx vitest run packages/engine/test/integration.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 3: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — every test across all packages. Record the total count; it should be roughly 165.

- [ ] **Step 4: Verify against a genuinely real Claude Code session**

This is the check that the unit and integration tests cannot substitute for.

```bash
export NUDGE_HOME=/tmp/nudge-e2e
mkdir -p "$NUDGE_HOME"
cat > "$NUDGE_HOME/config.json" <<'JSON'
{ "channel": { "id": "ntfy", "options": { "topic": "nudge-e2e-CHANGEME" } },
  "escalation": { "activeDelayMs": 15000 } }
JSON

node packages/cli/dist/bin.js setup --dry-run     # inspect the diff first
node packages/cli/dist/bin.js setup
node packages/cli/dist/bin.js start
node packages/cli/dist/bin.js status              # expect: engine running
```

Then, in a scratch directory, start a real Claude Code session and ask it to run a command that is **not** on your allowlist so a permission prompt appears. Walk away for twenty seconds.

Expected, in order: a desktop notification and sound within a second of the prompt appearing; `node packages/cli/dist/bin.js list` showing the session as `blocked`; a phone notification about fifteen seconds later reading "<project> needs you" **with no command text in it**; and everything going quiet the instant you approve the permission.

Then confirm the uninstall is exact:

```bash
node packages/cli/dist/bin.js uninstall
diff <(jq -S . ~/.claude/settings.json) <(jq -S . ~/.claude/settings.json.nudge-backup-*) | head
```

Expected: the only differences are the hooks Nudge added and removed. **If your own pre-existing settings differ in any way, stop and fix `removeHooks` before shipping.**

- [ ] **Step 5: Write CI**

`.github/workflows/ci.yml`:

```yaml
name: ci
on: [push, pull_request]

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22.x'
      - run: npm ci
      - run: npx tsc --build
      - run: npx vitest run
```

- [ ] **Step 6: Write the README**

`README.md` must state plainly, because each is a real limit users will hit:

- **Phase 1 has no click-to-jump.** Notifications are fire-and-forget platform CLIs; clicking one does nothing. Jumping back to the editor arrives with the tray app in Phase 2.
- **The watchdog is heuristic.** A session running a long command is indistinguishable from a crashed one, which is why the default is 15 minutes and it does not page your phone unless you enable it.
- **Phone payloads are minimal by design.** Project name and event type only. `detailLevel: "full"` sends the actual question and is documented as something to enable only against a push server you control.
- **iOS cannot receive LAN-only push.** Self-hosted ntfy works fully locally on Android; on iOS, Apple requires APNs, so alerts relay through ntfy.sh regardless of your server setting.
- **Linux needs `libnotify-bin` for notifications and `pulseaudio-utils` for sound.**
- Install, `nudge setup`, config reference, and how to write a channel adapter in ~30 lines.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/test/integration.test.ts .github/workflows/ci.yml README.md
git commit -m "test: end-to-end integration over the real socket; add CI matrix and README"
```

---

## Task 21: Sleep/wake and clock-drift resilience

**Files:**
- Create: `packages/engine/src/drift.ts`
- Modify: `packages/engine/src/engine.ts` — add `onResume()`, call `driftDetector.start()` from `start()`
- Modify: `packages/engine/src/bin.ts` — construct and pass the detector
- Test: `packages/engine/test/drift.test.ts`

**Interfaces:**
- Consumes: `Clock`, `Cancel` from `./clock.js`; `SessionStore`, `Escalator`, `Watchdog`.
- Produces:
  - `class DriftDetector` with `constructor(deps: { clock: Clock; wall: () => number; mono: () => number; onDrift: (skewMs: number) => void; intervalMs?: number; thresholdMs?: number })`, `start(): Cancel`, `check(): void`.
  - `Engine.onResume(): void` — re-arms ladders for sessions still waiting and forces a watchdog tick.

Spec §13 requires the engine to survive sleep/wake and clock changes. `setTimeout` does not fire while a machine sleeps, so a laptop closed for two hours wakes with a stale ladder and `waitingSince` arithmetic derived from a wall clock that may have jumped. The detector compares wall-clock movement against a monotonic source; a divergence past the threshold means the machine slept or the clock was set, and the engine re-evaluates.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/drift.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/engine/test/drift.test.ts`
Expected: FAIL — `Cannot find module '../src/drift.js'`

- [ ] **Step 3: Implement the detector**

`packages/engine/src/drift.ts`:

```ts
import type { Clock, Cancel } from './clock.js'

export interface DriftDeps {
  clock: Clock
  /** Wall clock, normally Date.now. */
  wall: () => number
  /** Monotonic source, normally performance.now — unaffected by clock sets. */
  mono: () => number
  onDrift: (skewMs: number) => void
  intervalMs?: number
  thresholdMs?: number
}

/**
 * setTimeout does not fire while a machine sleeps, and a wall clock can be set
 * backwards at any time. Comparing wall movement against a monotonic source
 * detects both: a divergence past the threshold means the engine's view of
 * elapsed time is no longer trustworthy and waiting sessions must be re-armed.
 */
export class DriftDetector {
  #lastWall: number | null = null
  #lastMono: number | null = null

  constructor(private d: DriftDeps) {}

  start(): Cancel {
    const interval = this.d.intervalMs ?? 10_000
    let cancelled = false
    let cancelTimer: Cancel = () => {}
    this.check()
    const loop = () => {
      if (cancelled) return
      this.check()
      cancelTimer = this.d.clock.schedule(interval, loop)
    }
    cancelTimer = this.d.clock.schedule(interval, loop)
    return () => { cancelled = true; cancelTimer() }
  }

  check(): void {
    const wall = this.d.wall()
    const mono = this.d.mono()

    if (this.#lastWall === null || this.#lastMono === null) {
      this.#lastWall = wall
      this.#lastMono = mono
      return
    }

    const skew = (wall - this.#lastWall) - (mono - this.#lastMono)
    this.#lastWall = wall
    this.#lastMono = mono

    if (Math.abs(skew) >= (this.d.thresholdMs ?? 5_000)) this.d.onDrift(skew)
  }
}
```

- [ ] **Step 4: Wire it into the engine**

In `packages/engine/src/engine.ts`, add to `EngineDeps`:

```ts
  /** Optional; when absent the engine simply does not re-arm after sleep. */
  drift?: { start(): () => void }
```

Add the method and start the detector:

```ts
  /**
   * Called after a sleep or clock change. Ladders scheduled before the jump are
   * no longer trustworthy, so every still-waiting session is re-armed from now
   * and the watchdog re-evaluates immediately.
   */
  onResume(): void {
    for (const s of this.d.store.list()) {
      if (s.tier === null || s.waitingSince === null) continue
      this.d.escalator.cancel(s.sessionId)
      this.d.escalator.begin(s, s.tier)
    }
    this.d.watchdog.tick()
    this.d.server.broadcast(this.d.store.list())
  }
```

and inside `start()`, after `this.#stopWatchdog = this.d.watchdog.start()`:

```ts
    this.#stopDrift = this.d.drift?.start() ?? null
```

with the field `#stopDrift: (() => void) | null = null` and `this.#stopDrift?.()` added to `stop()`.

In `packages/engine/src/bin.ts`, construct it after `engine` exists and pass it in:

```ts
import { performance } from 'node:perf_hooks'
import { DriftDetector } from './drift.js'

const drift = new DriftDetector({
  clock,
  wall: () => Date.now(),
  mono: () => performance.now(),
  onDrift: () => engine.onResume(),
})
```

then add `drift` to the `new Engine({ ... })` argument list.

- [ ] **Step 5: Add an engine-level test for re-arming**

Append to `packages/engine/test/engine.test.ts`:

```ts
describe('resume after sleep', () => {
  it('re-arms a still-waiting session so escalation is not lost to a sleeping laptop', async () => {
    build()
    engine.handle(ev('Notification', { message: 'Allow?' }))
    clock.advance(120_000)
    engine.onResume()          // laptop woke; ladder restarted from now
    clock.advance(120_000)
    expect(phone).toHaveLength(0)
    clock.advance(60_001)
    await vi.waitFor(() => expect(phone).toHaveLength(1))
  })

  it('leaves a non-waiting session alone', () => {
    build()
    engine.handle(ev('SessionStart'))
    expect(() => engine.onResume()).not.toThrow()
    expect(phone).toHaveLength(0)
  })
})
```

- [ ] **Step 6: Run the tests and build**

Run: `npx tsc --build && npx vitest run packages/engine`
Expected: PASS, including the 6 drift tests and 2 new engine tests

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/drift.ts packages/engine/src/engine.ts packages/engine/src/bin.ts packages/engine/test/drift.test.ts packages/engine/test/engine.test.ts
git commit -m "feat(engine): detect sleep and clock changes, re-arm waiting sessions on resume"
```

---

## Task 22: Detect `AskUserQuestion` as a blocking wait

> **Added 2026-08-10 during execution, after Task 6 shipped.** Not part of the original plan.

**Files:**
- Modify: `packages/engine/src/state.ts` — `apply()`'s `PreToolUse` case
- Test: `packages/engine/test/state.test.ts` — append a new describe block

**Interfaces:**
- Consumes: unchanged. `NudgeEvent.tool` already carries the tool name from Task 5's normalizer.
- Produces: no signature change. `apply()` gains one behaviour: a `PreToolUse` for a blocking tool now returns `started: 'blocked'` instead of `started: null`.

### Why this exists

The plan assumed the `Notification` hook covers every case where Claude waits on a human. It does not. Verified against the current hooks reference and anthropics/claude-code#59908 (closed `not_planned`): **`AskUserQuestion` — the multiple-choice dialog — never fires `Notification`.** It has "Permission required: No", so it never enters the permission flow, and at the hook layer Claude appears to be waiting on a tool result rather than on the user.

This is not a cosmetic gap. `AskUserQuestion` is one of the three cases the product exists to catch. Worse, the plan's design makes it actively wrong: `PreToolUse` is treated as an *activity* signal that CLEARS a pending wait, so Claude asking a multiple-choice question currently cancels an alert instead of raising one.

`ExitPlanMode` is included alongside it as belt-and-braces. It normally fires `Notification` because it does require permission — but a user who allowlists it would get no `Notification`, while the plan-approval dialog still blocks. Detecting it here closes that hole at no cost.

`PostToolUse` fires only after the user answers, so the governing rule resolves these waits for free — no special-case teardown needed.

- [ ] **Step 1: Write the failing tests**

Append to `packages/engine/test/state.test.ts`:

```ts
describe('AskUserQuestion and other blocking tools', () => {
  it('treats an AskUserQuestion PreToolUse as a blocked wait, not as activity', () => {
    store.apply(ev('SessionStart'))
    store.apply(ev('UserPromptSubmit'))
    const t = store.apply(ev('PreToolUse', { tool: 'AskUserQuestion' }))
    expect(t.started).toBe('blocked')
    expect(t.session.status).toBe('blocked')
    expect(t.session.waitingSince).toBe(clock.now())
    expect(t.session.message).toMatch(/question/i)
  })

  it('treats ExitPlanMode the same way', () => {
    const t = store.apply(ev('PreToolUse', { tool: 'ExitPlanMode' }))
    expect(t.started).toBe('blocked')
    expect(t.session.message).toMatch(/plan/i)
  })

  it('still treats an ordinary tool as activity that clears a wait', () => {
    store.apply(ev('Notification', { message: 'Allow?' }))
    const t = store.apply(ev('PreToolUse', { tool: 'Bash' }))
    expect(t.cleared).toBe('blocked')
    expect(t.started).toBeNull()
    expect(t.session.status).toBe('running')
  })

  it('resolves the question wait when the user answers', () => {
    store.apply(ev('PreToolUse', { tool: 'AskUserQuestion' }))
    clock.advance(30_000)
    const t = store.apply(ev('PostToolUse', { tool: 'AskUserQuestion', ts: clock.now() }))
    expect(t.cleared).toBe('blocked')
    expect(t.session.status).toBe('running')
    expect(t.session.waitingSince).toBeNull()
  })

  it('does not stall a session that is blocked on a question', () => {
    store.apply(ev('PreToolUse', { tool: 'AskUserQuestion' }))
    expect(store.markStalled('s1')).toBeNull()
  })

  it('does not treat a PostToolUse for a blocking tool as a new wait', () => {
    const t = store.apply(ev('PostToolUse', { tool: 'AskUserQuestion' }))
    expect(t.started).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/engine/test/state.test.ts`
Expected: the first, second, fourth and sixth tests fail — `started` is `null` because `PreToolUse` currently falls through to the no-op branch. The third and fifth already pass.

- [ ] **Step 3: Implement**

In `packages/engine/src/state.ts`, add above the class:

```ts
/**
 * Tools whose invocation means Claude is now waiting on the human.
 *
 * AskUserQuestion has "Permission required: No", so it never fires the
 * Notification hook (anthropics/claude-code#59908) — without this, the
 * multiple-choice dialog would look like ordinary tool activity and would
 * CLEAR a pending wait instead of starting one.
 *
 * ExitPlanMode normally does fire Notification via the permission flow; it is
 * listed here so an allowlisted ExitPlanMode still registers as a wait.
 */
const BLOCKING_TOOLS: Record<string, string> = {
  AskUserQuestion: 'Claude is asking you a question',
  ExitPlanMode: 'Claude is waiting for you to approve its plan',
}
```

Then replace the `PreToolUse` arm of the switch in `apply()`. It currently shares a no-op branch with `SessionStart` and `PostToolUse`:

```ts
      case 'PreToolUse': {
        const prompt = ev.tool ? BLOCKING_TOOLS[ev.tool] : undefined
        if (prompt) {
          s.status = 'blocked'
          s.tier = 'blocked'
          s.waitingSince = ev.ts
          s.message = prompt
          started = 'blocked'
        }
        break
      }

      case 'SessionStart':
      case 'PostToolUse':
        break
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/engine/test/state.test.ts`
Expected: PASS, 26 tests

Then the full suite and build:

Run: `npx vitest run && npx tsc --build`
Expected: all green

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/state.ts packages/engine/test/state.test.ts
git commit -m "fix(engine): treat AskUserQuestion and ExitPlanMode as blocking waits

AskUserQuestion never fires the Notification hook (claude-code#59908), so the
multiple-choice dialog was being read as ordinary tool activity and CLEARED a
pending wait instead of raising one."
```

---

## Phase 1 done

At this point you have working software: a real Claude Code permission prompt produces a sound and a desktop notification immediately, and a phone push if you don't come back — with everything cancelling the moment you respond.

**Phases 2 and 3 get their own plans**, written after Phase 1 lands so they can be informed by what Phase 1 actually taught us:

- **Phase 2** — `@nudge/shell`: Electron tray with waiting-count badge, the dropdown, dock bounce / taskbar flash, click-to-jump per surface, and idle reporting into the engine.
- **Phase 3** — telegram / pushover / webhook adapters, the history window, signed installers for all three platforms, and npm publication.
