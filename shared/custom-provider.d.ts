import type { LlmProviderConfig } from "./loom-config.js";

export interface CustomModelDef {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface ModelsConfig {
  providers?: Record<
    string,
    { name?: string; baseUrl?: string; api?: string; apiKey?: string; models?: unknown[] }
  >;
}

export type EndpointApi = "openai-completions" | "anthropic-messages";

export const ENDPOINT_APIS: readonly EndpointApi[];
export const DEFAULT_ENDPOINT_API: EndpointApi;
/** Throws on any value outside ENDPOINT_APIS; empty/absent resolves to the default. */
export function normalizeEndpointApi(value: string | undefined | null): EndpointApi;

export const ACTIVE_LLM_API_KEY_ENV: "LOOM_ACTIVE_LLM_API_KEY";
export function isCustomProvider(entry: LlmProviderConfig | undefined): boolean;
export function synthesizeModelDef(entry: LlmProviderConfig): CustomModelDef;
export function mergeCustomProviderIntoModelsConfig(
  modelsConfig: ModelsConfig,
  providerName: string,
  entry: LlmProviderConfig,
): ModelsConfig;
export function syncCustomProviderModelsFile(
  modelsJsonPath: string,
  providerName: string,
  entry: LlmProviderConfig,
): ModelsConfig;
export function resolveActiveLlmApiKey(
  entry: LlmProviderConfig | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | undefined;
