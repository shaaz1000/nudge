#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeSettingsPath } from '@nudge/shared/paths'
import { applySetup, backupSettings, removeHooks } from './settings.js'
import { serviceUnit } from './service.js'
import { cmdList, cmdMute, cmdSnooze, cmdStart, cmdStatus, cmdTest } from './commands.js'

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
      if (!existsSync(path)) {
        console.log(`No settings file at ${path}; nothing to uninstall.`)
        break
      }

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
      break
    }
    case 'start':  await cmdStart(spawnEngine); break
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
