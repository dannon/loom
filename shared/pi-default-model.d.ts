export function loadPiDefaultModels(
  resolveSpecifier?: (specifier: string) => string,
): Promise<Record<string, string>>;
export function piDefaultModel(
  provider: string | undefined,
  defaults: Record<string, string>,
): string | undefined;
