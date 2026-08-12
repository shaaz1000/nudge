# Nudge

Nudge watches your Claude Code sessions and tells you the moment one is
blocked waiting on you — a permission prompt, a question, or just a finished
turn — first on the desktop, then on your phone if you don't come back.

The problem it solves: an agent stops and waits, you've switched to another
window or walked away, and nothing tells you. You come back ten minutes
later to find the task never moved.

**Phase 1** shipped a headless daemon plus desktop and phone notifications.
**Phase 2** (this branch) adds a VS Code extension: a status bar item that
shows whether any of *this window's* sessions are waiting on you, a toast
the moment one starts, and click-to-jump — clicking the status bar item (or
a toast's "Go to it" action) brings the right window forward and reveals the
terminal Claude Code is running in. See [The VS Code extension](#the-vs-code-extension)
below to build and install it, and [Limitations](#limitations) for what's
still missing (the OS-level desktop notification itself still isn't
clickable — that's Phase 3's tray app).

## How it works

```
Claude Code                 nudge-hook               nudge-engine
  fires a hook  ──stdin──▶  short-lived   ──socket──▶  daemon  ──▶ desktop notification + sound
  (SessionStart,            process, exits                │
   Notification,            in <500ms,                    ▼
   PreToolUse, ...)          always exit 0            still waiting after
                                                        a delay?
                                                            │
                                                            ▼
                                                     phone channel (ntfy, ...)
```

- **`nudge-hook`** is what Claude Code actually invokes on every subscribed
  hook. It reads the hook's JSON payload from stdin, forwards a normalized
  event over a Unix socket (a named pipe on Windows) to the engine, and exits.
  It is contractually bound to finish in under 500ms, never write to stdout,
  and always exit 0 — a notifier that can stall or break your coding session
  is worse than no notifier. If the engine isn't reachable, the event is
  spooled to disk and replayed on the engine's next boot; nothing is lost.
- **`nudge-engine`** is the daemon. It tracks every session's state (running,
  blocked, idle, stalled), fires the local desktop alert immediately, and — if
  nobody responds — escalates to your phone through a pluggable channel after
  a fixed delay (`escalation.activeDelayMs`, 3 minutes by default). The
  engine's escalation math (`escalateDelayFor`) already has an idle-aware
  path that would shorten this once it knows you've stepped away, but no
  client reports idle time to it yet — the socket protocol has an `idle`
  message and `nudge-engine` can consume one, but the Phase 2 VS Code
  extension doesn't send it either (it only reports `frontmost`, a
  different, window-focus-based signal — see
  [The VS Code extension](#the-vs-code-extension)). Until some client
  starts sending `idle`, the delay is the same fixed 3 minutes whether
  you're at your desk or not.
- **`nudge`** is the CLI: install/uninstall the hooks, start the engine,
  check status, list what's waiting, snooze or mute, send a test push.

## Install

Requires **Node ≥ 22.5** (the engine's event log uses the built-in
`node:sqlite` module — no native compilation, no separate database to install).
Verified against Node 24; CI runs on Node 24.

```bash
git clone <this repo>
cd nudge
npm install
npx tsc --build
```

This builds every package under `packages/*/dist`. There is no published npm
package yet, so the CLI is invoked directly:

```bash
node packages/cli/dist/bin.js <command>
```

(Optionally put a short shell function or alias called `nudge` around that
path, or `npm link` inside `packages/cli` — either way, the commands below
are written as `nudge <command>` for brevity.)

## `nudge setup`

```
nudge setup [--dry-run]   install hooks into Claude Code and register the engine
nudge uninstall           remove exactly the hooks Nudge added
nudge start                start the engine in the background
nudge status               config, channel, and engine health
nudge list                 what is waiting on you right now
nudge test [channel]       send a test alert to your phone
nudge snooze <id> [min]    snooze a session (default 10 minutes)
nudge mute [off]           mute or unmute all alerts
```

`nudge setup` does two things:

1. Appends seven hook entries (`SessionStart`, `UserPromptSubmit`,
   `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionEnd`) to your
   Claude Code settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR`).
   The merge is append-only and idempotent: it never touches a hook entry it
   didn't create (ownership is tracked by an internal `_nudge` marker, not by
   matching text in your own hook commands), and it takes a timestamped
   backup (`settings.json.nudge-backup-<timestamp>`) before writing.
2. Registers the engine as a login service — a LaunchAgent on macOS, a
   systemd user unit on Linux, a Scheduled Task on Windows — so it's running
   before you need it. If your platform has none of those, it says so and you
   run `nudge start` yourself (or after every reboot).

Run `nudge setup --dry-run` first. It prints the exact diff against your
current settings file and makes no changes — inspect it before committing.

`nudge uninstall` reverses this exactly: it removes only the entries carrying
Nudge's ownership marker and leaves everything else in your settings file
byte-for-byte untouched. It also takes a backup first.

Once installed, set a phone channel (see [Config](#config-reference) below)
and confirm it with `nudge test`.

## Config reference

Config lives at `~/.nudge/config.json` (or `$NUDGE_HOME/config.json`). Every
field is optional; anything you omit falls back to the default shown. An
unknown key or a wrong-shaped value throws loudly at load time rather than
being silently ignored.

```jsonc
{
  // "minimal" (default): phone pushes carry only project name + tier.
  // "full": phone pushes also carry the actual question/command text.
  // Only set "full" against a push server you control — see Limitations.
  "detailLevel": "minimal",

  // Silence every alert, local and phone, regardless of anything else below.
  "muted": false,

  "escalation": {
    "activeDelayMs": 180000,      // delay before phone push while you're active (3 min)
    "idleDelayMs": 45000,         // delay before phone push once you're idle (45s)
    "idleThresholdMs": 60000,     // how long with no input counts as "idle" (1 min)
    "longTurnMs": 180000,         // a turn this long or longer is "idle-long" not "idle-short"
    "localRepeat": 3,             // how many times to repeat the desktop alert
    "localRepeatIntervalMs": 60000,
    "phoneRepeat": 0,             // how many times to repeat the phone push
    "phoneRepeatIntervalMs": 300000
  },

  // Suppress phone pushes (never local alerts) during a window. Handles
  // windows that cross midnight. null = no quiet hours.
  "quietHours": { "start": "23:00", "end": "07:00" },

  "watchdog": {
    "stallAfterMs": 900000,   // 15 min with no hook activity while "running" -> stalled
    "sessionTtlMs": 86400000, // drop a session entirely after 24h of silence
    "tickMs": 30000
  },

  // Per-tier behaviour. Tiers are: blocked, idle-long, idle-short, stalled.
  "tiers": {
    "blocked":    { "enabled": true, "sound": "blocked", "escalates": true },
    "idle-long":  { "enabled": true, "sound": "done",    "escalates": true },
    "idle-short": { "enabled": true, "sound": null,       "escalates": false },
    "stalled":    { "enabled": true, "sound": "stalled",  "escalates": false }
    // Any tier may also set "escalateDelayMs": <number> to override the
    // idle-adaptive activeDelayMs/idleDelayMs pair with a fixed delay.
  },

  // Which phone channel to use, and its own options (see below).
  "channel": { "id": "ntfy", "options": { "topic": "your-topic-here" } },

  // Days to keep resolved history rows and raw events. An open (unresolved)
  // wait is never pruned regardless of age.
  "retentionDays": 30,

  // Per-project overrides, keyed by the session's cwd (the exact working
  // directory Claude Code was launched from), not by display name.
  "projects": { "/Users/you/code/some-repo": { "muted": true } }
}
```

### The `ntfy` channel

The only channel that ships built-in. [ntfy](https://ntfy.sh) is free,
open-source, and self-hostable.

```jsonc
"channel": {
  "id": "ntfy",
  "options": {
    "topic": "your-topic-here",       // required — pick something unguessable
    "serverUrl": "https://ntfy.sh",   // optional, defaults to ntfy.sh
    "token": "..."                    // optional bearer token for a protected server
  }
}
```

Install the ntfy app, subscribe to your topic, and either use the public
`ntfy.sh` relay or point `serverUrl` at your own server. See
[iOS cannot receive LAN-only push](#limitations) before assuming a
self-hosted server keeps everything on your LAN.

## Writing a channel adapter

A channel is any module exporting a default object matching this interface
(from `packages/channels/src/types.ts`):

```ts
export interface Channel {
  id: string
  configSchema: object
  send(alert: Alert, cfg: Record<string, unknown>): Promise<void>
  verify?(cfg: Record<string, unknown>): Promise<void>   // used by `nudge test`
}
```

`Alert` is intentionally small: `{ sessionId, project, tier, waitingSince,
detail? }`. `detail` is populated by the engine only when `detailLevel` is
`"full"` — a channel must never decide that itself, only choose whether to
use `detail` when it's present.

Drop a `.js`/`.mjs` file exporting one of these into `~/.nudge/channels/` (or
`$NUDGE_HOME/channels/`) and it's picked up automatically — no build step, no
registration. A file matching an existing id (e.g. `ntfy`) overrides the
built-in; a file that throws while loading is skipped silently (`nudge
status` shows which adapters actually loaded). Here's a complete Pushover
adapter in under 30 lines:

```js
// ~/.nudge/channels/pushover.js
const TIER_BODY = {
  'blocked': 'Waiting on you: permission or question',
  'idle-long': 'Long task finished — your move',
  'idle-short': 'Turn finished — your move',
  'stalled': 'Session may have stalled',
}

async function post(cfg, message, title) {
  const body = new URLSearchParams({
    token: cfg.appToken, user: cfg.userKey, title, message,
  })
  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST', body,
  })
  if (!res.ok) throw new Error(`pushover: HTTP ${res.status}`)
}

export default {
  id: 'pushover',
  configSchema: {
    type: 'object',
    required: ['appToken', 'userKey'],
    properties: { appToken: { type: 'string' }, userKey: { type: 'string' } },
  },
  async send(alert, cfg) {
    await post(cfg, alert.detail ?? TIER_BODY[alert.tier], `${alert.project} needs you`)
  },
  async verify(cfg) {
    await post(cfg, 'If you can read this, your phone channel works.', 'Nudge test')
  },
}
```

Then set `"channel": { "id": "pushover", "options": { "appToken": "...", "userKey": "..." } }`
in your config and run `nudge test`.

## The VS Code extension

`packages/vscode` is a VS Code extension (source name `nudge-vscode`,
display name "Nudge") that talks to the same engine socket the CLI and hooks
use — it subscribes for live updates and asks for the current state on
connect, so it also sees whatever was already waiting before the extension
started. It adds:

- A status bar item, always visible: `$(bell-slash) Nudge` when the engine
  is unreachable, dim `$(bell) Nudge` when nothing in *this window* is
  waiting, and warning-colored `$(bell-dot) Nudge N` — with a tooltip
  listing each session, its tier, and how long it's been waiting — when N
  are. Clicking it jumps to a waiting session (prompting you to pick one if
  this window owns more than one).
- A toast the moment one of this window's sessions starts waiting, with "Go
  to it" and "Snooze 10m" actions. Configurable via `nudge.showToasts`.
- Four commands (Command Palette): **Nudge: Go to Waiting Session**,
  **Nudge: Snooze a Waiting Session**, **Nudge: Toggle Mute**, **Nudge: Show
  Waiting Sessions** (lists every waiting session system-wide, not just this
  window's, and can jump to one in a different workspace by opening or
  reusing whichever window already has it open).

Jumping to a session **never resolves its wait** — clicking through only
brings the window forward and focuses the terminal; the wait stays open
until Claude Code's own hook clears it. And to be precise about what "click"
means here: this is click-to-jump *inside VS Code* (the status bar item, the
toast's button, the quick pick). The OS-level desktop notification itself —
the `osascript` / `notify-send` / PowerShell balloon Phase 1 already fires —
still is not clickable; making that jump straight from the OS notification
is Phase 3's tray app.

### Build and install the `.vsix`

There is no published extension yet, so you build and install it from
source:

```bash
npm install                    # from the repo root, if you haven't already
npx tsc --build
npm run bundle -w nudge-vscode  # esbuild bundle -> packages/vscode/dist/extension.cjs
npm run package -w nudge-vscode # vsce package --no-dependencies -> packages/vscode/*.vsix
```

(`vsce package`'s own `node_modules` walk chokes on this monorepo's
workspace symlink without `--no-dependencies` — the `package` script already
passes it.) Then, in VS Code: Command Palette → **Extensions: Install from
VSIX...** → pick the `.vsix` file `npm run package` produced. Reload the
window if it doesn't pick it up immediately.

Two settings (`nudge.showToasts`, `nudge.socketPath`) are documented inline
in VS Code's Settings UI under "Nudge".

## The tray app

`packages/tray` is an Electron menu-bar/system-tray app (`nudge-tray`,
product name "Nudge"). Like the extension, it is a *client* of the same
engine socket — it holds no state and makes no decisions of its own.

**You do not need it if you live in VS Code.** The extension already gives
you a status bar item, toasts, and click-to-jump. The tray earns its place
when you *leave* the editor, which is exactly when you miss things:

- **A menu-bar icon that is always visible**, whatever app you are in — with
  a badge of how many sessions are waiting, and a menu listing each one
  (project, tier, how long it has waited) that jumps straight to it.
- **A clickable OS notification.** Phase 1's `osascript` / `notify-send`
  banner cannot carry a click action; this one can, and it lands on the same
  focus path as everything else.
- **Focus from outside any editor** — VS Code, Cursor, Windsurf, the Claude
  desktop app, Terminal.app, iTerm2, Windows Terminal, or a clipboard
  fallback when it cannot identify the surface.
- **Persistent attention that does not time out.** On macOS the Dock icon
  appears and **bounces until you deal with it**; on Windows/Linux the
  taskbar button flashes. A notification banner disappears after a few
  seconds, so one glance away loses it — this does not.
- **Start at login**, from the tray menu.

**Both can run at once**, and that is a supported setup rather than a
conflict. They subscribe independently, and the engine deliberately treats
them differently: the tray announces itself as a GUI client, so while it is
connected the engine skips its own non-clickable banner and lets the tray
raise a clickable one instead — while still playing the alert sound and its
escalation repeats. Only the extension reports which window is frontmost.

### Persistent attention (the Dock bounce)

On by default for the tiers that escalate — `blocked` and `idle-long` — and
deliberately **not** for `idle-short`, because an icon that bounced until
dismissed every time a turn finished would train you to ignore it.

It obeys every rule the other alerts obey: mute, per-project mute, snooze,
and a tier you have disabled all suppress it. Answering the prompt stops the
bounce and removes the Dock icon again.

Tune it with a `tray` section in `~/.nudge/config.json` (the engine ignores
this key — it belongs to the tray):

The comments below are illustrative — `config.json` is parsed with
`JSON.parse`, which rejects them, so do not paste them in:

```jsonc
{
  "tray": {
    "bounceOnBlocked": true,               // master switch: false disables it entirely
    "bounceTiers": ["blocked", "idle-long"]
  }
}
```

An invalid `tray` section is reported on stderr and ignored — the app starts
on defaults rather than refusing to boot.

### Build and run it

```bash
npm install                  # from the repo root, if you haven't already
npx tsc --build              # REQUIRED first: the tray bundles against
                             # @nudge/shared and @nudge/client, whose package
                             # entry points are their dist/ output, and dist/
                             # is gitignored — on a fresh clone esbuild cannot
                             # resolve them until this has run.
npm run bundle -w nudge-tray # esbuild -> dist/index.cjs, engine, icons
npm start -w nudge-tray      # run it straight out of the repo
```

To build an installable artefact:

```bash
npm run pack -w nudge-tray   # unpacked .app/.exe tree in packages/tray/release/
npm run dist -w nudge-tray   # installer for the CURRENT platform
```

`dist` builds only the host platform's target — a `.dmg` on macOS, `.exe` on
Windows, `.AppImage` on Linux. Cross-building the Windows and Linux targets
needs Wine/Docker and is not set up here.

**The build is unsigned.** Signing macOS builds needs a paid Apple Developer
account, which this project does not have, so Gatekeeper quarantines the
`.dmg` and macOS reports that the app "is damaged" or "cannot be opened".
Clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/Nudge.app
```

Right-click → **Open** is the advice you will find elsewhere, and it **no
longer works** for unsigned apps: macOS 15 removed it as a Gatekeeper bypass.
If you would rather not use the terminal, the current path is System Settings
→ Privacy & Security → scroll to the blocked-app notice → **Open Anyway**.

That is a real cost of an unsigned build, not a formality to wave past — if
you are not willing to do it, use the VS Code extension instead.

## Limitations

These are real limits, not caveats to skim past — you will hit them.

- **The tray needs Electron with Node >= 22.5.** It spawns the engine under
  Electron's own Node (`ELECTRON_RUN_AS_NODE=1`), and the engine's event log
  uses the built-in `node:sqlite`. Electron 33 bundled Node 20, where that
  module does not exist, so "Start engine" failed with
  `ERR_UNKNOWN_BUILTIN_MODULE`. Pinned to Electron 43 (Node 24) for this
  reason — do not downgrade it.
- **The tray's Windows and Linux taskbar flash is unverified.** It was
  written and tested on macOS, where that code path never runs. The call
  sequence is asserted in tests; no real Windows taskbar has been observed
  flashing. On Linux it maps to an urgency hint that some desktop
  environments ignore outright, so treat it as best-effort.
- **Nothing tells the tray which window you are looking at.** The engine
  tracks the frontmost session (the VS Code extension reports it) but does
  not include it in the state it broadcasts, so no client can see it. The
  Dock will therefore bounce even while you are looking at the very window
  that is waiting. The suppression rule is implemented and tested on the
  tray side; closing the gap needs a field added to the engine's broadcast.
- **The OS-level desktop notification itself is still not clickable.**
  Desktop notifications are fire-and-forget platform CLIs (`osascript` /
  `notify-send` / a PowerShell balloon tip); clicking one does nothing, and
  there is no way to make it do something without a native app watching for
  it. Click-to-jump *inside* VS Code shipped in Phase 2 (see
  [The VS Code extension](#the-vs-code-extension) above) — a status bar
  item and toast actions that bring the right window forward. Making the
  literal OS notification clickable, so you never have to switch to VS Code
  first to click anything, is Phase 3's tray app.
- **The watchdog is heuristic.** A session sitting in `PreToolUse` on a
  nine-minute test script looks identical, from the hook's point of view, to
  one whose process has crashed — there is no way to tell them apart from
  outside. That's why the default stall threshold is a conservative 15
  minutes (`watchdog.stallAfterMs`) and why the `stalled` tier does not
  escalate to your phone by default (`tiers.stalled.escalates: false`). If
  you enable phone escalation for it, expect occasional false alarms on
  long-running commands.
- **Phone payloads are minimal by design.** By default a push contains only
  the project name and the tier (`blocked`, `idle-long`, etc.) — never the
  command, the question text, or the working directory. Setting
  `detailLevel: "full"` sends the actual message too. Only enable it against
  a push server you control: with the default `ntfy.sh` relay, "full" detail
  means your prompts and permission questions transit a third party's server
  in plaintext body content.
- **iOS cannot receive LAN-only push.** A self-hosted ntfy server on your own
  network delivers alerts fully locally to the Android app — nothing leaves
  the LAN. iOS is different: Apple only wakes a backgrounded app through
  APNs, so even a self-hosted `serverUrl` still relays through `ntfy.sh` on
  iOS. There is no way around this without a native App Store app.
- **Linux needs extra packages.** Desktop notifications call `notify-send`
  (package `libnotify-bin` on Debian/Ubuntu) and sound playback calls
  `paplay` (package `pulseaudio-utils`). Without them, alerts fire silently —
  the engine treats a missing notifier binary as a no-op, not an error, so
  nothing tells you it didn't work.
- **`AskUserQuestion` never fires Claude Code's `Notification` hook**
  ([anthropics/claude-code#59908](https://github.com/anthropics/claude-code/issues/59908),
  closed not-planned). At the hook layer, a multiple-choice question looks
  identical to ordinary tool activity — which would incorrectly *clear* a
  pending wait instead of starting one. Nudge works around this by treating
  `PreToolUse` for `AskUserQuestion` (and `ExitPlanMode`) as the start of a
  `blocked` wait in its own right; this is the whole reason the hook
  subscribes to `PreToolUse` at all, not just to `Notification`.
- **Sleep/wake detection may be a no-op on Windows.** After a laptop-lid-close
  or a big clock jump, the engine re-arms every still-waiting session's
  escalation ladder from now rather than firing off a timer that was
  scheduled before the jump (see `onResume()` / `DriftDetector`). Detecting
  the jump compares a monotonic clock (`performance.now()`) against wall
  clock time: a gap between them means time passed that the monotonic clock
  didn't count, i.e. a suspend. That holds on Linux, where
  `CLOCK_MONOTONIC` excludes suspended time by design. It is not guaranteed
  on Windows: `performance.now()` there is commonly backed by
  QueryPerformanceCounter, which on many systems keeps ticking through
  sleep — if so, the monotonic and wall deltas stay in lockstep across a
  suspend, no gap ever appears, and the detector simply never fires for the
  literal scenario (closing the lid) it exists to catch. This has only been
  verified against a synthetic clock in tests, not a real Windows sleep/wake
  cycle — treat it as unverified on that platform until someone spikes it on
  real hardware.

## Development

```bash
npx tsc --build      # typecheck + compile every package
npx vitest run        # run the whole suite (unit + integration)
npx vitest             # watch mode
```

`packages/engine/test/integration.test.ts` is the one suite that spawns the
*compiled* hook binary as a real child process and drives a real engine over
a real socket end to end — run `npx tsc --build` first, or it won't find
`packages/hook/dist/bin.js`.

CI (`.github/workflows/ci.yml`) runs the full build and suite on Node 24
across Ubuntu, macOS, and Windows, and also bundles `packages/vscode` and
asserts the bundle has no unresolved `@nudge/` workspace imports — `tsc
--build` and `vitest run` alone can be green while the packaged extension
is still a dead artifact (see [The VS Code extension](#the-vs-code-extension)),
so this is a separate, deliberate step, not implied by the two above it.

### Layout

```
packages/
  shared/    types, config schema + merge/validate, filesystem paths, wire protocol
  hook/      the <500ms stdin -> socket process Claude Code invokes
  engine/    session state machine, escalation ladder, watchdog, sqlite history, socket server
  channels/  the Channel interface, the built-in ntfy adapter, the channel loader
  cli/       nudge setup/uninstall/start/status/list/test/snooze/mute
  vscode/    the VS Code extension: status bar, toasts, click-to-jump (Phase 2)
```

Zero third-party runtime dependencies in `hook` and `engine` — both are meant
to run for days as an unattended background process, so their dependency
surface is deliberately tiny. `shared` and `channels` are internal workspace
packages, not exceptions to that rule. `vscode` is the one package allowed a
real dependency footprint (`@types/vscode`, `esbuild`, `@vscode/vsce`) —
its runtime code still ships as a single esbuild bundle with zero
third-party imports (see [The VS Code extension](#the-vs-code-extension)).
