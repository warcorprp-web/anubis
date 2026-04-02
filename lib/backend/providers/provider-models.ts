/**
 * Provider models mapping (ported from provider-models.js)
 * Defines which models each provider supports
 */

export const PROVIDER_MODELS: Record<string, string[]> = {
    'gemini-cli-oauth': [
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-pro',
        'gemini-3-pro-preview',
        'gemini-3-flash-preview',
    ],
    'gemini-antigravity': [
        'gemini-3-flash',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
    ],
    'claude-custom': [],
    'claude-kiro-oauth': [
        'claude-haiku-4-5',
        'claude-opus-4-6',
        'claude-sonnet-4-6',
        'claude-opus-4-5',
        'claude-sonnet-4-5',
        'claude-3-7-sonnet-20250219'
    ],
    'openai-custom': [],
    'openai-qwen-oauth': [
        'qwen3-coder-plus',
        'qwen3-coder-flash',
        'coder-model',
        'vision-model'
    ],
    'openai-iflow': [
        'iflow-rome-30ba3b',
        'qwen3-coder-plus',
        'qwen3-max',
        'kimi-k2',
        'glm-4.6',
        'deepseek-v3',
        'deepseek-r1',
    ],
    'openai-codex-oauth': [
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-codex-mini',
        'gpt-5.1',
        'gpt-5.1-codex',
    ],
    'forward-api': [],
    'grok-custom': [
        'grok-3',
        'grok-3-mini',
        'grok-4',
        'grok-4-mini',
    ]
};

/**
 * Get supported models for a provider type (точь-в-точь как в оригинале)
 */
export function getProviderModels(providerType: string): string[] {
    return PROVIDER_MODELS[providerType] || [];
}

/**
 * Get all provider models (точь-в-точь как в оригинале)
 */
export function getAllProviderModels(): Record<string, string[]> {
    return PROVIDER_MODELS;
}
