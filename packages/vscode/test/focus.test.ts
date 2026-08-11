import { describe, it, expect, vi } from 'vitest'

// Same reason as toast.test.ts/status.test.ts: `vscode` has no runtime module
// outside an editor host. Nothing below reads this mock's contents — every
// test injects its own fake FocusSurface — it only has to exist so importing
// '../src/focus.js' does not throw.
vi.mock('vscode', () => ({
  commands: { executeCommand: vi.fn() },
  Uri: { file: vi.fn() },
}))

import type { SessionState } from '@nudge/shared/types'
import { focusSession, type FocusSurface } from '../src/focus.js'

const session = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: 's1', project: 'my-repo', cwd: '/a/my-repo',
  surface: { kind: 'vscode' }, status: 'blocked', tier: 'blocked',
  waitingSince: 1, turnStartedAt: null, lastEventAt: 1,
  message: 'Allow?', snoozedUntil: null, pushFailed: false, ...over,
})

function makeSurface(folders: readonly string[] = []) {
  const executeCommand = vi.fn().mockResolvedValue(undefined)
  const fileUri = vi.fn((path: string) => ({ __uri: path }))
  const surface: FocusSurface = {
    workspaceFolderPaths: () => folders,
    fileUri,
    executeCommand,
  }
  return { surface, executeCommand, fileUri }
}

describe('focusSession', () => {
  // Branch 1: the session's cwd is inside one of THIS window's own folders.
  it('this window: reveals the terminal panel, and does not open any folder', async () => {
    const { surface, executeCommand, fileUri } = makeSurface(['/a/my-repo'])

    await focusSession(session({ cwd: '/a/my-repo' }), surface)

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.terminal.focus')
    expect(executeCommand).not.toHaveBeenCalledWith('vscode.openFolder', expect.anything(), expect.anything())
    expect(fileUri).not.toHaveBeenCalled()
  })

  it('this window: matches a session in a subdirectory of an open folder, not just an exact path', async () => {
    const { surface, executeCommand } = makeSurface(['/a/my-repo'])

    await focusSession(session({ cwd: '/a/my-repo/src/deep' }), surface)

    expect(executeCommand).toHaveBeenCalledWith('workbench.action.terminal.focus')
    expect(executeCommand).not.toHaveBeenCalledWith('vscode.openFolder', expect.anything(), expect.anything())
  })

  // Branches 2/3: VS Code cannot tell an extension whether the target folder
  // is already open in a sibling window or not open anywhere at all — that
  // disambiguation happens inside vscode.openFolder itself. Both scenarios
  // are therefore exercised the same way from here, but with DIFFERENT
  // sessions/folders each time, to prove the URI passed is genuinely derived
  // from the session under focus rather than a hardcoded fallback that would
  // happen to work for only one of them.
  it('not this window (folder open elsewhere): opens/reuses the folder for that session, not the terminal', async () => {
    const { surface, executeCommand, fileUri } = makeSurface(['/a/my-repo'])

    await focusSession(session({ sessionId: 's2', cwd: '/b/other-repo' }), surface)

    expect(fileUri).toHaveBeenCalledWith('/b/other-repo')
    expect(executeCommand).toHaveBeenCalledWith('vscode.openFolder', { __uri: '/b/other-repo' }, { forceNewWindow: false })
    expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.terminal.focus')
  })

  it('not this window (no window has it open): opens the folder for THAT DIFFERENT session, proving the URI is not hardcoded', async () => {
    const { surface, executeCommand, fileUri } = makeSurface(['/a/my-repo'])

    await focusSession(session({ sessionId: 's3', cwd: '/c/third-repo' }), surface)

    expect(fileUri).toHaveBeenCalledWith('/c/third-repo')
    expect(executeCommand).toHaveBeenCalledWith('vscode.openFolder', { __uri: '/c/third-repo' }, { forceNewWindow: false })
    expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.terminal.focus')
  })

  it('no folders open in this window at all: still opens the folder rather than trying to focus a nonexistent terminal', async () => {
    const { surface, executeCommand, fileUri } = makeSurface([])

    await focusSession(session({ cwd: '/a/my-repo' }), surface)

    expect(fileUri).toHaveBeenCalledWith('/a/my-repo')
    expect(executeCommand).toHaveBeenCalledWith('vscode.openFolder', { __uri: '/a/my-repo' }, { forceNewWindow: false })
  })

  it('a sibling directory with a common prefix does not falsely match "this window" (the sessionsForWindow prefix bug)', async () => {
    const { surface, executeCommand } = makeSurface(['/a/project'])

    await focusSession(session({ cwd: '/a/project-two' }), surface)

    expect(executeCommand).toHaveBeenCalledWith('vscode.openFolder', expect.anything(), { forceNewWindow: false })
    expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.terminal.focus')
  })

  // The load-bearing rule (point 4 of the brief): focusing is not answering.
  // Resolving here would close the history row early and cancel a still-valid
  // escalation. FocusSurface has no send/resolve capability at all — this
  // test asserts the *only* two things focusSession is ever allowed to do
  // (open a folder or focus the terminal) and nothing else, on every branch.
  it('never calls any command other than terminal-focus or openFolder, on any branch', async () => {
    const scenarios = [
      makeSurface(['/a/my-repo']),
      makeSurface(['/a/my-repo']),
    ]
    await focusSession(session({ cwd: '/a/my-repo' }), scenarios[0].surface)
    await focusSession(session({ sessionId: 's2', cwd: '/elsewhere' }), scenarios[1].surface)

    for (const { executeCommand } of scenarios) {
      for (const call of executeCommand.mock.calls) {
        expect(['workbench.action.terminal.focus', 'vscode.openFolder']).toContain(call[0])
      }
    }
  })
})
