

import { BaseConverter } from '../BaseConverter';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/common';
import logger from '../../utils/logger';

export class ClaudeConverter extends BaseConverter {
    constructor() {
        super('claude');
    }

    convertRequest(data: any, targetProtocol: string): any {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIRequest(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiRequest(data);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return data; 
            default:
                logger.warn(`[Claude Converter] Unsupported target: ${targetProtocol}`);
                return data;
        }
    }

    convertResponse(data: any, targetProtocol: string, model?: string): any {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIResponse(data, model);
            default:
                return data;
        }
    }

    convertStreamChunk(chunk: any, targetProtocol: string, model?: string, requestId?: string): any {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIStreamChunk(chunk, model);
            default:
                return chunk;
        }
    }

    convertModelList(data: any, targetProtocol: string): any {
        return data;
    }

    
    private toOpenAIRequest(claudeRequest: any): any {
        const messages: any[] = [];

        
        if (claudeRequest.system) {
            messages.push({
                role: 'system',
                content: claudeRequest.system
            });
        }

        
        if (claudeRequest.messages) {
            for (const message of claudeRequest.messages) {
                const role = message.role === 'assistant' ? 'assistant' : 'user';
                
                
                if (typeof message.content === 'string') {
                    messages.push({
                        role,
                        content: message.content
                    });
                    continue;
                }
                
                
                if (Array.isArray(message.content)) {
                    const content = message.content.map((item: any) => {
                        if (item.type === 'text') {
                            return { type: 'text', text: item.text };
                        }
                        if (item.type === 'image') {
                            
                            if (item.source?.type === 'base64') {
                                return {
                                    type: 'image_url',
                                    image_url: {
                                        url: `data:${item.source.media_type};base64,${item.source.data}`
                                    }
                                };
                            }
                        }
                        return item;
                    });
                    
                    messages.push({ role, content });
                }
            }
        }

        
        const openaiRequest: any = {
            model: claudeRequest.model,
            messages,
        };

        if (claudeRequest.max_tokens !== undefined) {
            openaiRequest.max_tokens = claudeRequest.max_tokens;
        }

        if (claudeRequest.temperature !== undefined) {
            openaiRequest.temperature = claudeRequest.temperature;
        }

        if (claudeRequest.top_p !== undefined) {
            openaiRequest.top_p = claudeRequest.top_p;
        }

        if (claudeRequest.stream !== undefined) {
            openaiRequest.stream = claudeRequest.stream;
        }

        return openaiRequest;
    }

    
    private toOpenAIResponse(claudeResponse: any, model?: string): any {
        
        let content = '';
        if (Array.isArray(claudeResponse.content)) {
            content = claudeResponse.content
                .filter((item: any) => item.type === 'text')
                .map((item: any) => item.text)
                .join('');
        } else if (typeof claudeResponse.content === 'string') {
            content = claudeResponse.content;
        }

        
        return {
            id: claudeResponse.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || claudeResponse.model || 'claude',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content
                    },
                    finish_reason: this.mapFinishReason(claudeResponse.stop_reason)
                }
            ],
            usage: {
                prompt_tokens: claudeResponse.usage?.input_tokens || 0,
                completion_tokens: claudeResponse.usage?.output_tokens || 0,
                total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
            }
        };
    }

    
    private toOpenAIStreamChunk(claudeChunk: any, model?: string): any {
        
        if (claudeChunk.type === 'content_block_delta') {
            return {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model || 'claude',
                choices: [
                    {
                        index: 0,
                        delta: {
                            content: claudeChunk.delta?.text || ''
                        },
                        finish_reason: null
                    }
                ]
            };
        }

        if (claudeChunk.type === 'message_delta') {
            return {
                id: `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: model || 'claude',
                choices: [
                    {
                        index: 0,
                        delta: {},
                        finish_reason: this.mapFinishReason(claudeChunk.delta?.stop_reason)
                    }
                ]
            };
        }

        return null; 
    }

    
    private mapFinishReason(claudeReason?: string): string {
        switch (claudeReason) {
            case 'end_turn':
                return 'stop';
            case 'max_tokens':
                return 'length';
            case 'tool_use':
                return 'tool_calls';
            default:
                return 'stop';
        }
    }

    
    private toGeminiRequest(claudeRequest: any): any {
        
        return claudeRequest;
    }
}
