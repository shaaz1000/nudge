// electron-builder afterPack hook: ad-hoc sign the macOS bundle.
//
// Without this the app will not launch from Finder OR post notifications, and
// both failures are silent.
//
// `mac.identity: null` tells electron-builder to skip signing, which leaves
// Electron's ORIGINAL ad-hoc "linker-signed" signature in place. That
// signature was made for Electron's own bundle, so after electron-builder
// rewrites Info.plist and swaps in our app it no longer matches:
//
//   Identifier=Electron          <- not com.nudge.tray
//   Info.plist=not bound
//   spctl: "code has no resources but signature indicates they must be present"
//
// Consequences, both observed on a real machine:
//   - `open -a Nudge` exits 0 and starts nothing. Running the binary directly
//     works, which makes it look like the app is fine.
//   - Notification Center silently drops every notification the app posts.
//     The user hears the engine's sound and sees the Dock bounce, but no
//     banner ever appears — the one signal that says WHAT is being asked.
//
// Re-signing ad-hoc (`--sign -`) costs nothing, needs no Apple Developer
// account, and produces a bundle with the right identifier that Gatekeeper
// accepts locally. It does NOT make the app distributable — users still have
// to clear the quarantine flag; see the README.
import { execFileSync } from 'node:child_process'

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' })
    // Verify rather than assume: a signature that does not verify fails in
    // exactly the silent ways described above, and a broken one looks
    // identical to a working one until someone tries to launch it.
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' })
    const info = execFileSync('codesign', ['-dv', app], { stdio: ['pipe', 'pipe', 'pipe'] })
    void info
    console.log(`  • ad-hoc signed and verified  ${app}`)
  } catch (err) {
    // Fail the BUILD. Shipping a bundle that cannot launch or notify, with no
    // error anywhere, is worse than not producing one.
    throw new Error(
      `ad-hoc signing failed for ${app}: ${err.stderr?.toString() || err.message}\n`
      + 'The app would launch only by running its binary directly, and would '
      + 'never post a notification.',
    )
  }
}
