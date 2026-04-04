


export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai-chat',
    OPENAI_RESPONSES: 'openai-responses',
    OPENAI_MODEL_LIST: 'openai-model-list',
    CLAUDE_MESSAGE: 'claude-message',
    GEMINI_CONTENT: 'gemini-content',
    GEMINI_MODEL_LIST: 'gemini-model-list',
};


export const MODEL_PROTOCOL_PREFIX = {
    OPENAI: 'openai',
    OPENAI_RESPONSES: 'openai-responses',
    CLAUDE: 'claude',
    GEMINI: 'gemini',
    FORWARD: 'forward',
    GROK: 'grok',
    GIGACHAT: 'gigachat',
    DEEPSEEK: 'deepseek',
};


export function getProtocolPrefix(providerType: string): string {
    
    if (providerType === 'openai-codex-oauth') {
        return 'codex';
    }

    
    const hyphenIndex = providerType.indexOf('-');
    if (hyphenIndex !== -1) {
        return providerType.substring(0, hyphenIndex);
    }
    
    
    return providerType;
}
