# olite

**olite** is a browser-native AI research assistant for Galaxy, delivered as a Charts
visualization plugin. The agent loop runs entirely in the browser: it reaches the LLM through
Galaxy's chat proxy, runs local Python in Pyodide, and orchestrates real Galaxy jobs through
the Galaxy API. There is no per-user server container.

Its agent behavior and interaction model are closely aligned with
[Orbit](https://github.com/galaxyproject/loom), the original Galaxy AI co-scientist and the
reference implementation used for olite's parity evaluation — see [Credit](#credit).

## Architecture

The agent brain is a Python package (`brain/olite/`) that runs **inside Pyodide**, layered
substrate / drivers / registry. Full map: **[`LAYOUT.md`](./LAYOUT.md)**.

| Layer | Role | Where |
|---|---|---|
| **substrate** | what it can touch: capability manifest, `run_python` (Pyodide), scoped Galaxy catalog, LLM chat proxy | `brain/olite/substrate/` |
| **drivers** | how it decides: `loop/` (open-ended, Orbit parity, default); `graph/` (polaris runner, deferred) | `brain/olite/drivers/` |
| **registry** | what it knows: skills (markdown) + processes (`agent.yml`); deferred | `brain/olite/registry/` |
| Charts shell | boots the Pyodide worker, renders the transcript, owns Stop and the confirm modal | `src/main.ts`, `src/pyodide/` |

- **LLM**: in production the loop POSTs to `{root}api/plugins/olite/chat/completions`
  (Galaxy's chat proxy: Galaxy-managed key, OpenAI-compatible). In dev, `<ai_api_base_url>`
  is `/llm`, which vite proxies to whatever `LLM_ROOT` points at.
- **Local compute**: `run_python` executes in the same Pyodide interpreter the brain runs
  in (numpy/pandas available, state persists across calls).
- **Remote compute + storage**: the scoped, capability-gated catalog hits the Galaxy API
  with the user's session. Reads are available now; writes are gated and enabled targeted.
- **Substrate origin**: `substrate/` originated in the `polaris` prototype (`core/` +
  `api/`), which olite absorbed and now owns. The capability gate is factored into
  `Catalog` + `CapabilityManifest`.

## Running it locally

Three ways, cheapest first. All of them need `npm install` once.

### 1. No Galaxy, no LLM, no quota — the end-to-end checks

Deterministic, free, and the fastest way to see the whole thing work. One stub answers as
both the provider and Galaxy.

```bash
node e2e/stub.cjs &
GALAXY_ROOT=http://127.0.0.1:8099 LLM_ROOT=http://127.0.0.1:8099 \
  LLM_PATH=/v1 LLM_KEY=stub LLM_MODEL=stub-model \
  LLM_CONTEXT_WINDOW=40000 LLM_KEEP_RECENT_TOKENS=20 npm run dev &
LLM_CONTEXT_WINDOW=40000 node e2e/confirm-drive.cjs
```

Drop the last line and open http://localhost:5173 to click around by hand instead. See
[`e2e/README.md`](./e2e/README.md).

### 2. Real model, no Galaxy, no browser — the eval harness

Grades planning behaviour headlessly against a real provider. See
[`evals/README.md`](./evals/README.md).

```bash
python3 evals/run.py smoke --delay 0
```

### 3. Real Galaxy and a real model

```bash
GALAXY_ROOT=http://127.0.0.1:8080 GALAXY_KEY=<galaxy-api-key> \
LLM_PROVIDER=gemini LLM_KEY="$GEMINI_KEY" LLM_MODEL=gemini-3.7-flash \
npm run dev
```

`LLM_PROVIDER` names a built-in provider (`galaxy`, `gemini`, `deepseek`, `local`),
which carries its own base URL, context window, rate limit and endpoint caps — see
`brain/olite/substrate/llm/providers.py`. For an endpoint the registry does not know,
set `LLM_ROOT` and `LLM_PATH` instead and it is treated as a custom provider.

Then open http://localhost:5173, or `?dataset_id=<id>` to start with a dataset in scope.

**Set `GALAXY_KEY`.** The plugin is served from vite, not from inside Galaxy, so the
session cookie does not apply and the proxy appends the key to every `/api` call instead.
Without it you get an anonymous session: reads succeed but return nothing of yours, and
writes are 403. Get a key from Galaxy under User -> Preferences -> Manage API Key.

The plugin does **not** need to be registered in Galaxy for this: `<ai_api_base_url>` is
`/llm`, so the model is reached through vite rather than through Galaxy's chat proxy. Only
a production install needs the registration.

### Things that will bite

- `npm run dev` rebuilds the Pyodide assets and the brain wheel first, so the first start
  takes minutes. Plain `npx vite` skips the build and serves what is already there.
- **Editing `brain/` Python does nothing until the wheel is rebuilt** — `npm run build:olite`,
  then reload. Vite only watches `src/`.
- Provider keys usually live in `~/.zshrc`, which a non-interactive shell does not read;
  `source ~/.zshrc` first.
- `LLM_PROVIDER` supplies the context window; only set `LLM_CONTEXT_WINDOW` for an
  endpoint the registry does not know, or to force a smaller one.

## Tests

```bash
npm test                 # vitest + pytest
npx tsc --noEmit
npm run seams            # Orbit parity: drift, missing symbols, unanchored prompt text
```

`npm run seams` checks olite against Orbit's source: prompt blocks and their emit conditions,
loom's eval scenarios, the Galaxy tool surface, the vendored skills corpus, and the pi agent
loop. It reports **DRIFT** when Orbit changes upstream, **MISSING** when a symbol disappears
on either side, and **ORPHAN** when olite carries prompt text that no Orbit anchor accounts
for. Without a loom checkout it skips the upstream comparisons and still runs the rest. See
[`seams/README.md`](./seams/README.md). CI runs all four on every push and pull request.

## Scope

- No local shell or filesystem — Galaxy is the OS, and `run_python` is Pyodide only.
- No server-side brain, and no per-user container. Orbit's Interactive Tool provides both;
  olite runs browser-native within a Galaxy session instead.

## Credit

Its agent behavior and interaction model are closely aligned with Orbit, the original Galaxy
AI co-scientist and the reference implementation used for olite's parity evaluation. Several
core concepts—including plan-and-approve, parameter review, the analysis record, and
skills—were adapted directly from Orbit. olite reimplements these concepts for a
browser-native runtime integrated with Galaxy, with differences arising primarily from the
capabilities and constraints of that environment.

Orbit runs as a Galaxy Interactive Tool, with a container per user and access to a shell.
Choose Orbit when you need shell access or a per-user container; olite provides a
browser-native alternative that runs directly within a Galaxy session.

Every deliberate difference is recorded rather than assumed.

- Orbit: [github.com/galaxyproject/loom](https://github.com/galaxyproject/loom)
- Shared skills corpus:
  [github.com/galaxyproject/galaxy-skills](https://github.com/galaxyproject/galaxy-skills)
- Galaxy visualization framework:
  [github.com/galaxyproject/galaxy-charts](https://github.com/galaxyproject/galaxy-charts)

The Pyodide substrate (`substrate/`) is adopted from the `vintent` Charts plugin and the
`polaris` prototype.
