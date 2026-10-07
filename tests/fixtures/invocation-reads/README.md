# What checkInvocations produced before it read through galaxy-ops

`hand-rolled-check-results.json` was captured on 2026-10-04 by running `checkInvocations`
from main at 6bca89ec -- its own `galaxyGet(".../invocations/{id}?step_details=true")`,
before the move to galaxy-ops -- against the fake Galaxy in
`tests/invocation-read-e2e.test.ts`, one scenario at a time. Each row is the scenario
(Galaxy's invocation state and each step's jobs), the notebook block afterwards, and the
tool's result entry minus `lastPolledAt`.

The e2e suite replays every scenario through the current code and requires the same block
and the same result, field for field. Don't regenerate this from the current code: the
point is that it came from the code being replaced.
