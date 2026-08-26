# olite brain

The olite agent: a Python package that runs **inside Pyodide** in the browser. It
is the client-only replacement for the Loom/Orbit server-side runtime, organized
in three layers. See `../LAYOUT.md` for the full map.

- `runtime.py` — `run(config, inputs)`: builds the substrate, runs a driver.
- `substrate/` — LAYER 1, the shared kernel: `CapabilityManifest` (the gate),
  `LocalPython` (Pyodide compute), `Catalog` (scoped, capability-gated Galaxy
  API), `Llm` (chat proxy). Adopted from the polaris prototype's `core/` + `api/` and
  owned here.
- `drivers/` — LAYER 2, how it decides: `loop/` (open-ended, Orbit parity, the
  default) and a deferred `graph/` (polaris runner for crystallized `agent.yml`
  processes). See `drivers/README.md`.
- `registry/` — LAYER 3, skills (markdown) + processes (`agent.yml`); deferred.

Built into `olite-0.0.0-py3-none-any.whl` by the package's `build:olite` script
and loaded into Pyodide via `micropip`.
