// Model catalog by provider -- labels include cost guidance (in/out price per
// 1M tokens). Fallback only: populateDynamicModelData() at startup overwrites
// this from pi-ai's bundled registry via main IPC, so new models don't require
// hand-edits here. It does have to name models pi still ships, though, or the
// picker offers ids that fail on first use when that IPC is down (#609) --
// tests/model-fallback.test.ts checks it against the registry.
export interface ModelChoice {
  id: string;
  label: string;
}

export const FALLBACK_MODELS_BY_PROVIDER: Readonly<Record<string, readonly ModelChoice[]>> = {
  anthropic: [
    { id: "claude-opus-5", label: "Opus 5 — $5/$25 (recommended)" },
    { id: "claude-sonnet-5", label: "Sonnet 5 — $2/$10" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5 — $1/$5 (cheapest)" },
    { id: "claude-fable-5", label: "Fable 5 — $10/$50 (most capable)" },
    { id: "claude-opus-4-8", label: "Opus 4.8 — $5/$25" },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — $3/$15" },
    { id: "claude-opus-4-7", label: "Opus 4.7 — $5/$25" },
  ],
  openai: [
    { id: "gpt-5.4-mini", label: "GPT-5.4 mini — $0.75/$4.50 (cheapest)" },
    { id: "gpt-5.4", label: "GPT-5.4 — $2.50/$15 (recommended)" },
    { id: "gpt-5.2", label: "GPT-5.2 — $1.75/$14" },
    { id: "gpt-5.5", label: "GPT-5.5 — $5/$30" },
  ],
  "openai-codex": [
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  ],
  google: [
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite — $0.25/$1.50 (cheapest)" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro — $2/$12 (recommended)" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash — $1.50/$9" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — $1.25/$10" },
  ],
  mistral: [
    { id: "mistral-large-latest", label: "Mistral Large" },
    { id: "mistral-medium-latest", label: "Mistral Medium" },
    { id: "mistral-small-latest", label: "Mistral Small" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B" },
    { id: "llama-3.1-8b-instant", label: "Llama 3.1 8B (fast)" },
  ],
  xai: [
    { id: "grok-4.7", label: "Grok 4.7 — $2/$6" },
    { id: "grok-4.3", label: "Grok 4.3 — $1.25/$2.50 (cheapest)" },
  ],
  deepseek: [
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "deepseek-flash", label: "DeepSeek V4.1 Flash (fast)" },
  ],
  "openai-compatible": [],
};
