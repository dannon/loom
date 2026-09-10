/**
 * Load the curated model matrix and decide which entries can actually run.
 *
 * Skip-with-warning rather than fail-on-missing-env: most contributors won't
 * have every credential (Anthropic + TACC + OpenAI + ...), and we want the
 * subset they do have to keep working locally.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { ModelEntry, ModelMatrix } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const evalsDir = path.resolve(path.dirname(__filename), "..");
const modelsJsonPath = path.join(evalsDir, "models.json");

export interface MatrixLoadResult {
  available: ModelEntry[];
  skipped: { model: ModelEntry; missing: string[] }[];
}

/**
 * Env vars a model genuinely can't run without. `envRequires` is the curated
 * list, but a providerConfig names its own baseUrl/apiKey vars -- deriving those
 * instead of trusting the two lists to stay in sync is what keeps a missing
 * credential a skip rather than a crash mid-matrix.
 */
export function requiredEnvVars(model: ModelEntry): string[] {
  const names = [...(model.envRequires ?? [])];
  const cfg = model.providerConfig;
  if (cfg) {
    if (cfg.baseUrlIsEnvVar) names.push(cfg.baseUrl);
    names.push(cfg.apiKeyEnvVar);
  }
  return [...new Set(names)];
}

export function loadMatrix(filterIds?: string[]): MatrixLoadResult {
  const raw = JSON.parse(fs.readFileSync(modelsJsonPath, "utf-8")) as ModelMatrix;
  const available: ModelEntry[] = [];
  const skipped: MatrixLoadResult["skipped"] = [];

  for (const model of raw.models) {
    if (filterIds && filterIds.length > 0 && !filterIds.includes(model.id)) continue;
    const missing = requiredEnvVars(model).filter((v) => !process.env[v]);
    if (missing.length > 0) {
      skipped.push({ model, missing });
      continue;
    }
    available.push(model);
  }
  return { available, skipped };
}

/**
 * Synthesize a Pi-shaped models.json into the temp agent dir for any
 * OpenAI-compatible custom provider. First-class providers (anthropic et al.)
 * are no-ops -- Pi loads them from its built-in registry.
 */
export function writePiModelsConfig(model: ModelEntry, agentDir: string): void {
  if (!model.providerConfig) return;

  const cfg = model.providerConfig;
  const baseUrl = cfg.baseUrlIsEnvVar ? process.env[cfg.baseUrl] : cfg.baseUrl;
  if (!baseUrl) {
    throw new Error(`Model ${model.id}: providerConfig.baseUrl env var '${cfg.baseUrl}' is unset`);
  }

  // A BARE env var name here is not indirection -- pi reads it as the literal
  // credential and sends it as the bearer token, which is how the whole matrix
  // silently 401'd ("Received=PROX****_KEY"). The `$` prefix is what makes pi
  // interpolate from the environment at request time (resolve-config-value.ts),
  // so the real key stays out of the file the agent under test can read.
  const apiKey = `$${cfg.apiKeyEnvVar}`;

  const piModels = {
    providers: {
      [model.provider]: {
        baseUrl,
        api: "openai-completions",
        apiKey,
        models: [
          {
            id: model.model,
            name: model.model,
            reasoning: model.reasoningModel ?? false,
            input: ["text"],
            contextWindow: cfg.contextWindow ?? 32000,
            maxTokens: cfg.maxTokens ?? 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };

  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify(piModels, null, 2));
}
