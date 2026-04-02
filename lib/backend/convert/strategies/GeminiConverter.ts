

import { BaseConverter } from '../BaseConverter';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/common';
import logger from '../../utils/logger';

export class GeminiConverter extends BaseConverter {
    constructor() {
        super('gemini');
    }

    convertRequest(data: any, targetProtocol: string): any {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIRequest(data);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeRequest(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return data; 
            default:
                logger.warn(`[Gemini Converter] Unsupported target: ${targetProtocol}`);
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

    
    private toOpenAIRequest(geminiRequest: any): any {
        const messages: any[] = [];

        
        if (geminiRequest.systemInstruction) {
            const systemText = geminiRequest.systemInstruction.parts
                ?.map((p: any) => p.text)
                .join('\n') || '';
            
            if (systemText) {
                messages.push({
                    role: 'system',
                    content: systemText
                });
            }
        }

        
        if (geminiRequest.contents) {
            for (const content of geminiRequest.contents) {
                const role = content.role === 'model' ? 'assistant' : 'user';
                
                
                if (content.parts && content.parts.length === 1 && content.parts[0].text) {
                    
                    messages.push({
                        role,
                        content: content.parts[0].text
                    });
                } else if (content.parts) {
                    
                    const contentArray = content.parts.map((part: any) => {
                        if (part.text) {
                            return { type: 'text', text: part.text };
                        }
                        if (part.inlineData) {
                            return {
                                type: 'image_url',
                                image_url: {
                                    url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
                                }
                            };
                        }
                        return part;
                    });
                    
                    messages.push({ role, content: contentArray });
                }
            }
        }

        
        const openaiRequest: any = {
            model: geminiRequest.model || 'gemini',
            messages,
        };

        
        if (geminiRequest.generationConfig) {
            const config = geminiRequest.generationConfig;
            
            if (config.maxOutputTokens !== undefined) {
                openaiRequest.max_tokens = config.maxOutputTokens;
            }
            
            if (config.temperature !== undefined) {
                openaiRequest.temperature = config.temperature;
            }
            
            if (config.topP !== undefined) {
                openaiRequest.top_p = config.topP;
            }
        }

        return openaiRequest;
    }

    
    private toOpenAIResponse(geminiResponse: any, model?: string): any {
        
        let content = '';
        if (geminiResponse.candidates && geminiResponse.candidates[0]) {
            const candidate = geminiResponse.candidates[0];
            if (candidate.content?.parts) {
                content = candidate.content.parts
                    .filter((p: any) => p.text)
                    .map((p: any) => p.text)
                    .join('');
            }
        }

        
        return {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model || 'gemini',
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content
                    },
                    finish_reason: this.mapFinishReason(geminiResponse.candidates?.[0]?.finishReason)
                }
            ],
            usage: {
                prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
                completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
                total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0
            }
        };
    }

    
    private toOpenAIStreamChunk(geminiChunk: any, model?: string): any {
        
        let content = '';
        let finishReason = null;
        
        if (geminiChunk.candidates && geminiChunk.candidates[0]) {
            const candidate = geminiChunk.candidates[0];
            
            if (candidate.content?.parts) {
                content = candidate.content.parts
                    .filter((p: any) => p.text)
                    .map((p: any) => p.text)
                    .join('');
            }
            
            if (candidate.finishReason) {
                finishReason = this.mapFinishReason(candidate.finishReason);
            }
        }

        return {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model || 'gemini',
            choices: [
                {
                    index: 0,
                    delta: {
                        content
                    },
                    finish_reason: finishReason
                }
            ]
        };
    }

    
    private mapFinishReason(geminiReason?: string): string {
        switch (geminiReason) {
            case 'STOP':
                return 'stop';
            case 'MAX_TOKENS':
                return 'length';
            case 'SAFETY':
                return 'content_filter';
            default:
                return 'stop';
        }
    }

    
    private toClaudeRequest(geminiRequest: any): any {
        
        return geminiRequest;
    }
}
