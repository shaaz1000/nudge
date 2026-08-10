# Nudge — Pending-Input Notifier for AI Coding Agents

**Date:** 2026-08-10
**Status:** Design approved, ready for implementation planning
**Working name:** Nudge (placeholder — rename before public release)

---

## 1. Problem

When working with an AI coding agent, the agent frequently stops and waits for the
human: a tool-permission prompt, a clarifying question, or simply the end of a turn.
If the human has switched to another window or walked away, nothing signals this.
They return minutes or hours later to find the task never progressed.

The cost is not the agent's time — it is the human's. The work sat idle and nobody
knew.

## 2. Goals

- Signal **immediately and locally** when an agent session is blocked on the human.
- **Escalate to the phone** if the local signal goes unanswered.
- Make it **one click to return** to the exact editor window that is waiting.
- Work for **anyone**, not just the author's machine or team: cross-platform,
  easy to install, easy to extend.
- Never slow down, block, or break the agent session it is watching.

## 3. Non-goals (v1)

- Answering the agent's question **from** the phone. The phone tells you to come
  back; it is not a remote control. The channel abstraction leaves room for this
  later (Telegram inline buttons are the obvious path) but it is out of scope.
- Watching agents other than Claude Code. Cursor, Windsurf, Copilot and web chats
  have no notification hook API; detecting "waiting for input" there requires
  window-title polling or accessibility-API scraping, which is fragile. The
  event-source seam exists so these can be added later without redesign.
- A history/analytics product. The history window shows what waited and for how
  long. It is not a time-tracking tool.

## 4. Decisions

| Question | Decision |
|---|---|
| Where must the alert reach? | Local first; escalate to phone if unanswered |
| Which agents? | Claude Code only (all surfaces: VSCode, CLI, desktop) |
| Which events? | All four classes — blocked, turn-finished, long-task, stalled |
| Local UI | Menu-bar/tray app **plus** a history window |
| Desktop OS support | macOS + Windows + Linux from day 1 |
| Audience | Public — anyone, any team; must be easily adaptable |
| Alert detail | Desktop: full. Phone: minimal. Full-on-phone is opt-in. |
| Architecture | Headless core engine + Electron shell client |

### 4.1 Why the phone channel is pluggable

Investigated whether the phone could be reached over LAN/Bluetooth with no third
party:

- **Same WiFi, Android: yes.** A self-hosted ntfy server on the LAN works fully
  locally — the Android app holds a WebSocket open via a foreground service, so
  alerts arrive with the phone locked and nothing leaves the network.
- **Same WiFi, iOS: no.** Apple only wakes a backgrounded app through APNs, which
  requires a push certificate tied to an App Store app. Even self-hosted ntfy
  topics relay through ntfy.sh on iOS. There is no non-App-Store workaround.
- **Bluetooth: no, either platform.** A Mac can advertise over BLE, but nothing
  surfaces on the phone without a native app installed and listening. iOS iBeacon
  region monitoring can wake an app from a killed state, but "an app" means
  shipping a native iOS app through App Store review — a separate product.

Therefore phone delivery is an **adapter interface**, not a fixed integration.
ntfy ships as the default (self-hostable for LAN-only Android users, ntfy.sh for
iOS users); telegram, pushover and a generic webhook ship alongside.

## 5. Architecture

Four packages in one monorepo.

```
  Claude Code
      │  fires hook (short-lived process)
      ▼
  ┌──────────────┐   unix socket / named pipe
  │ @nudge/hook  │ ─────────────────────────┐
  └──────────────┘                          │
                                            ▼
                            ┌───────────────────────────────┐
                            │      @nudge/engine            │  always running
                            │  • event intake               │  (launchd/systemd/
                            │  • waiting-session state      │   Task Scheduler)
                            │  • escalation timers          │
                            │  • desktop notification+sound │
                            │  • SQLite event log           │
                            └───┬───────────────────────┬───┘
                                │ subscribe/commands    │ send()
                                ▼                       ▼
                        ┌───────────────┐      ┌──────────────────┐
                        │ @nudge/shell  │      │ @nudge/channels  │
                        │ Electron:     │      │ ntfy (default)   │
                        │ tray, badge,  │      │ telegram         │
                        │ dropdown,     │      │ pushover         │
                        │ history win   │      │ webhook          │
                        └───────────────┘      └──────────────────┘
```

### 5.1 `@nudge/hook`

A tiny binary invoked by Claude Code. Reads hook JSON from stdin, connects to the
engine socket, writes the event, exits.

Hard constraints, because a notifier that can stall the agent is worse than none:

- **500ms hard timeout.**
- **Always `exit 0`.**
- **Never writes to stdout** (stdout is meaningful to Claude Code hooks).
- If the socket is dead: spawn the engine detached, retry once, then spool the
  event to `~/.nudge/spool/` and exit silently.

### 5.2 `@nudge/engine`

The always-running daemon and the only place logic lives. Holds waiting-session
state in memory, runs escalation timers, fires desktop notifications and sound,
dispatches to channels, persists a rolling event log to SQLite.

Exposes a small local API over the same socket: `subscribe`, `list`, `snooze`,
`mute`, `resolve`, `jump`.

No GUI dependency — runs headless.

### 5.3 `@nudge/shell`

The Electron client. Tray icon with waiting-count badge, dropdown, history window,
dock bounce (macOS) / taskbar flash (Windows) / urgency hint (Linux).

It **renders engine state and sends commands; it computes nothing.** Killing it
must not stop alerts.

It also reports system idle time (`powerMonitor.getSystemIdleTime()`) to the
engine, which the engine uses to adapt escalation timing.

### 5.4 `@nudge/channels`

Phone adapters behind one interface (§9).

### 5.5 Extension seams

Two interfaces exist from day 1 even though each has one implementation:

- **Event source** — Claude Code hooks today; a browser extension or editor
  watcher later.
- **Channel** — how an alert leaves the machine.

## 6. Event model

### 6.1 Hooks subscribed

`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`,
`Stop`, `SessionEnd`.

`SubagentStop` is deliberately ignored — it fires constantly and carries no
human-blocking signal.

The Claude Code hook payload provides `session_id`, `transcript_path`, `cwd` and
`hook_event_name`, plus event-specific fields (notably `message` on
`Notification`). **Implementation must capture real payloads from the installed
Claude Code version before coding against field names** — this is the first task
in the implementation plan, not an assumption.

### 6.2 The governing rule

> Any event from session X first **clears** X's pending state, then applies
> whatever the new event implies.

This single rule makes resolution detection reliable without polling:

- Permission approved → `PostToolUse` fires → alert dies.
- Reply typed → `UserPromptSubmit` fires → alert dies.
- Permission denied → the next event from that session fires → alert dies.

### 6.3 State machine

```
SessionStart ──▶ running ◀──────────── UserPromptSubmit
                   │  ▲                      ▲
      Notification │  │ PreToolUse           │
                   ▼  │ PostToolUse          │
                blocked ─────────────────────┤
                   │                         │
              Stop │                         │
                   ▼                         │
                 idle ───────────────────────┤

  watchdog: running + silent > 15m ──▶ stalled
  SessionEnd ──▶ gone
  no events > 24h ──▶ gone (TTL)
```

### 6.4 Severity tiers

| Tier | Fires on | Default treatment |
|---|---|---|
| `blocked` | `Notification` — permission or question | Sound + banner + tray; escalates to phone |
| `idle-long` | `Stop`, turn ran longer than 3 min | Sound + banner + tray; escalates to phone |
| `idle-short` | `Stop`, turn ran under 3 min | **Tray badge only, silent — never escalates to phone** |
| `stalled` | Watchdog | Banner + tray; phone only if configured |

`idle-short` is silent by default because it fires on every quick turn, and a
sound heard forty times an hour stops being heard at all. It remains visible in
the tray; one config flag makes it audible.

### 6.5 The watchdog is heuristic, and says so

A session sitting in `PreToolUse` on a nine-minute test script is indistinguishable
from a crashed one — the hook stream looks identical either way. Hence a
conservative 15-minute default and no phone escalation unless explicitly enabled.

`SessionEnd` covers clean exits. Crashes frequently fire nothing at all, which is
precisely why the watchdog exists despite being imperfect.

### 6.6 De-duplication

A repeat `Notification` carrying the same message for an already-`blocked` session
updates the timer but does **not** re-alert. Claude Code's own re-prompting must
not become a siren.

### 6.7 Persistence

SQLite, two tables:

- `events` — raw event log: `ts`, `session_id`, `cwd`, `surface`, `hook`, `tier`,
  `message`.
- `waits` — derived: `session_id`, `tier`, `waiting_since`, `resolved_at`,
  `resolved_by`.

The history window is a query over `waits`. Retention 30 days, configurable.

## 7. Escalation and suppression

### 7.1 The ladder

```
t=0          local: tier sound + OS banner + tray red with count
             + dock bounce / taskbar flash / urgency hint
t=60s        repeat sound, max 3 times, only while unresolved
t=escalate   phone push — minimal payload
t=+5m ×2     optional phone repeat (off by default)
any event    everything cancels instantly
```

### 7.2 Adaptive escalation delay

The engine adapts `escalate` using system idle time reported by the shell:

- Machine **active** → 3 minutes. The human is probably mid-thought in another
  window and will come back on their own.
- Machine **idle > 60s** → 45 seconds. The human has walked away; this is the case
  the product exists for.
- Shell not running → fixed 3 minutes.

### 7.3 Suppression, in priority order

1. The session's own window is already frontmost → tray-only (they can see it).
2. Global mute.
3. Per-session snooze — 10m / 30m / 1h from the dropdown.
4. Quiet hours — a configured window in which local alerts still show but phone
   push is held.

macOS Focus/DND detection is **deliberately not attempted**. The available APIs
are unreliable, and a suppression rule that silently half-works is worse than a
config line set once.

## 8. Jumping back to the editor

A surface fingerprint is captured at `SessionStart` from the environment:
`TERM_PROGRAM`, `TERM_SESSION_ID`, `CLAUDECODE`, `TMUX`, `WT_SESSION`, tty, `cwd`,
`ppid`.

| Surface | Mechanism | Reliability |
|---|---|---|
| VSCode / Cursor / Windsurf | `code <cwd>` — focuses the existing window holding that folder | Solid, all 3 OSes |
| Terminal.app / iTerm2 | AppleScript targeting the recorded tty | Good (macOS) |
| Windows Terminal | Focus by process + `WT_SESSION` | Decent |
| Linux terminals | `wmctrl` / `xdotool` if present | X11 only — **Wayland is a known gap** |
| Claude Code desktop | Focus by bundle/process id | Solid |

Fallback when the surface cannot be resolved: focus nothing, copy the project path
to the clipboard, and say so in the notification. Honest beats magical.

The Wayland gap is documented in the README rather than papered over.

## 9. Channel interface

```ts
interface Channel {
  id: string
  configSchema: JSONSchema         // validated on load
  send(alert: Alert, cfg): Promise<void>
  verify?(cfg): Promise<void>      // powers `nudge test <channel>`
}

type Alert = {
  project: string
  tier: 'blocked' | 'idle-long' | 'idle-short' | 'stalled'
  waitingSince: number
  detail?: string                  // present only when fullDetail is enabled
}
```

Shipped adapters:

| Adapter | Notes |
|---|---|
| `ntfy` | **Default.** Takes `serverUrl`, so LAN-only self-hosting is one config line. iOS + Android. |
| `telegram` | Bot token + chat id. Natural upgrade path for reply-from-phone later. |
| `pushover` | Native repeat-until-acknowledged, bypasses DND. |
| `webhook` | Generic POST — covers Pushcut, Apple Shortcuts, Slack, Discord, Home Assistant. |

Third-party adapters load from `~/.nudge/channels/*.js`.

Apple Shortcuts cannot be installed programmatically; the README documents an
iCloud share link the user taps once, paired with the `webhook` adapter.

## 10. Privacy and security

- **Desktop alerts carry full detail** (the actual question, the exact command).
  This never leaves the machine.
- **Phone alerts carry project name and event type only** by default — e.g.
  "Sales-Dashboard needs you (permission)". No commands, paths, arguments or
  secrets traverse a third-party service.
- `fullDetail: true` is available for people running a self-hosted push server.
  It is opt-in and documented with its risk stated plainly.
- No secret-redaction pass is shipped. A redactor is never perfect, and
  "never perfect" applied to credentials is a liability in a published tool.
  Minimal-by-default sidesteps the problem entirely.
- The engine listens on a **filesystem socket with `0600` permissions**, never a
  network port. Nothing is exposed to the LAN.

## 11. Configuration

`~/.nudge/config.json`:

- Escalation base: `activeDelay` (default 180s) and `idleDelay` (default 45s),
  selected by §7.2, plus local repeat count and phone repeat count.
- Per-tier: `enabled`, `sound`, `escalates` (bool), and an optional
  `escalateDelay` that **overrides** the base for that tier. Precedence is
  per-tier override → idle-adaptive base. A tier with `escalates: false` never
  reaches a channel regardless of delay.
- Quiet hours.
- `detailLevel`: `minimal` (default) | `full`.
- Channel id + its settings.
- Retention days.
- Per-project overrides map, so "mute this repo" from the dropdown persists.

## 12. Install and setup

**Primary door:** a signed download (DMG / exe / AppImage) bundling engine, hook
and shell, self-configuring on first launch. This is the path a non-technical user
takes.

**Secondary door:** `npm i -g @nudge/engine` for headless or server use, no
Electron.

`nudge setup` performs:

1. Timestamped backup of `~/.claude/settings.json`.
2. Structural merge that **only appends** to existing `hooks` arrays.
3. JSON validation before write.
4. Install the engine as a login service (launchd / systemd --user / Task Scheduler).
5. Prompt for a phone channel and send a test alert.

`nudge setup --dry-run` prints the diff without writing.
`nudge uninstall` removes exactly what was added and nothing else.

The settings file is treated as sacred: real users have large hand-built
permission allowlists in it, and clobbering one is unrecoverable damage.

## 13. Failure modes

| Failure | Behaviour |
|---|---|
| Engine down when hook fires | Hook spawns it, retries once, else spools to disk; engine drains spool on boot. Hook still exits 0 within 500ms. |
| Channel send fails | 3 retries with backoff, then a "phone push failed" badge in the tray. Never blocks the local alert, never crashes the engine. |
| Engine crash | Restarted by the OS service manager; rebuilds state from spool + event log; drops sessions past the 24h TTL. |
| Shell crash | Alerts continue — the engine owns them. Shell reconnects on next launch. |
| Sleep / wake, clock change | Monotonic timers, re-evaluated on resume. |
| Stale sessions | 24h TTL, dropped. |

## 14. Testing strategy

Splitting the engine out of the GUI exists primarily to make this possible.

- **Unit** — the state machine, all four tiers, every suppression rule and every
  resolution path, driven by an injectable clock. Pure Node, zero GUI.
- **Golden fixtures** — real hook payloads captured from a live Claude Code
  session, replayed through the engine.
- **Integration** — a driver emitting a realistic
  `SessionStart → UserPromptSubmit → PreToolUse → Notification → PostToolUse`
  sequence into the real socket, with a spy channel asserting exactly what fired
  and when.
- **End-to-end** — install into a scratch `HOME`, run a real Claude Code session
  that triggers a real permission prompt, assert tray state and notification.
- **Channels** — tested against a local ntfy container; `nudge test <channel>` for
  humans.
- **CI** — macOS / Windows / Linux matrix for engine and hook; Electron smoke test
  for the shell.

## 15. Deferred to v2

- Reply to the agent from the phone (Telegram inline buttons).
- Event sources beyond Claude Code: browser extension for web chats, editor
  watchers for Cursor/Windsurf.
- Tauri shell to replace Electron once the engine is proven.
- Wayland window focus.
- Team/relay mode with zero-setup onboarding.
