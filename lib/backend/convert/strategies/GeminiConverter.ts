/**
 * Gemini Converter (simplified port from GeminiConverter.js)
 * Handles conversions between Gemini and other protocols
 */

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
                return data; // No conversion needed
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

    /**
     * Convert Gemini request to OpenAI format (точь-в-точь как в оригинале)
     */
    private toOpenAIRequest(geminiRequest: any): any {
        const messages: any[] = [];

        // Add system instruction if present (точь-в-точь как в оригинале)
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

        // Convert Gemini contents to OpenAI messages (точь-в-точь как в оригинале)
        if (geminiRequest.contents) {
            for (const content of geminiRequest.contents) {
                const role = content.role === 'model' ? 'assistant' : 'user';
                
                // Convert parts to OpenAI content
                if (content.parts && content.parts.length === 1 && content.parts[0].text) {
                    // Simple text message
                    messages.push({
                        role,
                        content: content.parts[0].text
                    });
                } else if (content.parts) {
                    // Multimodal message
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

        // Build OpenAI request (точь-в-точь как в оригинале)
        const openaiRequest: any = {
            model: geminiRequest.model || 'gemini',
            messages,
        };

        // Map generation config (точь-в-точь как в оригинале)
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

    /**
     * Convert Gemini response to OpenAI format (точь-в-точь как в оригинале)
     */
    private toOpenAIResponse(geminiResponse: any, model?: string): any {
        // Extract text from first candidate (точь-в-точь как в оригинале)
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

        // Build OpenAI response (точь-в-точь как в оригинале)
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

    /**
     * Convert Gemini stream chunk to OpenAI format (точь-в-точь как в оригинале)
     */
    private toOpenAIStreamChunk(geminiChunk: any, model?: string): any {
        // Extract text from first candidate (точь-в-точь как в оригинале)
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

    /**
     * Map Gemini finish reason to OpenAI format (точь-в-точь как в оригинале)
     */
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

    /**
     * Convert Gemini request to Claude format
     */
    private toClaudeRequest(geminiRequest: any): any {
        // TODO: Implement Gemini -> Claude conversion
        return geminiRequest;
    }
}
