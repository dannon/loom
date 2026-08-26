/** The brain's config, assembled from the plugin manifest and dev env vars. */
import { parseIncoming } from "./incoming";

const PLUGIN_NAME = "olite";

export function buildConfig(incoming: ReturnType<typeof parseIncoming>) {
    const s = incoming.specs;
    return {
        ai_base_url: s.ai_api_base_url || `${incoming.root}api/plugins/${PLUGIN_NAME}`,
        ai_api_key: s.ai_api_key,
        // Names a built-in provider, so the brain gets its limits and context window.
        ai_provider: (process.env.llm_provider as string) || (s.ai_api_base_url ? undefined : "galaxy"),
        // Dev only: switch model by env instead of editing a committed file.
        ai_model: (process.env.llm_model as string) || s.ai_model,
        // Only for an endpoint the provider registry does not know.
        ai_context_window: Number(process.env.llm_context_window) || undefined,
        ai_keep_recent_tokens: Number(process.env.llm_keep_recent_tokens) || undefined,
        galaxy_root: incoming.root,
        history_id: incoming.historyId,
        galaxy_key: s.galaxy_api_key,
        // Demo grants write; real deployments gate it via the install/trust tier.
        capabilities: ["llm", "local", "read", "write"],
    };
}
