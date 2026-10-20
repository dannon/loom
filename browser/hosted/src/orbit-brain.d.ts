/**
 * The Orbit seams the recovery worker installs, served by recovery-bundle.ts as one virtual module.
 * Typed loosely on purpose: the brain's sources typecheck under the root project, and pulling
 * extensions/loom into this workspace's program would check them under the wrong config.
 */
declare module "orbit-brain" {
  type Seam<T> = (next: T | null) => void;
  export const loom: (pi: unknown) => void;
  export const setCapabilityProfile: Seam<Record<string, unknown>>;
  export const setConfigSource: Seam<{ load: () => unknown }>;
  export const setInstructionSource: Seam<{
    files: () => Array<{ scope: string; path: string; content: string; truncated: boolean }>;
  }>;
  export const setVendorSkillsSource: Seam<{
    catalog: unknown;
    manifest: unknown;
    read: (target: string) => string | null;
  }>;
  export const setGalaxyTransport: Seam<{
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    credentials?: () => { url: string; apiKey: string };
  }>;
  export const setRecordStore: Seam<unknown>;
  export const createPageRecordStore: (opts: { key: string; pageId: string }) => unknown;
  export const setGalaxyToolSource: Seam<unknown>;
  export const createGalaxyOpsToolSource: (opts: { extras: unknown[] }) => unknown;
}
