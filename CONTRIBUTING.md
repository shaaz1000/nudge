# Contributing to Nudge

Thanks for considering it. This is a small project with a clear job — tell you
when Claude Code is waiting on you — and contributions that keep it sharp are
very welcome.

## Getting set up

Requires **Node 22.5+** (the engine uses the built-in `node:sqlite`).

```bash
git clone https://github.com/<your-username>/nudge.git
cd nudge
npm install
npx tsc --build                  # required: packages resolve through dist/
npm test                         # 743 tests, should all pass
npx tsc -p tsconfig.test.json    # type-checks the test files too
```

`npx tsc --build` is not optional. The workspace packages resolve each other
through their compiled `dist/` output, which isn't committed.

### Running it without touching your real setup

Point `NUDGE_HOME` somewhere disposable and nothing will go near your real
config, database, socket or Claude Code settings:

```bash
NUDGE_HOME=/tmp/nudge-dev node packages/engine/dist/bin.js
```

Please do this rather than testing against your live engine.

## How to contribute

`main` is protected — fork, branch, and open a pull request.

```bash
git checkout -b fix/short-description
# ...
npm test && npx tsc --build && npx tsc -p tsconfig.test.json
git commit -m "component: what changed and why"
```

CI runs on macOS, Linux and Windows. It also builds the tray app and runs a
real Electron smoke test on each platform, because a green unit suite has
historically said very little about whether the built artifact works.

## The testing bar

One thing to know before writing tests here.

This project has found **seventeen tests that could not fail** — tests that
passed just as happily against a broken implementation. Several were mine.
A couple of examples, because they're more instructive than a rule:

- `app.dock.bounce()` returns `0` for the first bounce of a process. The test
  fake returned ids starting at `1`, so `if (this.#bounceId)` passed all 41
  tests while never cancelling the real first bounce — the exact
  bouncing-forever bug the feature existed to prevent.
- `app.dock.show()` is asynchronous. Every fake was synchronous, so ~27 tests
  drove a code path macOS never takes, and two of them asserted guarantees that
  were *false in production*.

Both share a shape: **the fake was faithful to someone's mental model of the
API rather than to the API.** So:

1. **Ask what production mistake your test fails against.** If you can't name
   one, the test isn't earning its place.
2. **Prove it.** Break the code deliberately, watch the test go red, restore.
   And check the break actually applied — a no-op `sed` looks exactly like a
   passing test. This has caught bad break-proofs more than once.
3. **Build fakes from observed behaviour**, not from documentation. If a real
   API is async, returns odd sentinel values, or is a no-op in some states, the
   fake must be too.
4. **Never let a test touch the real thing** — no real `~/.nudge`, no real
   `~/.claude/settings.json`, no real engine socket, no real notifications,
   Dock or Tray. Every OS surface is behind an injectable interface for exactly
   this reason.

## Project layout

```
packages/
  shared/    types, wire protocol, config parsing — the single source of truth
  engine/    the daemon: session state, escalation, suppression, SQLite log
  hook/      what Claude Code invokes; must exit <500ms and always exit 0
  cli/       nudge setup/status/list/...
  channels/  phone adapters (ntfy today)
  client/    socket client shared by the extension and the tray
  vscode/    the VS Code extension
  tray/      the Electron menu-bar app
```

Two rules that keep it coherent:

- **The engine owns all state and all decisions.** Clients render what it
  broadcasts and send commands back. Tier logic, escalation timing and
  suppression rules live in the engine; if a client re-derives one, it must
  match `packages/engine/src/suppression.ts` exactly, and the engine is the
  authority when they disagree.
- **The hook must never slow you down.** It forwards an event and exits. If the
  engine is unreachable it spools to disk. A notifier that can stall your
  session is worse than no notifier.

## Especially wanted

- **Verifying Windows or Linux.** The taskbar flash is implemented and CI runs
  it on real runners, but nobody has watched a taskbar actually flash.
  `flashFrame` on a window with no taskbar button is a silent no-op, so no
  automated check can tell. Just telling us what you see is a real contribution.
- **New phone channels.** `packages/channels` is a small interface — Pushover,
  Discord, Slack, Telegram would all fit the same shape as ntfy.
- **Linux autostart**, mirroring `packages/tray/scripts/install-launchagent.mjs`.

## Reporting bugs

Include your OS and version, `node --version`, and `nudge status` output. If it
involves a missing notification, say which signals *did* arrive (sound? bounce?
banner? phone?) — they come from different components, so which ones landed
usually points straight at the cause.

Security issues: see [SECURITY.md](SECURITY.md) — please don't open a public
issue.
