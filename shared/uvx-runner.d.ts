export function resolveExecutable(
  cmd: string,
  opts?: {
    pathEnv?: string;
    platform?: NodeJS.Platform;
    pathExt?: string;
    isExecutable?: (p: string) => boolean;
  },
): string | null;
export function isUvxAvailable(): boolean;
export function uvxMissingNotice(): string;
