export interface CapabilityProfile {
  shell: boolean;
  files: boolean;
  notebook: "file" | "page";
  network: boolean;
  /** pi's MCP layer, for the servers Orbit brings (brc-analytics). */
  mcpServers: boolean;
  ui: "desktop" | "terminal" | "worker";
  /** An in-brain Python runtime (the browser's Pyodide); no Node shell has one. */
  python?: boolean;
}

export function profileFromEnv(env?: Record<string, string | undefined>): CapabilityProfile;
/** The installed profile when a shell set one and no env was passed, else profileFromEnv(env). */
export function capabilityProfile(env?: Record<string, string | undefined>): CapabilityProfile;
export function setCapabilityProfile(profile: CapabilityProfile | null): void;
/** The installed profile itself, or null when env is in charge. */
export function installedCapabilityProfile(): CapabilityProfile | null;
