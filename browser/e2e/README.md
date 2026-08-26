# End-to-end checks

Drives the real page — real worker, real brain, real modal — with the provider and
Galaxy replaced by one stub. Deterministic, and it costs no provider quota, so it can
run as often as you like.

It exists because the pieces it covers cannot be unit-tested. The destructive-op gate
and Stop both hinge on a **round trip across the worker boundary**: the brain parks a
turn on a promise, a message from the main thread resolves it, and a message arriving
*during* a run is delivered only because the worker's event loop is free between the
awaits inside the Python coroutine. The Python tests cover the decisions; this covers
the wiring, and it caught two defects the unit tests could not see — a refused
destructive call rendering as a green successful card, and a stopped turn also
printing "the model ended the turn without a reply. Ask again, or rephrase."

```bash
node e2e/stub.cjs &                      # provider + Galaxy, on :8099
GALAXY_ROOT=http://127.0.0.1:8099 LLM_ROOT=http://127.0.0.1:8099 \
  LLM_PATH=/v1 LLM_KEY=stub LLM_MODEL=stub-model \
  LLM_CONTEXT_WINDOW=40000 LLM_KEEP_RECENT_TOKENS=500 npm run dev &
LLM_CONTEXT_WINDOW=40000 node e2e/confirm-drive.cjs   # non-zero if a check fails
```

The two `LLM_*` compaction settings shrink the context window so compaction actually
happens within a few turns instead of after hours of real conversation; the driver
skips those checks unless `LLM_CONTEXT_WINDOW` is set, so the run still works
without them. They have to be coherent — a window smaller than olite's ~20k system
prompt plus the reserve cannot be compacted into, and the brain reports that rather
than trying. That failure mode is itself worth exercising: it is what a 32k local
model does.

Screenshots land next to the driver's `OUT` path. Look at them — a check can pass on
a page that renders nothing.

`ratelimit-drive.cjs` covers the provider-rate-limit path: the stub 429s once with a
stated `retryDelay`, and the run asserts the wait is announced, counted down, recovered
from, and never shown as a traceback.

```bash
curl "http://127.0.0.1:8099/__script?name=ratelimit" && node e2e/ratelimit-drive.cjs
node e2e/catalog-refusal-drive.cjs                    # approve is refused with no catalog
```

`stub.cjs` scripts itself through `/__script?name=…` (`confirm`, `slow`, `compact`,
`ratelimit`) and reports
every Galaxy request it received at `/__seen`, which is what makes "declining sends
nothing to Galaxy" an assertion about the network rather than about the UI.
