import { relative, isAbsolute } from 'path'
import type { SessionState } from '@nudge/shared/types'

/**
 * Filters sessions to those whose cwd is inside one of the given workspace folders.
 * A session matches if its cwd is exactly a folder or in a subdirectory of it.
 *
 * The naive startsWith() check is incorrect: it makes /a/project match /a/project-two.
 * Instead, we use path.relative() and check if the result starts with ".." or is
 * absolute (which would indicate the session is outside the folder tree).
 *
 * @param sessions - All session states from the engine
 * @param folders - Workspace folder paths (empty = no folders open)
 * @returns Sessions belonging to this window's folders, preserving input order
 */
export function sessionsForWindow(
  sessions: SessionState[],
  folders: readonly string[]
): SessionState[] {
  if (folders.length === 0) {
    return []
  }

  return sessions.filter(session => {
    const cwd = session.cwd
    return folders.some(folder => isSessionInFolder(cwd, folder))
  })
}

/**
 * Checks if a session's cwd is inside a folder (or is the folder itself).
 *
 * Minor fix #7: this used to manually strip trailing separators from both
 * arguments before comparing, plus a separate exact-match shortcut ahead of
 * the relative()-based check. Both were dead code (surviving mutations
 * proved neither affects any test outcome): node:path's `relative()`
 * already normalizes trailing separators internally, and an exact match
 * already produces `relative(folder, cwd) === ''`, which already falls
 * through to `return true` below on its own — the shortcut just did that
 * same thing one line earlier.
 */
function isSessionInFolder(cwd: string, folder: string): boolean {
  const relPath = relative(folder, cwd)

  // If relPath starts with "..", the cwd is outside the folder (sibling or parent)
  if (relPath.startsWith('..')) {
    return false
  }

  // If relPath is absolute, the cwd is on a different drive (Windows edge case)
  if (isAbsolute(relPath)) {
    return false
  }

  // At this point, relPath is a relative path that doesn't escape upward,
  // so cwd is exactly `folder`, or in a subdirectory of it.
  return true
}
