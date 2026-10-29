import type { OrbitConfig } from "./orbit-config.js";

export interface GalaxyCredentials {
  url: string;
  apiKey: string;
  source: "env" | "profile";
}

export interface ResolveGalaxyCredentialsInput {
  config: Pick<OrbitConfig, "galaxy"> | null | undefined;
  /**
   * The active profile's key as the caller can read it. Omit to use the
   * profile's plaintext `apiKey`; pass null when the caller knows it has none.
   */
  profileApiKey?: string | null;
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
  prefer: "env" | "profile";
}

export function resolveGalaxyCredentials(
  input: ResolveGalaxyCredentialsInput,
): GalaxyCredentials | null;

export function describeMissingGalaxyCredentials(
  input: Pick<ResolveGalaxyCredentialsInput, "config" | "env">,
): string | null;
