/**
 * Common utilities (ported from aiclient-2-api/src/utils/common.js)
 */

// Endpoint types (точь-в-точь как в оригинале)
export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai-chat',
    OPENAI_RESPONSES: 'openai-responses',
    OPENAI_MODEL_LIST: 'openai-model-list',
    CLAUDE_MESSAGE: 'claude-message',
    GEMINI_CONTENT: 'gemini-content',
    GEMINI_MODEL_LIST: 'gemini-model-list',
};

// Model protocol prefixes (точь-в-точь как в оригинале)
export const MODEL_PROTOCOL_PREFIX = {
    OPENAI: 'openai',
    OPENAI_RESPONSES: 'openai-responses',
    CLAUDE: 'claude',
    GEMINI: 'gemini',
    FORWARD: 'forward',
    GROK: 'grok',
};

/**
 * Get protocol prefix from provider type (точь-в-точь как в оригинале)
 */
export function getProtocolPrefix(providerType: string): string {
    // Special case for Codex
    if (providerType === 'openai-codex-oauth') {
        return 'codex';
    }

    // Extract protocol from provider type (точь-в-точь как в оригинале)
    const hyphenIndex = providerType.indexOf('-');
    if (hyphenIndex !== -1) {
        return providerType.substring(0, hyphenIndex);
    }
    
    // Return original if no hyphen is found
    return providerType;
}
