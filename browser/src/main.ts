/** olite shell: mounts Orbit's ChatPanel, boots the Pyodide brain, drives the chat. */
import "./orbit/styles.css";
import { editRecord } from "./record-write";
import { applyJobOutcome, noteSubmitted } from "./record-jobs";
import { ChatPanel } from "./orbit/chat/chat-panel";
import { applyOrbitTheme } from "./orbit/theme";
import { parseIncoming } from "./incoming";
import { catalogRefusalMessage, galaxyCanRun } from "./catalog-gate";
import { buildConfig } from "./config";
import { describeError, lastLine, renderMessages, replayMessages, toolStatus } from "./transcript";
import { SessionMemory, galaxyUserId, indexedDbStore } from "./session";
import { writeSessionSummary } from "./session-summary";
import { createConfirm } from "./confirm-modal";
import { PyodideManager } from "./pyodide/pyodide-manager";
import { runOlite } from "./pyodide-runner";
import { renderArtifact } from "./artifacts";
import { InvocationWatcher, galaxyStateReader, isFailure } from "./invocations";

const PLUGIN_NAME = "olite";
const PROMPT_DEFAULT = "You are olite. Communicate only by calling tools.";

async function main() {
    const scriptUrl = new URL(import.meta.url);
    const containerId = scriptUrl.searchParams.get("container") || "app";

    // Dev-only: synthesize data-incoming from the plugin XML (no framework host).
    if ((import.meta as any).env.DEV) {
        const { parseXML } = await import("galaxy-charts-xml-parser");
        const pageUrl = new URL(window.location.href);
        const dataIncoming = {
            root: "/",
            visualization_config: {
                dataset_id: pageUrl.searchParams.get("dataset_id") || "__test__",
                // Dev only: a history to key the session on, as Galaxy supplies in production.
                history_id: pageUrl.searchParams.get("history_id") || undefined,
                settings: {},
            },
            visualization_plugin: await parseXML("olite.xml"),
        };
        document.getElementById(containerId)!.dataset.incoming = JSON.stringify(dataIncoming);
    }

    const container = document.getElementById(containerId)!;
    const incoming = parseIncoming(container);
    applyOrbitTheme("dark", document.documentElement);

    // Orbit's layout chain, so the vendored styles.css applies as-is.
    container.innerHTML = `
      <div id="app-main">
        <div id="chat-pane" class="pane">
          <div id="messages"></div>
          <div id="input-area">
            <div class="composer-row">
              <textarea id="input" rows="1" aria-label="Chat input"
                placeholder="Ask olite to run something..."></textarea>
              <button id="send-btn" title="Send" aria-label="Send message">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
              <!-- Orbit's abort button; the vendored styles.css already has #abort-btn. -->
              <button id="abort-btn" title="Stop (Esc)" class="hidden" aria-label="Stop the current response">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
                <span>Stop</span>
              </button>
            </div>
          </div>
          <div id="input-hint">
            <span>Enter to send</span>
            <button id="reset-btn" class="hidden" title="Start a fresh conversation">New conversation</button>
          </div>
        </div>
        <div id="divider"></div>
        <div id="artifact-pane" class="pane">
          <div id="artifact-content"></div>
        </div>
      </div>
      <!-- Orbit's request modal, reduced to the confirm variant. -->
      <div id="ext-overlay" class="modal-overlay hidden">
        <div class="modal">
          <div class="modal-header"><h2 id="ext-title">Request</h2></div>
          <div class="modal-body"><div id="ext-message" class="ext-message"></div></div>
          <div class="modal-footer">
            <div class="modal-actions">
              <button id="ext-deny" class="plan-btn">No</button>
              <button id="ext-accept" class="plan-btn primary">Yes</button>
            </div>
          </div>
        </div>
      </div>`;

    // Start with the artifact pane collapsed; it reveals when a tool produces one.
    document.body.classList.add("artifact-collapsed");

    const messagesEl = container.querySelector<HTMLElement>("#messages")!;
    const chat = new ChatPanel(messagesEl);
    const input = container.querySelector<HTMLTextAreaElement>("#input")!;
    const sendBtn = container.querySelector<HTMLButtonElement>("#send-btn")!;
    const abortBtn = container.querySelector<HTMLButtonElement>("#abort-btn")!;
    const artifactContent = container.querySelector<HTMLElement>("#artifact-content")!;

    const config = buildConfig(incoming);
    // Runtime context: where relative fetches resolve and what origin Galaxy calls hit.
    console.log("[olite] context", {
        href: window.location.href,
        origin: window.location.origin,
        isIframe: window.top !== window.self,
        galaxy_root: config.galaxy_root,
        openapi_url: `${config.galaxy_root}openapi.json`,
    });
    // One id per tab, so the summary block upserts rather than accumulating.
    const sessionId = (globalThis.crypto?.randomUUID?.() || `session-${Date.now()}`);
    const startedAt = new Date().toISOString();
    const seed = { role: "system", content: incoming.specs.ai_prompt || PROMPT_DEFAULT };
    const convo: Array<{ role: string; content: string }> = [seed];

    // One conversation per user and history, as pi keys a session by home plus directory.
    const credentials = (process.env.credentials as RequestCredentials) || "include";
    const session = new SessionMemory(
        indexedDbStore(),
        config.history_id,
        await galaxyUserId(config.galaxy_root, credentials),
    );
    const resetBtn = container.querySelector<HTMLButtonElement>("#reset-btn")!;
    // Replay before the boot notice, so the restored turns sit above it as history.
    let resumed = false;
    const restored = session.enabled ? await session.load() : null;
    if (restored) {
        convo.length = 0;
        convo.push(...restored);
        replayMessages(chat, restored);
        resumed = true;
        resetBtn.classList.remove("hidden");
    }

    // Boot Pyodide (brain lives inside it).
    const isDev = (import.meta as any).env.DEV;
    const base = isDev ? "" : `static/plugins/visualizations/${PLUGIN_NAME}/`;
    const indexURL = `${incoming.root}${base}static/pyodide`;
    const pyodide = new PyodideManager({
        indexURL,
        extraPackages: [`${indexURL}/olite-0.0.0-py3-none-any.whl`],
    });
    let ready = false;
    const readyInfo = chat.addInfoMessage("Loading olite...");
    pyodide
        .initialize()
        .then(() => {
            ready = true;
            readyInfo.textContent = resumed
                ? "Resumed this history's conversation. olite ready."
                : "olite ready. Ask me to run something.";
        })
        .catch((e) => chat.addErrorMessage(`Failed to load olite: ${e}`));

    // Advances submitted Galaxy work between turns, so no turn blocks on a job.
    const watcher = new InvocationWatcher({
        readState: galaxyStateReader(config.galaxy_root, credentials),
        // loom's agent calls galaxy_invocation_record so the poller owns the entry. olite's
        // watcher already holds the id from the tool result, so the shell writes it -- a live
        // run recorded an invocation's uuid where Galaxy's id was needed, and nothing matched.
        onSubmitted: (w) => {
            if (!config.history_id) return;
            void editRecord(
                { root: config.galaxy_root, credentials, historyId: config.history_id },
                (content) => noteSubmitted(content, w),
            );
        },
        onSettled: (w, state) => {
            const what = w.kind === "invocation" ? "Workflow invocation" : "Galaxy job";
            const failed = isFailure(w.kind, state);
            if (failed) {
                chat.addErrorMessage(`${what} ${w.id} finished as ${state}.`);
            } else {
                chat.addInfoMessage(`${what} ${w.id} finished (${state}). Ask me to check the results.`);
            }
            // loom's poller advances the notebook itself; do the same to the record, so a
            // turn that ends before its jobs do does not leave the record claiming they run.
            if (config.history_id) {
                void editRecord(
                    { root: config.galaxy_root, credentials, historyId: config.history_id },
                    (content) => applyJobOutcome(content, { id: w.id, kind: w.kind, state, failed }),
                );
            }
        },
    });

    let busy = false;
    // Last catalog status the brain reported; undefined until the first turn returns.
    let latestCatalog: import("./catalog-gate").CatalogStatus | undefined;
    async function submit() {
        const text = input.value.trim();
        if (!text || busy || !ready) {
            return;
        }
        busy = true;
        input.value = "";
        // Stop replaces Send for the duration of the turn, as in Orbit.
        sendBtn.classList.add("hidden");
        abortBtn.classList.remove("hidden");
        chat.addUserMessage(text);
        chat.showThinking();
        convo.push({ role: "user", content: text });
        // Cards rendered live from loop events; the final reconcile skips these ids.
        const streamed = new Set<string>();
        const onEvent = (ev: any) => {
            if (ev.type === "tool_start") {
                streamed.add(ev.id);
                chat.hideThinking();
                chat.addToolCard(ev.id, ev.name || "tool");
            } else if (ev.type === "llm_retry") {
                // A rate limit means a long silent wait; count it down instead.
                startRetryCountdown(ev.status, ev.wait, ev.attempt, ev.of);
            } else if (ev.type === "compacted") {
                // Never let history disappear without saying so.
                chat.addInfoMessage("Summarized the earlier conversation to make room.");
            } else if (ev.type === "context_overflow") {
                // Compaction was needed and could not help; say so before the provider does.
                chat.addErrorMessage(
                    "This conversation no longer fits in the model's context window, and summarizing " +
                        "cannot free enough room. Start a new conversation, or configure a larger window.",
                );
            } else if (ev.type === "tool_end") {
                // The brain states the outcome; toolStatus only guesses at it.
                const status = ev.is_error ? "error" : toolStatus(ev.content || "");
                chat.updateToolCard(ev.id, status, ev.content || "");
                // Galaxy returns the ids, so the model never has to register them.
                watcher.ingest(ev.name || "", ev.content || "");
            }
        };
        try {
            console.groupCollapsed("[olite] turn");
            console.log("request", { galaxy_root: config.galaxy_root, capabilities: config.capabilities, text });
            const reply = await runOlite(pyodide, config, convo, onEvent);
            console.log("diagnostics", reply.diagnostics);
            console.log("trace", reply.logs);
            console.log("messages", reply.messages);
            console.groupEnd();
            // Surface a broken Galaxy catalog once; it is otherwise a silent dead end.
            const cat = reply.diagnostics && reply.diagnostics.catalog;
            latestCatalog = cat || latestCatalog;
            if (cat && !cat.loaded) {
                chat.addErrorMessage(`Galaxy catalog did not load (root=${config.galaxy_root}): ${cat.error}`);
            }
            chat.hideThinking();
            stopRetryCountdown();
            if (reply.error) {
                // The brain returns a failed turn as data; the console keeps the detail.
                console.error("[olite] turn failed", reply.error);
                chat.addErrorMessage(describeError(reply.error));
                busy = false;
                abortBtn.classList.add("hidden");
                sendBtn.classList.remove("hidden");
                return;
            }
            // The brain names this turn's messages; compaction moves them, so no slicing.
            const spoke = renderMessages(chat, reply.new_messages || [], streamed);
            // Exactly one explanation for a quiet turn, most specific first.
            if (reply.aborted) {
                chat.addInfoMessage("Stopped.");
            } else if (reply.exhausted) {
                // Orbit has no step cap; olite's must not look like completion.
                chat.addInfoMessage("I ran out of steps for one turn while still working. Say \"continue\" to pick it up.");
            } else if (!spoke && !reply.done) {
                // A reply with no tool calls ends the loop; `done` means finish was called.
                chat.addInfoMessage("The model ended the turn without a reply. Ask again, or rephrase.");
            }
            convo.length = 0;
            convo.push(...(reply.messages || []));
            void session.save(convo);
            // loom writes a session block into the notebook itself; the record then carries
            // shell-written proof of the session even if the agent wrote nothing.
            void writeSessionSummary(config.galaxy_root, credentials, config.history_id, {
                id: sessionId,
                startedAt,
                endedAt: new Date().toISOString(),
                orphanedActiveSteps: 0,
            });
            resetBtn.classList.toggle("hidden", !session.enabled);
            const artifacts = reply.artifacts || [];
            if (artifacts.length) {
                document.body.classList.remove("artifact-collapsed");
                artifactContent.innerHTML = "";
                for (const a of artifacts) {
                    await renderArtifact(artifactContent, a);
                }
            }
        } catch (e) {
            chat.hideThinking();
            stopRetryCountdown();
            chat.addErrorMessage(lastLine(String(e)));
        }
        abortBtn.classList.add("hidden");
        sendBtn.classList.remove("hidden");
        busy = false;
    }

    // Tick the wait down, so a slow provider is distinguishable from a hung one.
    let retryTimer: ReturnType<typeof setInterval> | undefined;
    let retryLine: HTMLElement | undefined;
    function startRetryCountdown(status: number, wait: number, attempt: number, of: number) {
        stopRetryCountdown();
        let left = Math.ceil(wait);
        const label = status === 429 ? "Rate limited by the model provider" : `Provider error ${status}`;
        const render = () => `${label} — retrying in ${left}s (attempt ${attempt}/${of}).`;
        retryLine = chat.addInfoMessage(render());
        retryTimer = setInterval(() => {
            left -= 1;
            if (left <= 0) {
                stopRetryCountdown();
                return;
            }
            if (retryLine) {
                retryLine.textContent = render();
            }
        }, 1000);
    }
    function stopRetryCountdown() {
        if (retryTimer) {
            clearInterval(retryTimer);
            retryTimer = undefined;
        }
        retryLine = undefined;
    }

    function abortCurrentTurn() {
        if (busy) {
            pyodide.abort();
        }
    }

    pyodide.onConfirm = createConfirm({
        container,
        respond: (id, approved) => pyodide.respondToConfirm(id, approved),
        note: (text) => chat.addInfoMessage(text),
    });

    sendBtn.addEventListener("click", submit);
    abortBtn.addEventListener("click", abortCurrentTurn);
    // loom: "reset session -- fresh start, no --continue".
    resetBtn.addEventListener("click", async () => {
        if (busy) {
            return;
        }
        await session.clear();
        convo.length = 0;
        convo.push(seed);
        messagesEl.innerHTML = "";
        resetBtn.classList.add("hidden");
        chat.addInfoMessage("Started a new conversation. The record on Galaxy is untouched.");
    });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
        }
    });
    // Esc stops the turn; bound on the container because olite lives in an iframe.
    container.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Escape" && busy) {
            abortCurrentTurn();
        }
    });

    // Approve / Edit / Reject on a plan draft card; wording follows loom's handler.
    messagesEl.addEventListener("plan-draft-action", (e) => {
        const { action, body } = (e as CustomEvent<{ action: string; body: string }>).detail;
        if (action === "approve") {
            // loom's init gate refuses /execute when Galaxy cannot run the plan; Approve is
            // the equivalent control here, so it refuses before the turn is ever sent.
            if (!galaxyCanRun(latestCatalog)) {
                chat.addErrorMessage(catalogRefusalMessage(latestCatalog));
                return;
            }
            input.value = "I approve the plan above. Show the full parameter table for review before executing.";
            void submit();
        } else if (action === "reject") {
            input.value = "Reject the plan above — let's rethink it.";
            void submit();
        } else if (action === "edit") {
            // Edit hands the draft back for the user to change; it does not submit.
            input.value = "Here is the plan with my edits — please revise your draft accordingly:\n\n```plan\n" + body + "\n```";
            input.focus();
        }
    });
}

// No window here: the brain compacts, and trimming on top would delete the summary.

void main();
