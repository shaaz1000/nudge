// The actual Electron entry point (see package.json's "main" field). Kept to
// this one call so importing it is never something a test does — a test
// importing this file would run `main()` against the REAL `electron`
// module as an unguarded side effect of the import itself. main.ts's own
// exports (main, AppSurface, EngineClientLike, TrayLike) are what test/
// main.test.ts imports and exercises instead, exactly the way
// packages/cli/src/bin.ts is the untested entry shim around the tested
// commands.ts.
import { main } from './main.js'

main()
