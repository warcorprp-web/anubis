

import { BaseConverter } from '../BaseConverter';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/common';
import logger from '../../utils/logger';

export class OpenAIConverter extends BaseConverter {
    constructor() {
        super('openai');
    }

    convertRequest(data: any, targetProtocol: string): any {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeRequest(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiRequest(data);
            case MODEL_PROTOCOL_PREFIX.OPENAI:
            case MODEL_PROTOCOL_PREFIX.GIGACHAT:
            case MODEL_PROTOCOL_PREFIX.DEEPSEEK:
                return data; 
            default:
                logger.warn(`[OpenAI Converter] Unsupported target: ${targetProtocol}`);
                return data;
        }
    }

    convertResponse(data: any, targetProtocol: string, model?: string): any {
        logger.info(`[OpenAI Converter] Converting response to: ${targetProtocol}`);
        
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.GROK:
                return this.toGrokResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.GIGACHAT:
            case MODEL_PROTOCOL_PREFIX.DEEPSEEK:
                return data;
            default:
                logger.warn(`[OpenAI Converter] Unsupported target: ${targetProtocol}`);
                return data;
        }
    }

    convertStreamChunk(chunk: any, targetProtocol: string, model?: string, requestId?: string): any {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeStreamChunk(chunk, model);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiStreamChunk(chunk, model);
            case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
                return this.toOpenAIResponsesStreamChunk(chunk, model);
            case MODEL_PROTOCOL_PREFIX.GROK:
                return this.toGrokStreamChunk(chunk, model);
            default:
                logger.warn(`[OpenAI Converter] Unsupported stream target: ${targetProtocol}`);
                return chunk;
        }
    }

    convertModelList(data: any, targetProtocol: string): any {
        return data;
    }

    
    private toClaudeResponse(openaiResponse: any, model?: string): any {
        logger.info(`[OpenAI Converter] Converting OpenAI response to Claude format`);
        
        const message = openaiResponse.choices?.[0]?.message;
        const content: any[] = [];

        // Add text content if present
        if (message?.content) {
            content.push({
                type: 'text',
                text: message.content
            });
        }

        // Convert tool_calls to Claude tool_use format (new format)
        if (message?.tool_calls && Array.isArray(message.tool_calls)) {
            for (const toolCall of message.tool_calls) {
                content.push({
                    type: 'tool_use',
                    id: toolCall.id,
                    name: toolCall.function?.name,
                    input: typeof toolCall.function?.arguments === 'string' 
                        ? JSON.parse(toolCall.function.arguments)
                        : toolCall.function?.arguments
                });
            }
        }

        // Convert function_call to Claude tool_use format (old format, used by GigaChat)
        if (message?.function_call) {
            content.push({
                type: 'tool_use',
                id: `call_${Date.now()}`,
                name: message.function_call.name,
                input: typeof message.function_call.arguments === 'string'
                    ? JSON.parse(message.function_call.arguments)
                    : message.function_call.arguments
            });
        }

        return {
            id: openaiResponse.id || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content,
            model: model || openaiResponse.model || 'claude',
            stop_reason: (message?.tool_calls || message?.function_call) ? 'tool_use' : this.mapFinishReasonToClaude(openaiResponse.choices?.[0]?.finish_reason),
            stop_sequence: null,
            usage: {
                input_tokens: openaiResponse.usage?.prompt_tokens || 0,
                output_tokens: openaiResponse.usage?.completion_tokens || 0
            }
        };
    }

    
    private toGeminiResponse(openaiResponse: any, model?: string): any {
        logger.info(`[OpenAI Converter] Converting OpenAI response to Gemini format`);
        
        
        const content = openaiResponse.choices?.[0]?.message?.content || '';

        
        return {
            candidates: [
                {
                    content: {
                        parts: [
                            {
                                text: content
                            }
                        ],
                        role: 'model'
                    },
                    finishReason: this.mapFinishReasonToGemini(openaiResponse.choices?.[0]?.finish_reason),
                    index: 0
                }
            ],
            usageMetadata: {
                promptTokenCount: openaiResponse.usage?.prompt_tokens || 0,
                candidatesTokenCount: openaiResponse.usage?.completion_tokens || 0,
                totalTokenCount: openaiResponse.usage?.total_tokens || 0
            }
        };
    }

    
    private mapFinishReasonToClaude(openaiReason?: string): string {
        switch (openaiReason) {
            case 'stop':
                return 'end_turn';
            case 'length':
                return 'max_tokens';
            case 'tool_calls':
            case 'function_call':
                return 'tool_use';
            case 'content_filter':
                return 'stop_sequence';
            default:
                return 'end_turn';
        }
    }

    
    private mapFinishReasonToGemini(openaiReason?: string): string {
        switch (openaiReason) {
            case 'stop':
                return 'STOP';
            case 'length':
                return 'MAX_TOKENS';
            case 'content_filter':
                return 'SAFETY';
            case 'tool_calls':
            case 'function_call':
                return 'STOP';
            default:
                return 'STOP';
        }
    }

    
    private toOpenAIResponsesResponse(data: any, model?: string): any {
        return data;
    }

    private toGrokResponse(data: any, model?: string): any {
        return data;
    }

    private toCodexRequest(data: any): any {
        return data;
    }

    private toGrokRequest(data: any): any {
        return data;
    }

    private toOpenAIResponsesRequest(data: any): any {
        return data;
    }

    
    private toClaudeRequest(openaiRequest: any): any {
        const messages = openaiRequest.messages || [];
        
        
        const systemMessages = messages.filter((m: any) => m.role === 'system');
        const nonSystemMessages = messages.filter((m: any) => m.role !== 'system');
        
        const systemInstruction = systemMessages.map((m: any) => m.content).join('\n');

        
        const claudeMessages = nonSystemMessages.map((message: any) => {
            const role = message.role === 'assistant' ? 'assistant' : 'user';
            
            
            if (typeof message.content === 'string') {
                return {
                    role,
                    content: message.content
                };
            }
            
            
            if (Array.isArray(message.content)) {
                const content = message.content.map((item: any) => {
                    if (item.type === 'text') {
                        return { type: 'text', text: item.text };
                    }
                    if (item.type === 'image_url') {
                        
                        const imageUrl = typeof item.image_url === 'string' 
                            ? item.image_url 
                            : item.image_url.url;
                        
                        if (imageUrl.startsWith('data:')) {
                            const [header, data] = imageUrl.split(',');
                            const mediaType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
                            return {
                                type: 'image',
                                source: {
                                    type: 'base64',
                                    media_type: mediaType,
                                    data: data
                                }
                            };
                        }
                    }
                    return item;
                });
                
                return { role, content };
            }
            
            return { role, content: message.content };
        });

        
        const claudeRequest: any = {
            model: openaiRequest.model,
            messages: claudeMessages,
            max_tokens: openaiRequest.max_tokens || 4096,
        };

        if (systemInstruction) {
            claudeRequest.system = systemInstruction;
        }

        if (openaiRequest.temperature !== undefined) {
            claudeRequest.temperature = openaiRequest.temperature;
        }

        if (openaiRequest.top_p !== undefined) {
            claudeRequest.top_p = openaiRequest.top_p;
        }

        if (openaiRequest.stream !== undefined) {
            claudeRequest.stream = openaiRequest.stream;
        }

        return claudeRequest;
    }

    
    private toGeminiRequest(openaiRequest: any): any {
        const messages = openaiRequest.messages || [];
        
        
        const systemMessages = messages.filter((m: any) => m.role === 'system');
        const nonSystemMessages = messages.filter((m: any) => m.role !== 'system');
        
        const systemInstruction = systemMessages.map((m: any) => m.content).join('\n');

        
        const geminiContents = nonSystemMessages.map((message: any) => {
            const role = message.role === 'assistant' ? 'model' : 'user';
            
            
            if (typeof message.content === 'string') {
                return {
                    role,
                    parts: [{ text: message.content }]
                };
            }
            
            
            if (Array.isArray(message.content)) {
                const parts = message.content.map((item: any) => {
                    if (item.type === 'text') {
                        return { text: item.text };
                    }
                    if (item.type === 'image_url') {
                        
                        const imageUrl = typeof item.image_url === 'string' 
                            ? item.image_url 
                            : item.image_url.url;
                        
                        if (imageUrl.startsWith('data:')) {
                            const [header, data] = imageUrl.split(',');
                            const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg';
                            return {
                                inlineData: {
                                    mimeType,
                                    data
                                }
                            };
                        }
                    }
                    return item;
                });
                
                return { role, parts };
            }
            
            return {
                role,
                parts: [{ text: String(message.content) }]
            };
        });

        
        const geminiRequest: any = {
            contents: geminiContents,
        };

        if (systemInstruction) {
            geminiRequest.systemInstruction = {
                parts: [{ text: systemInstruction }]
            };
        }

        
        const generationConfig: any = {};

        if (openaiRequest.max_tokens !== undefined) {
            generationConfig.maxOutputTokens = openaiRequest.max_tokens;
        }

        if (openaiRequest.temperature !== undefined) {
            generationConfig.temperature = openaiRequest.temperature;
        }

        if (openaiRequest.top_p !== undefined) {
            generationConfig.topP = openaiRequest.top_p;
        }

        if (Object.keys(generationConfig).length > 0) {
            geminiRequest.generationConfig = generationConfig;
        }

        return geminiRequest;
    }

    
    private toClaudeStreamChunk(openaiChunk: any, model?: string): any {
        if (!openaiChunk) return null;

        
        if (typeof openaiChunk === 'object' && !Array.isArray(openaiChunk)) {
            const choice = openaiChunk.choices?.[0];
            if (!choice) {
                return null;
            }

            const delta = choice.delta;
            const finishReason = choice.finish_reason;
            const events = [];

            
            if (delta?.reasoning_content) {
                events.push({
                    type: 'content_block_delta',
                    index: 0,
                    delta: {
                        type: 'thinking_delta',
                        thinking: delta.reasoning_content
                    }
                });
            }

            
            if (delta?.content) {
                events.push({
                    type: 'content_block_delta',
                    index: 0,
                    delta: {
                        type: 'text_delta',
                        text: delta.content
                    }
                });
            }

            
            if (finishReason) {
                const stopReason = finishReason === 'stop' ? 'end_turn' :
                    finishReason === 'length' ? 'max_tokens' :
                    'end_turn';

                events.push({
                    type: 'content_block_stop',
                    index: 0
                });

                events.push({
                    type: 'message_delta',
                    delta: {
                        stop_reason: stopReason,
                        stop_sequence: null
                    },
                    usage: {
                        input_tokens: openaiChunk.usage?.prompt_tokens || 0,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: openaiChunk.usage?.prompt_tokens_details?.cached_tokens || 0,
                        output_tokens: openaiChunk.usage?.completion_tokens || 0
                    }
                });

                events.push({
                    type: 'message_stop'
                });
            }

            return events.length > 0 ? events : null;
        }

        
        if (typeof openaiChunk === 'string') {
            return {
                type: 'content_block_delta',
                index: 0,
                delta: {
                    type: 'text_delta',
                    text: openaiChunk
                }
            };
        }

        return null;
    }

    private toGeminiStreamChunk(chunk: any, model?: string): any {
        
        return chunk;
    }

    private toOpenAIResponsesStreamChunk(chunk: any, model?: string): any {
        
        return chunk;
    }

    private toGrokStreamChunk(chunk: any, model?: string): any {
        
        return chunk;
    }
}
