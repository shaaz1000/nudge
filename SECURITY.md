# Security

## Reporting a vulnerability

Please **don't open a public issue**. Report privately through
[GitHub Security Advisories](https://github.com/shaaz1000/nudge/security/advisories/new),
or email **Shaazkhan153@gmail.com**.

This is a side project maintained by one person, so I can't promise a response
time — but I will acknowledge your report and credit you unless you'd rather I
didn't.

## What Nudge touches on your machine

Worth knowing what you're installing:

| | |
|---|---|
| `~/.claude/settings.json` | Adds 7 hook entries. Append-only, backed up first, and only ever touches entries carrying its own `_nudge` marker. |
| `~/.nudge/` | Config, a SQLite event log, and a **`0600`** control socket. |
| Login item | A LaunchAgent (macOS), systemd user unit (Linux) or Scheduled Task (Windows) to run the engine. |
| Network | **Nothing, unless you configure a phone channel.** No telemetry, no analytics, no update checks. |

The control socket is `0600` and local-only. Anything that can talk to it can
read your session list and mute your alerts, so it is deliberately not exposed
over the network.

## Your ntfy topic is a credential

The one genuinely sharp edge.

On the public `ntfy.sh` server there are **no accounts and no access control**.
A topic is just a URL, so **anyone who knows or guesses your topic can read
every notification you receive and send you fake ones.**

- Generate it randomly — `openssl rand -hex 16` — never a name.
- Don't paste it into screenshots, issues, or pull requests.
- Keep `detailLevel` at its default `"minimal"`, which sends only a project
  name and a status. Setting `"full"` puts the actual question or command text
  into a push that crosses a public server.
- If any of that matters to you, self-host ntfy and set `serverUrl`.

## Hook command injection

Nudge builds AppleScript and PowerShell to focus your editor, interpolating
values that come from your environment — directory names, window titles,
process names. Those are escaped per target language, and the escapers are
separate functions with their own tests, because reusing an AppleScript escaper
in a PowerShell string was a real bug here once.

If you find a value that reaches a shell or script interpreter unescaped, that
is a security bug and I'd like to hear about it privately.
