export function isHandledPrompt(event: Record<string, unknown>): boolean;

export function promptStartsNoTurn(event: Record<string, unknown>): boolean;

export function isSlashCommandPrompt(message: unknown): message is string;
