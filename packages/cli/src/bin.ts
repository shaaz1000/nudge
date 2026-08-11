#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeSettingsPath } from '@nudge/shared/paths'
import { applySetup, backupSettings, removeHooks } from './settings.js'
import { serviceUnit } from './service.js'
import { cmdList, cmdMute, cmdSnooze, cmdStart, cmdStatus, cmdTest, parseSnoozeArgs } from './commands.js'

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

/**
 * Finding I6: `nudge uninstall` removed only the Claude Code hooks, leaving
 * the LaunchAgent/systemd unit/Scheduled Task that `setup`'s installService()
 * registered fully in place — so the engine kept auto-starting on every
 * login regardless of "uninstall". Mirrors installService(): run the
 * platform's own unregister command, then remove the unit file it wrote.
 * Best-effort and non-fatal by design (matching installService()'s own
 * `p.on('error', ...)` — a spawn failure there only logs) — a machine that
 * never had the service registered (no service manager, or setup never
 * ran) must not make `uninstall` fail outright over hooks it successfully
 * removed.
 */
function uninstallService(): void {
  const unit = serviceUnit(process.platform, process.execPath, ENGINE_BIN)
  if (!unit) return
  const p = spawn(unit.uninstallCmd[0], unit.uninstallCmd.slice(1), { stdio: 'inherit' })
  p.on('error', e => console.log(`Could not unregister the service: ${e.message}`))
  p.on('exit', () => {
    if (!unit.path) return
    try {
      if (existsSync(unit.path)) rmSync(unit.path)
    } catch (e) {
      console.log(`Could not remove ${unit.path}: ${(e as Error).message}`)
    }
  })
}

function spawnEngine(): void {
  const p = spawn(process.execPath, [ENGINE_BIN], { detached: true, stdio: 'ignore' })
  // Without this, a missing/unexecutable ENGINE_BIN surfaces as an async,
  // unhandled 'error' event on the child — which Node rethrows as an
  // uncaught exception, crashing the CLI well after "Engine started." has
  // already been printed. Report it the same way installService() does.
  p.on('error', e => console.error(`nudge: could not start the engine: ${e.message}`))
  p.unref()
}

try {
  switch (cmd) {
    case 'setup': {
      const dryRun = rest.includes('--dry-run')
      // Quoted, and using this process's own execPath rather than a bare
      // `node`: a space in the install path (e.g. "Application Support")
      // would otherwise break all seven hook entries, and an unquoted bare
      // `node` can resolve to whatever Node happens to be first on the
      // *shell's* PATH at hook-invocation time — not necessarily one new
      // enough to have `node:sqlite`. installService() below already uses
      // process.execPath for the same reason.
      const r = applySetup({ command: `"${process.execPath}" "${HOOK_BIN}"`, dryRun })
      if (dryRun) { console.log(r.diff); console.log(`\n${r.added} hook(s) would be added.`); break }
      console.log(`Added ${r.added} hook(s) to ${claudeSettingsPath()}`)
      if (r.backup) console.log(`Backup: ${r.backup}`)
      installService()
      console.log('Run `nudge test` once you have set channel.id in your config.')
      break
    }
    case 'uninstall': {
      const path = claudeSettingsPath()
      if (!existsSync(path)) {
        console.log(`No settings file at ${path}; nothing to uninstall.`)
      } else {
        let existing: unknown
        try {
          existing = JSON.parse(readFileSync(path, 'utf8'))
        } catch (err) {
          throw new Error(
            `Refusing to touch ${path}: could not parse it as JSON (${(err as Error).message}). ` +
            `Fix or move the file, then re-run uninstall.`,
          )
        }

        // Validated (removeHooks throws on a non-object top level) before anything
        // is backed up or written — the same care applySetup takes.
        const { merged, removed } = removeHooks(existing)
        const backup = backupSettings(path)
        const serialized = JSON.stringify(merged, null, 2) + '\n'
        JSON.parse(serialized)   // validate before it ever reaches disk
        writeFileSync(path, serialized, 'utf8')
        console.log(`Removed ${removed} Nudge hook(s). Backup: ${backup ?? '(none)'}`)
      }
      // Finding I6: unregister the service unconditionally — setup() installs
      // it independently of whether hooks were present above, so uninstall
      // must reverse it independently too.
      uninstallService()
      break
    }
    case 'start':  await cmdStart(spawnEngine); break
    case 'status': await cmdStatus(); break
    case 'list':   await cmdList(); break
    case 'test':   await cmdTest(rest[0]); break
    case 'snooze': {
      const { sessionId, ms } = parseSnoozeArgs(rest[0], rest[1])
      await cmdSnooze(sessionId, ms)
      break
    }
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
