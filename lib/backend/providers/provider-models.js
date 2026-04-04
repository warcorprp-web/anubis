export const PROVIDER_MODELS = {
  "gemini-cli-oauth": [ "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-2.5-pro-preview-06-05", "gemini-2.5-flash-preview-09-2025", "gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-3.1-pro-preview", "gemini-3.1-flash-lite-preview" ],
  "gemini-antigravity": [ "gemini-3-flash", "gemini-3.1-pro-high", "gemini-3.1-pro-low", "gemini-3.1-flash-image", "gemini-3-flash-agent", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-flash-thinking", "gemini-claude-sonnet-4-6", "gemini-claude-opus-4-6-thinking" ],
  "claude-custom": [],
  "claude-kiro-oauth": [ "claude-haiku-4-5", "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5", "claude-opus-4-5-20251101", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514", "claude-3-7-sonnet-20250219" ],
  "openai-custom": [],
  "openaiResponses-custom": [],
  "openai-qwen-oauth": [ "qwen3-coder-plus", "qwen3-coder-flash", "coder-model", "vision-model" ],
  "openai-iflow": [ "iflow-rome-30ba3b", "qwen3-coder-plus", "qwen3-max", "qwen3-vl-plus", "qwen3-max-preview", "qwen3-32b", "qwen3-235b-a22b-thinking-2507", "qwen3-235b-a22b-instruct", "qwen3-235b", "kimi-k2-0905", "kimi-k2", "glm-4.6", "deepseek-v3.2", "deepseek-r1", "deepseek-v3", "glm-4.7", "glm-5", "kimi-k2.5", "minimax-m2.1", "minimax-m2.5" ],
  "openai-codex-oauth": [ "gpt-5", "gpt-5-codex", "gpt-5-codex-mini", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-codex-max", "gpt-5.2", "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini" ],
  "forward-api": [],
  "grok-custom": [ "grok-3", "grok-3-mini", "grok-3-thinking", "grok-4", "grok-4-mini", "grok-4-thinking", "grok-4-heavy", "grok-4.1-mini", "grok-4.1-fast", "grok-4.1-expert", "grok-4.1-thinking", "grok-4.20-beta", "grok-imagine-1.0", "grok-imagine-1.0-edit", "grok-imagine-1.0-video" ],
  "deepseek": [ "deepseek-chat", "deepseek-coder", "deepseek-reasoner", "deepseek-r1" ]
};

export function getProviderModels(providerType) {
  return PROVIDER_MODELS[providerType] || [];
}

export function getAllProviderModels() {
  return PROVIDER_MODELS;
}