# Nudge Phase 2 — VS Code Extension — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a Nudge alert brings you straight back to the VS Code window that is waiting.

**Architecture:** A VS Code extension that is a *client* of the existing Phase 1 engine. It subscribes to the engine over the same filesystem socket, renders a status bar item and a toast, and focuses the right editor on click. **No engine changes.**

**Tech Stack:** TypeScript, `@types/vscode`, `vsce` for packaging. Reuses `@nudge/shared` for the wire protocol and types.

## Why this, not the Electron tray

The original design doc named an Electron tray as Phase 2. This supersedes that for the first release:

- **Cross-platform for free.** VS Code runs on macOS, Windows and Linux; no per-OS notification code, no `terminal-notifier`-style dependency that only helps one platform.
- **Clickable at all.** macOS `osascript` notifications — Phase 1's notifier — are fire-and-forget and cannot carry a click action. This is the blocker, and an in-editor toast simply does not have it.
- **Zero engine changes.** Task 14's socket API already exposes `subscribe`, `list`, `snooze`, `mute`, `resolve`, `idle` and `frontmost`. The "editor watcher later" seam was designed in.
- **It is the original ask.** The user's first description asked for "a side icon which indicates action is pending" — that is a status bar item, not a tray.

The Electron tray remains worth building for people who do not live in VS Code. It becomes Phase 3.

## Global Constraints

- **The extension must never block the editor.** All socket I/O is async; a dead or missing engine degrades to a quiet, inactive status bar item — never an error toast on every keystroke, never a modal.
- **It is a client, not a second brain.** No tier logic, no escalation timing, no suppression rules. It renders engine state and sends commands. Any behaviour change belongs in the engine.
- **`@nudge/shared` is the single source of the wire format.** Do not re-declare `SessionState` or the protocol messages in the extension.
- **The engine socket is `0600` on a filesystem path** (named pipe on Windows) and `socketPath()` already honours `NUDGE_HOME`. Use it; do not hand-build paths.
- **Reconnect, do not crash.** The engine restarts (launchd/systemd KeepAlive); the extension must survive that with backoff and no user-visible noise.
- **Node version:** the extension host ships its own Node. Do not assume ≥22.5 — **the extension must not import `node:sqlite`** or anything else engine-only.

---

## File Structure

```
packages/vscode/
├── package.json              extension manifest: contributes, activation events, commands
├── tsconfig.json
├── .vscodeignore
├── src/
│   ├── extension.ts          activate/deactivate — the composition root
│   ├── client.ts             socket client: connect, subscribe, reconnect with backoff
│   ├── status.ts             status bar item — count, colour, tooltip
│   ├── toast.ts              notification with actions, de-duplicated per session
│   ├── focus.ts              reveal/focus logic for a waiting session
│   └── match.ts              map a SessionState to this window (cwd vs workspace folders)
└── test/
    ├── client.test.ts
    ├── match.test.ts
    └── toast.test.ts
```

---

## Task 1: Extension scaffold and engine client

**Files:**
- Create: `packages/vscode/package.json`, `tsconfig.json`, `.vscodeignore`
- Create: `packages/vscode/src/client.ts`
- Test: `packages/vscode/test/client.test.ts`

**Interfaces:**
- Produces: `class EngineClient` with `connect(): void`, `onState(cb: (s: SessionState[]) => void): void`, `send(msg: ClientMessage): void`, `dispose(): void`, and `readonly connected: boolean`.

- [ ] **Step 1: Write the failing test**

`packages/vscode/test/client.test.ts` — stand up a stub server on a temp socket that speaks the real NDJSON protocol, and assert:

```ts
it('subscribes on connect and surfaces broadcast state', async () => { /* … */ })
it('reconnects with backoff after the engine goes away', async () => { /* … */ })
it('reports disconnected rather than throwing when no engine is listening', async () => { /* … */ })
it('never rejects an unhandled promise when the socket errors', async () => { /* … */ })
```

Use `encode`/`NdjsonDecoder` from `@nudge/shared/protocol` on the stub side — that is the contract under test.

- [ ] **Step 2: Run it, confirm it fails**
- [ ] **Step 3: Implement `EngineClient`** — `net.connect(socketPath())`, send `{t:'subscribe', id}`, decode `{t:'state', sessions}` frames, reconnect on `close`/`error` with exponential backoff capped at 30s. Swallow errors to `console.error('nudge vscode: …')`; never surface a modal.
- [ ] **Step 4: Run it, confirm it passes**
- [ ] **Step 5: Commit**

---

## Task 2: Session-to-window matching

**Files:**
- Create: `packages/vscode/src/match.ts`
- Test: `packages/vscode/test/match.test.ts`

**Interfaces:**
- Produces: `sessionsForWindow(sessions: SessionState[], folders: readonly string[]): SessionState[]`

The hook records each session's `cwd`. An extension instance knows its own workspace folders. A session belongs to this window when its `cwd` is inside one of them.

- [ ] **Step 1: Write the failing test** — cover: exact match; session in a subdirectory of a folder; multi-root workspace; no folders open (an empty workspace shows nothing); a session under a *sibling* directory with a common prefix (`/a/project` must NOT match `/a/project-two`); trailing separators.
- [ ] **Step 2: Run it, confirm it fails**
- [ ] **Step 3: Implement** using `path.relative` and rejecting results that start with `..` — a prefix string compare is the classic bug the sibling-directory case catches.
- [ ] **Step 4: Run it, confirm it passes**
- [ ] **Step 5: Commit**

---

## Task 3: Status bar item

**Files:**
- Create: `packages/vscode/src/status.ts`

**Interfaces:**
- Produces: `class StatusBar` with `render(mine: SessionState[], connected: boolean): void`, `dispose(): void`

Behaviour:
- Nothing waiting → dim, low-key (`$(bell) Nudge`), tooltip "Nothing waiting".
- One or more waiting → **warning background**, `$(bell-dot) Nudge N`, tooltip listing each project, tier and how long it has waited.
- Engine unreachable → `$(bell-slash) Nudge` with a tooltip saying the engine is not running and how to start it. **Not** an error toast.
- Clicking runs the focus command (Task 5).

- [ ] **Step 1: Implement**
- [ ] **Step 2: Verify by hand in the Extension Development Host** — the three states render as described
- [ ] **Step 3: Commit**

---

## Task 4: Toast with actions

**Files:**
- Create: `packages/vscode/src/toast.ts`
- Test: `packages/vscode/test/toast.test.ts`

**Interfaces:**
- Produces: `class Toaster` with `update(mine: SessionState[]): void`, `dispose(): void`

Behaviour:
- A session **entering** a waiting state shows `window.showWarningMessage(<message>, 'Go to it', 'Snooze 10m')`.
- **De-duplicated per session** — the engine broadcasts on every state change, and a toast per broadcast would be unusable. Track which session ids have already been toasted; clear on resolve.
- `Go to it` runs the focus command. `Snooze 10m` sends `{t:'snooze', sessionId, ms: 600000}`.
- Dismissing does nothing — the status bar still shows it.
- Respect a `nudge.showToasts` setting (default `true`) so status-bar-only is available.

- [ ] **Step 1: Write the failing test** — de-duplication is the load-bearing property: assert that ten identical broadcasts produce exactly one toast, and that a resolve-then-block cycle produces a second.
- [ ] **Step 2: Run it, confirm it fails**
- [ ] **Step 3: Implement**
- [ ] **Step 4: Run it, confirm it passes**
- [ ] **Step 5: Commit**

---

## Task 5: Focus — the actual payoff

**Files:**
- Create: `packages/vscode/src/focus.ts`

**Interfaces:**
- Produces: `focusSession(s: SessionState): Promise<void>`

This is the feature the whole phase exists for. Ordered strategy:

1. If the session belongs to **this** window (Task 2) — bring this window forward and reveal the terminal panel where Claude Code is running. `vscode.commands.executeCommand('workbench.action.terminal.focus')` after focusing the window.
2. If it belongs to **another open window** — VS Code cannot focus a sibling window directly from an extension. Use `vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: false })`, which reuses the existing window for that folder.
3. If **no window has it open** — open the folder.
4. Always also mark it: send `{t:'resolve', sessionId}` ONLY if the user explicitly asks to dismiss — **not** on focus. Focusing is not answering; the engine must keep the wait open until Claude Code's own hook clears it.

Point 4 matters: resolving on focus would close the history row early and cancel a still-valid escalation.

- [ ] **Step 1: Implement**
- [ ] **Step 2: Verify by hand** — a waiting session in this window, and one in another folder
- [ ] **Step 3: Commit**

---

## Task 6: Composition root, focus reporting, and packaging

**Files:**
- Create: `packages/vscode/src/extension.ts`
- Modify: `packages/vscode/package.json` (commands, settings, activation)

- [ ] **Step 1: Wire `activate()`** — construct the client, status bar and toaster; on each state broadcast compute `sessionsForWindow` and render both.
- [ ] **Step 2: Report focus to the engine.** Subscribe to `window.onDidChangeWindowState` and send `{t:'frontmost', sessionId}` when this window gains focus and owns a waiting session, `{t:'frontmost', sessionId: null}` when it loses focus. **This is what makes the engine stop alerting you about a window you are already looking at** — the suppression rule exists in the engine but nothing has ever fed it.
- [ ] **Step 3: Register commands** — `nudge.focusSession`, `nudge.snooze`, `nudge.mute`, `nudge.showList`.
- [ ] **Step 4: Contribute settings** — `nudge.showToasts` (boolean, default true), `nudge.socketPath` (string, optional override).
- [ ] **Step 5: `deactivate()` disposes everything** — client socket, status bar, toaster. A leaked socket survives extension reload and accumulates.
- [ ] **Step 6: Package with `vsce package`**, install the `.vsix` locally, and verify end-to-end against the running engine: trigger a real permission prompt, see the status bar go warning-coloured, see the toast, click "Go to it", land in the right window.
- [ ] **Step 7: Commit**

---

## Out of scope for Phase 2

- The history window (Phase 3).
- The Electron tray for non-VS-Code users (Phase 3).
- Answering Claude Code's question from the extension — VS Code has no API to inject into another process's terminal prompt reliably. Focus is the deliverable; answering stays in the editor.
