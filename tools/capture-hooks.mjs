#!/usr/bin/env node
// Appends every hook payload Claude Code sends to a JSONL file, then exits 0.
// Wire this in temporarily via a settings.json hook entry, run a real session,
// then convert the JSONL into per-hook fixture files.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const OUT = process.env.NUDGE_CAPTURE_OUT ?? '/tmp/nudge-hook-capture.jsonl'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  try {
    mkdirSync(dirname(OUT), { recursive: true })
    appendFileSync(OUT, raw.trim() + '\n')
  } catch {
    // Capture must never break the session being observed.
  }
  process.exit(0)
})
setTimeout(() => process.exit(0), 500).unref()
