export interface LoomConfig {
  llm?: {
    provider?: string;
    apiKey?: string;
    model?: string;
  };
  galaxy?: {
    active: string | null;
    profiles: Record<string, { url: string; apiKey: string }>;
  };
  executionMode?: "local" | "remote";
  defaultCwd?: string;
  /**
   * Absolute path to a gxy-sketches checkout. When set, Loom scans the
   * corpus for sketches matching the active plan (by tool IDs, workflow
   * ID, or tags) and injects the content into the system prompt.
   */
  sketchCorpusPath?: string;
}

export function getConfigDir(): string;
export function getConfigPath(): string;
export function loadConfig(): LoomConfig;
export function saveConfig(config: LoomConfig): void;
