export function modelsJsonProviders(modelsPath: string): string[];

export function isKnownProvider(
  provider: string,
  builtIn: Iterable<string>,
  extra?: Iterable<string>,
): boolean;

export function userExtensionsMayRegisterProviders(agentDir: string, cwd: string): boolean;

export function unknownProviderMessage(provider: string): string;
