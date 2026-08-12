#!/usr/bin/env node
// Installs a macOS LaunchAgent so the tray starts at login and comes back if
// it dies.
//
// Why not the app's own "Start at login" menu item: that calls
// `app.setLoginItemSettings`, which registers through LaunchServices — and
// LaunchServices refuses to launch this bundle (`open -a Nudge` exits 0 and
// starts nothing) because it is only ad-hoc signed. launchd does not care,
// so this works where the menu item may not.
//
// Usage:  node packages/tray/scripts/install-launchagent.mjs [--uninstall]
import { execFileSync } from 'node:child_process'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LABEL = 'com.nudge.tray'
const APP = '/Applications/Nudge.app/Contents/MacOS/Nudge'
const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const domain = `gui/${process.getuid?.() ?? ''}`

if (process.platform !== 'darwin') {
  console.error('This installs a macOS LaunchAgent; on Linux use a systemd user unit.')
  process.exit(1)
}

const quiet = args => { try { execFileSync(args[0], args.slice(1), { stdio: 'pipe' }) } catch { /* expected when not loaded */ } }

if (process.argv.includes('--uninstall')) {
  quiet(['launchctl', 'bootout', `${domain}/${LABEL}`])
  if (existsSync(plistPath)) unlinkSync(plistPath)
  console.log(`Removed ${LABEL}.`)
  process.exit(0)
}

if (!existsSync(APP)) {
  console.error(`No app at ${APP}.`)
  console.error('Build it (npm run pack -w nudge-tray) and copy the .app into /Applications first.')
  process.exit(1)
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${APP}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Interactive, NOT Background: this draws a menu-bar icon, a Dock icon
       and notifications, so it needs a real GUI session. Background tells
       launchd to deprioritise it and can starve that work. -->
  <key>ProcessType</key><string>Interactive</string>
  <!-- The environment may carry ELECTRON_RUN_AS_NODE=1. Inheriting it makes
       Electron boot as plain Node: no tray, no notifications, no error
       either — the process just sits there having done nothing. -->
  <key>EnvironmentVariables</key>
  <dict><key>ELECTRON_RUN_AS_NODE</key><string></string></dict>
  <key>StandardErrorPath</key><string>/tmp/nudge-tray.err.log</string>
</dict>
</plist>
`

const isLoaded = () => {
  try {
    execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
writeFileSync(plistPath, plist, 'utf8')

// `bootout` returns before launchd has finished tearing the job down, and
// bootstrapping a label that is still loaded fails with the distinctly
// unhelpful "Bootstrap failed: 5: Input/output error". Wait for it to
// actually be gone — re-running the installer is the common case, so this
// path matters more than the first install.
quiet(['launchctl', 'bootout', `${domain}/${LABEL}`])
for (let i = 0; i < 40 && isLoaded(); i++) {
  await new Promise(r => setTimeout(r, 250))
}
if (isLoaded()) {
  console.error(`${LABEL} is still loaded after bootout; not bootstrapping over it.`)
  console.error(`Try: launchctl bootout ${domain}/${LABEL}`)
  process.exit(1)
}

execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' })

// Verify rather than assume it loaded: `bootstrap` succeeding does not mean
// the process is alive, and a tray that is not running is indistinguishable
// from one with nothing to report.
await new Promise(r => setTimeout(r, 3000))
let running = false
try {
  const out = execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { stdio: 'pipe' }).toString()
  running = /state = running/.test(out)
} catch { /* falls through to the failure message */ }

if (!running) {
  console.error(`Installed ${plistPath}, but the agent is not running.`)
  console.error('Check /tmp/nudge-tray.err.log.')
  process.exit(1)
}
console.log(`${LABEL} installed and running. It will start at login.`)
console.log(`Remove it with: node packages/tray/scripts/install-launchagent.mjs --uninstall`)
