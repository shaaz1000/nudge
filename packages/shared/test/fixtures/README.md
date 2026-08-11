# Captured hook fixtures

Real Claude Code hook payloads, captured with `tools/capture-hooks.mjs`,
then scrubbed of absolute paths, session ids, and anything resembling a
credential.

Regenerate when Claude Code changes its hook payload shape. The normalizer
tests in `packages/engine/test/normalize.test.ts` read these directly, so a
payload change surfaces as a test failure rather than a silent runtime bug.

## Confirmed field names

The capture verified that every field name assumed by the plan is real,
present, and spelled exactly as assumed:

- Every hook: `hook_event_name`, `session_id`, `cwd`.
- `PreToolUse` / `PostToolUse`: `tool_name`.
- `Notification`: `message`.

## Known future refinement (not used in Phase 1)

`Notification` also carries a `notification_type` field (observed value:
`"permission_prompt"`), which distinguishes a permission-prompt notification
from an idle-timeout notification. This could later let the "blocked" tier
be split into more precise sub-cases. Phase 1's event model is fixed by the
plan and deliberately does not use this field — do not add it to `NudgeEvent`
or any other type. Noted here only as provenance for a future phase.
