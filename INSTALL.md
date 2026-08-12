# Installing Nudge

A complete, from-scratch guide. Written for someone who has never seen this
repo, on a machine with nothing set up.

Nudge tells you when Claude Code is waiting on you — a permission prompt, a
question, or a finished turn — on your desktop, and on your phone if you don't
come back.

- [1. Prerequisites](#1-prerequisites)
- [2. Build](#2-build)
- [3. Install the hooks and the engine](#3-install-the-hooks-and-the-engine)
- [4. Check it works](#4-check-it-works)
- [5. Phone notifications with ntfy](#5-phone-notifications-with-ntfy)
- [6. The desktop app (optional)](#6-the-desktop-app-optional)
- [7. The VS Code extension (optional)](#7-the-vs-code-extension-optional)
- [8. What got installed, and where](#8-what-got-installed-and-where)
- [9. Configuration](#9-configuration)
- [10. Troubleshooting](#10-troubleshooting)
- [11. Uninstalling](#11-uninstalling)

---

## 1. Prerequisites

**Node 22.5 or newer.** Not negotiable, and the reason is worth knowing: the
engine's event log uses Node's built-in `node:sqlite`, which first shipped in
22.5. On older Node the engine dies at startup with
`ERR_UNKNOWN_BUILTIN_MODULE`.

```bash
node --version    # must be >= v22.5.0
```

If it isn't, install a newer one ([nvm](https://github.com/nvm-sh/nvm) is the
easiest route: `nvm install 24 && nvm use 24`).

**Claude Code**, obviously — the CLI, the desktop app, or the VS Code
extension. Any of them.

**macOS, Linux or Windows.** Everything core works on all three. Two extras are
macOS-only today: the Dock bounce and the LaunchAgent installer.

---

## 2. Build

```bash
git clone https://github.com/shaaz1000/nudge.git
cd nudge
npm install
npx tsc --build
```

`npx tsc --build` is required, not optional. The packages resolve each other
through their compiled `dist/` output, and `dist/` is not committed — skip this
and later steps fail with confusing module-resolution errors.

There is no published npm package, so the CLI runs from its build output:

```bash
node packages/cli/dist/bin.js status
```

That's a mouthful, so give yourself an alias. The rest of this guide writes
`nudge` and means exactly that command:

```bash
# add to ~/.zshrc or ~/.bashrc, adjusting the path to where you cloned it
alias nudge="node $HOME/path/to/nudge/packages/cli/dist/bin.js"
```

---

## 3. Install the hooks and the engine

**Look before you leap.** This step edits your Claude Code settings, so
inspect the change first:

```bash
nudge setup --dry-run
```

That prints the exact diff and writes nothing. When you're happy:

```bash
nudge setup
```

Two things happen:

**Hook entries are added to your Claude Code settings**
(`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`). Seven of
them: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Notification`, `Stop`, `SessionEnd`.

The merge is append-only and idempotent. It takes a timestamped backup
(`settings.json.nudge-backup-<timestamp>`) before writing, and it only ever
touches entries carrying its own `_nudge` ownership marker — never anything you
wrote yourself. Ownership is tracked by that marker rather than by matching
text in hook commands, deliberately: a value you control must never be what
decides whether Nudge may overwrite or delete an entry.

**The engine is registered to start at login**, using whatever your platform
provides:

| Platform | Mechanism | Where |
|---|---|---|
| macOS | LaunchAgent | `~/Library/LaunchAgents/com.nudge.engine.plist` |
| Linux | systemd user unit | `~/.config/systemd/user/nudge-engine.service` |
| Windows | Scheduled Task | Task name `NudgeEngine` |

If your platform has none of those, `setup` says so and you run `nudge start`
yourself after each reboot.

---

## 4. Check it works

```bash
nudge status
```

You want the engine reported as running. Then, in Claude Code, do something
that needs your approval — ask it to run a shell command, say. You should get a
desktop notification and a sound within a second or two.

```bash
nudge list      # what is waiting on you right now
```

If nothing happens, jump to [Troubleshooting](#10-troubleshooting).

---

## 5. Phone notifications with ntfy

Desktop alerts only help if you're at the desk. If a session stays blocked
past `escalation.activeDelayMs` (3 minutes by default), Nudge escalates to your
phone.

[ntfy](https://ntfy.sh) is the built-in channel: free, no account, and there's
an app for [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) and
[Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy).

### Your topic name is your password. Treat it that way.

This is the part to get right, and it is easy to get wrong.

On the public `ntfy.sh` server there are **no accounts and no access control**.
A topic is just a URL. **Anyone who knows or guesses your topic name can read
every notification you receive, and can send you fake ones.** A topic called
`nudge`, `claude`, or `shaaz-nudge` is not private — it is a shared channel you
happen to be using alone, until you aren't.

So generate something unguessable. Not a name — a secret:

```bash
# macOS / Linux
echo "nudge-$(openssl rand -hex 16)"
# -> nudge-8f3c1a9e42b7d60518ca7f2e9b4d3a61
```

```powershell
# Windows PowerShell
"nudge-" + -join ((1..32) | ForEach-Object { '{0:x}' -f (Get-Random -Max 16) })
```

Copy the result. That single string is the whole of your security on the public
server, so don't paste it into a screenshot, an issue, or a chat log.

### Configure it

Edit `~/.nudge/config.json` (create it if it doesn't exist):

```json
{
  "channel": {
    "id": "ntfy",
    "options": {
      "topic": "nudge-8f3c1a9e42b7d60518ca7f2e9b4d3a61"
    }
  }
}
```

Then subscribe on your phone: open the ntfy app → **+** → paste the exact same
topic string.

Test it end to end:

```bash
nudge test
```

Your phone should buzz. If it doesn't, check the topic string matches on both
sides *exactly* — a typo means you are subscribed to a different topic that
simply has no messages, which looks identical to a broken setup.

### Options

| Key | Required | Meaning |
|---|---|---|
| `topic` | yes | The topic string. Make it long and random — see above. |
| `serverUrl` | no | Defaults to `https://ntfy.sh`. Point at your own server for LAN-only delivery. |
| `token` | no | Bearer token, for a server with authentication enabled. |

### If a random topic isn't good enough

It is still a shared public server, and your notifications still leave your
machine. Two ways to do better:

**Keep the payload boring.** The default `detailLevel` is `"minimal"`, so a
push carries only the project name and the tier — never the actual question or
command. Setting `"detailLevel": "full"` puts the real text in the
notification. Only do that against a server you control.

**Run your own ntfy.** It's a single binary or container, and then
`serverUrl` points at it and none of this leaves your network:

```json
{
  "channel": {
    "id": "ntfy",
    "options": {
      "serverUrl": "https://ntfy.example.com",
      "topic": "nudge-8f3c1a9e42b7d60518ca7f2e9b4d3a61",
      "token": "tk_..."
    }
  }
}
```

---

## 6. The desktop app (optional)

A menu-bar / system-tray app. **You don't need it if you live in VS Code** —
the extension covers that case. It earns its place when you *leave* the editor:

- An always-visible menu-bar icon, badged with how many sessions are waiting.
- **A clickable notification** — clicking it brings the right window forward.
- **On macOS, the Dock icon appears and bounces until you deal with it.** A
  notification banner vanishes after a few seconds; this doesn't.

```bash
npm run pack -w nudge-tray          # builds packages/tray/release/
cp -R packages/tray/release/mac-arm64/Nudge.app /Applications/
```

Start it at login:

```bash
node packages/tray/scripts/install-launchagent.mjs
```

Use that rather than the app's own **Start at login** menu item on macOS. That
item registers through LaunchServices, which refuses to launch an ad-hoc-signed
bundle — `open -a Nudge` exits 0 and starts nothing. launchd doesn't care, so
the agent works where the menu item may not.

**On unsigned builds and Gatekeeper.** The build ad-hoc signs itself, which is
what lets it launch and post notifications at all. It is *not* Developer-ID
signed — that needs a paid Apple Developer account — so a `.dmg` copied to
another Mac is quarantined and reported as "damaged". Clear it there with:

```bash
xattr -dr com.apple.quarantine /Applications/Nudge.app
```

(Right-click → **Open** is the advice you'll find elsewhere; macOS 15 removed
it as a bypass for unsigned apps. The System Settings → Privacy & Security →
**Open Anyway** route still works.)

---

## 7. The VS Code extension (optional)

Adds a status bar item for *this window's* sessions, a toast when one starts
waiting, and click-to-jump.

```bash
npm run bundle -w nudge-vscode
npm run package -w nudge-vscode     # produces packages/vscode/*.vsix
```

Then in VS Code: Command Palette → **Extensions: Install from VSIX…**

It also does something nothing else can: it tells the engine **which window
you are looking at**, so you don't get nudged about the window you're already
in. Without it, that suppression never kicks in.

**Both the extension and the tray can run together** — that's supported, not a
conflict. The tray announces itself as a GUI client, so the engine stands down
its own non-clickable banner and lets the tray raise a clickable one, while
still playing the sound.

---

## 8. What got installed, and where

Nothing is hidden. Everything Nudge writes:

| Path | What | Written by |
|---|---|---|
| `~/.claude/settings.json` | 7 hook entries, marked `_nudge` | `nudge setup` |
| `~/.claude/settings.json.nudge-backup-*` | Timestamped backup | `nudge setup` |
| `~/.nudge/config.json` | Your config | you (and `nudge mute`) |
| `~/.nudge/nudge.db` (+ `-wal`, `-shm`) | Event log / history (SQLite) | engine |
| `~/.nudge/engine.sock` | Control socket, `0600` | engine |
| `~/.nudge/engine.lock` | Single-instance lock | engine |
| `~/Library/LaunchAgents/com.nudge.engine.plist` | Engine autostart (macOS) | `nudge setup` |
| `~/Library/LaunchAgents/com.nudge.tray.plist` | Tray autostart (macOS) | `install-launchagent.mjs` |
| `/Applications/Nudge.app` | The tray app | you |

### How a nudge actually reaches you

```
Claude Code fires a hook
   -> nudge-hook  (exits in <500ms, always exit 0, never writes stdout)
       -> engine over the Unix socket
           -> desktop notification + sound, immediately
           -> still waiting after the delay? -> phone via ntfy
```

The hook is deliberately dumb and fast: it forwards a normalized event and
exits. If the engine isn't reachable it spools the event to disk and the engine
replays it on next boot, so nothing is lost. A notifier that can stall your
coding session is worse than no notifier.

One wrinkle worth knowing: when Claude asks a **multiple-choice question**, that
does *not* fire Claude Code's `Notification` hook
([#59908](https://github.com/anthropics/claude-code/issues/59908)). Nudge
catches it via `PreToolUse` instead. That's why the hook list is seven entries
and not one.

---

## 9. Configuration

Everything lives in `~/.nudge/config.json` and every field is optional. An
unknown key or a wrong-shaped value fails loudly at load time rather than being
silently ignored.

```jsonc
{
  // "minimal" (default): phone pushes carry project + tier only.
  // "full": pushes carry the actual question or command text.
  "detailLevel": "minimal",

  "muted": false,

  "escalation": {
    "activeDelayMs": 180000,   // wait this long before the phone push
    "idleDelayMs": 45000,      // ...or this long, if you're idle
    "localRepeat": 3,          // repeat the desktop alert this many times
    "phoneRepeat": 0
  },

  // Suppress PHONE pushes in this window. Never suppresses desktop alerts.
  "quietHours": { "start": "23:00", "end": "07:00" },

  // Tiers: blocked, idle-long, idle-short, stalled.
  "tiers": {
    "blocked":    { "enabled": true, "sound": "blocked", "escalates": true },
    "idle-short": { "enabled": true, "sound": null,      "escalates": false }
  },

  // Tray-only. The engine ignores this key.
  "tray": {
    "bounceOnBlocked": true,
    "bounceTiers": ["blocked", "idle-long"]
  },

  "projects": {
    "/path/to/a/repo": { "muted": true }
  }
}
```

Comments above are illustrative — the file is parsed with `JSON.parse`, which
rejects them.

Handy commands:

```bash
nudge status              # config, channel, engine health
nudge list                # what's waiting
nudge snooze <id> [min]   # shut one session up for a while
nudge mute                # silence everything
nudge mute off            # unsilence
nudge test [channel]      # send a test push
```

---

## 10. Troubleshooting

**Nothing happens at all.**
`nudge status` first. If the engine isn't running, `nudge start`. If it won't
stay up, check your Node version ([§1](#1-prerequisites)) — a too-old Node
fails with `ERR_UNKNOWN_BUILTIN_MODULE` on `node:sqlite`.

**Hooks aren't firing.** Confirm they're actually in your settings:

```bash
grep -c _nudge ~/.claude/settings.json     # expect 7
```

If that's 0, re-run `nudge setup`. Restart Claude Code afterwards — it reads
settings at startup.

**The phone never buzzes.**
`nudge test` isolates it: if that works, the channel is fine and the escalation
delay simply hasn't elapsed (3 minutes by default). If it doesn't, compare the
topic string in `config.json` against the one in the app character by
character. Also check `quietHours` isn't covering the current time, since it
suppresses phone pushes only — which looks exactly like a broken channel.

**Sound and Dock bounce, but no notification banner** (macOS, tray app).
The bundle's signature is broken. Check it:

```bash
codesign -dv /Applications/Nudge.app 2>&1 | grep Identifier
```

If that says `Identifier=Electron` rather than `com.nudge.tray`, macOS is
silently dropping its notifications. Re-sign:

```bash
codesign --force --deep --sign - /Applications/Nudge.app
```

**Clicking a notification opens the wrong app.** The surface is detected once,
at `SessionStart`, so an existing session keeps whatever was recorded when it
began. Start a new session.

**The tray isn't running.**

```bash
launchctl print gui/$(id -u)/com.nudge.tray | grep state
cat /tmp/nudge-tray.err.log
```

---

## 11. Uninstalling

```bash
nudge uninstall
```

Removes only the hook entries carrying Nudge's ownership marker — everything
else in your settings file is left byte-for-byte untouched — and unregisters
the engine service. It backs the file up first.

The tray and its autostart go separately:

```bash
node packages/tray/scripts/install-launchagent.mjs --uninstall
rm -rf /Applications/Nudge.app
```

Your data and config are yours to delete:

```bash
rm -rf ~/.nudge          # config, history database, socket
```
