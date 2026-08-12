// EngineClient moved to @nudge/client (Phase 3, Task 1) so the Electron tray
// can share the exact same connect/subscribe/reconnect-with-backoff
// implementation instead of copying it — copying would guarantee drift, the
// way TIER_TEXT already did between the engine and this extension. This file
// stays as a thin re-export so nothing else in this package (or a future
// contributor grepping for './client.js') needs to know it moved.
export { EngineClient, type EngineClientOptions } from '@nudge/client'
