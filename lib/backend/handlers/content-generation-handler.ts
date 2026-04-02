/**
 * Universal API request handler (ported from aiclient-2-api)
 * Handles all API endpoints with provider rotation, conversion, and retry logic
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProviderPoolManager } from '@/lib/backend/services/provider-pool-manager';
import { getServiceAdapter } from '@/lib/backend/providers/adapter';
import { convertData } from '@/lib/backend/convert/convert';
import { getProtocolPrefix, ENDPOINT_TYPE, MODEL_PROTOCOL_PREFIX } from '@/lib/backend/utils/common';
import logger from '@/lib/backend/utils/logger';
import { loadConfig } from '@/lib/storage';

interface RetryContext {
    CONFIG: any;
    currentRetry: number;
    maxRetries: number;
    anyDataSent?: boolean;
    clientDisconnected?: { value: boolean };
}

/**
 * Handle content generation request (ported from common.js::handleContentGenerationRequest)
 */
export async function handleContentGenerationRequest(
    request: NextRequest,
    endpointType: string,
    providerOverride?: string // Провайдер из пути (точь-в-точь как в оригинале)
): Promise<NextResponse> {
    try {
        // Проверяем header от middleware
        if (!providerOverride) {
            providerOverride = request.headers.get('x-provider-override') || undefined;
        }
        // 1. Parse request body
        const originalRequestBody = await request.json();

        if (!originalRequestBody) {
            return NextResponse.json(
                { error: { message: 'Request body is missing' } },
                { status: 400 }
            );
        }

        // 2. Determine client provider from endpoint type (точь-в-точь как в оригинале)
        const clientProviderMap: Record<string, string> = {
            [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
            [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
            [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
            [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI,
        };

        const fromProvider = clientProviderMap[endpointType];

        if (!fromProvider) {
            return NextResponse.json(
                { error: { message: `Unsupported endpoint type: ${endpointType}` } },
                { status: 400 }
            );
        }

        // 3. Extract model and stream info (точь-в-точь как в оригинале)
        const { model, isStream } = extractModelAndStreamInfo(originalRequestBody, fromProvider);

        if (!model) {
            return NextResponse.json(
                { error: { message: 'Could not determine model from request' } },
                { status: 400 }
            );
        }

        logger.info(`[Content Generation] Model: ${model}, Stream: ${isStream}`);

        // 4. Get provider pool manager
        const poolManager = await getProviderPoolManager();
        const globalConfig = await loadConfig();

        // 5. Select provider for model (точь-в-точь как getApiServiceWithFallback)
        // Если указан providerOverride - используем только его (точь-в-точь как в оригинале)
        const result = providerOverride 
            ? await selectSpecificProvider(poolManager, globalConfig, providerOverride, model)
            : await selectProviderForModel(poolManager, globalConfig, model);

        if (!result) {
            return NextResponse.json(
                { error: { message: 'No healthy providers available' } },
                { status: 503 }
            );
        }

        const { providerType, providerConfig, serviceAdapter } = result;
        const toProvider = getProtocolPrefix(providerType);

        logger.info(`[Content Generation] Selected provider: ${providerType} (uuid: ${providerConfig.uuid})`);
        logger.info(`[Content Generation] Protocols: fromProvider=${fromProvider}, toProvider=${toProvider}`);

        // 6. Convert request if needed (точь-в-точь как в оригинале)
        let processedRequestBody = originalRequestBody;

        if (fromProvider !== toProvider) {
            logger.info(`[Request Convert] Converting from ${fromProvider} to ${toProvider}`);
            processedRequestBody = convertData(originalRequestBody, 'request', fromProvider, toProvider);
        } else {
            logger.info(`[Request Convert] No conversion needed`);
        }

        // 7. Create retry context (точь-в-точь как в оригинале)
        const retryContext: RetryContext = {
            CONFIG: { ...globalConfig, MODEL_PROVIDER: providerType },
            currentRetry: 0,
            maxRetries: globalConfig.CREDENTIAL_SWITCH_MAX_RETRIES || 5
        };

        // 8. Handle request (stream or unary)
        if (isStream) {
            return await handleStreamRequest(
                serviceAdapter,
                model,
                processedRequestBody,
                fromProvider,
                toProvider,
                poolManager,
                providerType,
                providerConfig.uuid,
                providerConfig.customName,
                retryContext
            );
        } else {
            return await handleUnaryRequest(
                serviceAdapter,
                model,
                processedRequestBody,
                fromProvider,
                toProvider,
                poolManager,
                providerType,
                providerConfig.uuid,
                providerConfig.customName,
                retryContext
            );
        }
    } catch (error: any) {
        logger.error(`[Content Generation] Error: ${error.message}`);
        return NextResponse.json(
            { error: { message: error.message || 'Internal server error' } },
            { status: 500 }
        );
    }
}

/**
 * Handle unary (non-streaming) request (ported from common.js::handleUnaryRequest)
 */
async function handleUnaryRequest(
    service: any,
    model: string,
    requestBody: any,
    fromProvider: string,
    toProvider: string,
    poolManager: any,
    providerType: string,
    uuid: string,
    customName: string | undefined,
    retryContext: RetryContext
): Promise<NextResponse> {
    const { currentRetry, maxRetries, CONFIG } = retryContext;

    try {
        // Make request to provider (точь-в-точь как в оригинале)
        requestBody.model = model;
        const nativeResponse = await service.generateContent(model, requestBody);

        // Convert response if needed (точь-в-точь как в оригинале)
        let clientResponse = nativeResponse;
        const needsConversion = fromProvider !== toProvider;

        if (needsConversion) {
            logger.info(`[Response Convert] Converting from ${toProvider} to ${fromProvider}`);
            clientResponse = convertData(nativeResponse, 'response', toProvider, fromProvider, model);
        }

        // Mark provider healthy and increment usage (точь-в-точь как в оригинале)
        const customNameDisplay = customName ? `, ${customName}` : '';
        logger.info(`[Provider Pool] Increasing usage count for ${providerType} (${uuid}${customNameDisplay})`);
        await poolManager.markProviderHealthy(providerType, uuid, false, null);

        return NextResponse.json(clientResponse);

    } catch (error: any) {
        logger.error(`[Unary Request] Error: ${error.message}`);

        const status = error.response?.status || error.statusCode;
        const skipErrorCount = error.skipErrorCount === true;
        const shouldSwitchCredential = error.shouldSwitchCredential === true;
        let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;

        // Mark provider unhealthy (точь-в-точь как в оригинале)
        if (!credentialMarkedUnhealthy && !skipErrorCount) {
            if (status === 400) {
                logger.info(`[Provider Pool] Skipping unhealthy marking due to status 400`);
            } else {
                logger.info(`[Provider Pool] Marking ${providerType} as unhealthy (status: ${status || 'unknown'})`);
                await poolManager.markProviderUnhealthy(providerType, uuid, error.message);
                credentialMarkedUnhealthy = true;
            }
        }

        if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
            credentialMarkedUnhealthy = true;
        }

        // Retry with different credential (точь-в-точь как в оригинале)
        if (credentialMarkedUnhealthy && currentRetry < maxRetries) {
            const randomDelay = Math.floor(Math.random() * 10000);
            logger.info(`[Unary Retry] Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries}`);
            await new Promise(resolve => setTimeout(resolve, randomDelay));

            try {
                const newResult = await selectProviderForModel(poolManager, CONFIG, model);

                if (newResult && newResult.serviceAdapter) {
                    logger.info(`[Unary Retry] Switched to: ${newResult.providerConfig.uuid}`);

                    const newRetryContext: RetryContext = {
                        ...retryContext,
                        currentRetry: currentRetry + 1
                    };

                    return await handleUnaryRequest(
                        newResult.serviceAdapter,
                        model,
                        requestBody,
                        fromProvider,
                        getProtocolPrefix(newResult.providerType),
                        poolManager,
                        newResult.providerType,
                        newResult.providerConfig.uuid,
                        newResult.providerConfig.customName,
                        newRetryContext
                    );
                } else {
                    logger.info(`[Unary Retry] No healthy credential available`);
                }
            } catch (retryError: any) {
                logger.error(`[Unary Retry] Failed: ${retryError.message}`);
            }
        }

        // Return error response (точь-в-точь как в оригинале)
        const errorResponse = createErrorResponse(error, fromProvider);
        return NextResponse.json(errorResponse, { status: status || 500 });
    }
}

/**
 * Handle streaming request (ported from common.js::handleStreamRequest)
 * Точь-в-точь как в оригинале, построчно
 */
async function handleStreamRequest(
    service: any,
    model: string,
    requestBody: any,
    fromProvider: string,
    toProvider: string,
    poolManager: any,
    providerType: string,
    uuid: string,
    customName: string | undefined,
    retryContext: RetryContext
): Promise<NextResponse> {
    let fullResponseText = '';
    let anyDataSent = false;
    
    const { currentRetry, maxRetries, CONFIG } = retryContext;
    const isRetry = currentRetry > 0;
    
    // Используем общий clientDisconnected (точь-в-точь как в оригинале)
    let clientDisconnected = retryContext.clientDisconnected || { value: false };
    if (!isRetry) {
        clientDisconnected = { value: false };
    }

    let hasToolCall = false;
    let hasMessageStop = false;

    const encoder = new TextEncoder();
    
    const stream = new ReadableStream({
        async start(controller) {
            try {
                // The service returns a stream in its native format (toProvider)
                const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
                requestBody.model = model;
                const nativeStream = await service.generateContentStream(model, requestBody);
                const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || 
                                getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
                
                // Уникальный ID для изоляции состояния конвертера (точь-в-точь как в оригинале)
                const streamRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

                for await (const nativeChunk of nativeStream) {
                    // Проверка отключения клиента (точь-в-точь как в оригинале)
                    if (clientDisconnected.value) {
                        logger.info('[Stream] Stopping iteration due to client disconnect');
                        break;
                    }
                    
                    // Extract text for logging (точь-в-точь как в оригинале)
                    const chunkText = extractResponseText(nativeChunk, toProvider);
                    if (chunkText && !Array.isArray(chunkText)) {
                        fullResponseText += chunkText;
                    }

                    // Convert chunk if needed (точь-в-точь как в оригинале)
                    const chunkToSend = needsConversion
                        ? convertData(nativeChunk, 'streamChunk', toProvider, fromProvider, model, streamRequestId)
                        : nativeChunk;

                    if (!chunkToSend) {
                        continue;
                    }

                    // Обработка массива или объекта (точь-в-точь как в оригинале)
                    const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];

                    for (const chunk of chunksToSend) {
                        if (clientDisconnected.value) {
                            break;
                        }
                        
                        // Отслеживание tool calls (точь-в-точь как в оригинале)
                        if (chunk.choices?.[0]?.delta?.tool_calls || chunk.choices?.[0]?.finish_reason === 'tool_calls') {
                            hasToolCall = true;
                        }
                        if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
                            hasToolCall = true;
                        }
                        if (chunk.type === 'message_delta' && (chunk.delta?.stop_reason === 'tool_use' || chunk.stop_reason === 'tool_use')) {
                            hasToolCall = true;
                        }
                        if (chunk.candidates?.[0]?.content?.parts?.some((p: any) => p.functionCall)) {
                            hasToolCall = true;
                        }

                        // Исправление finish_reason для tool calls (точь-в-точь как в оригинале)
                        if (hasToolCall && needsConversion) {
                            if (chunk.choices?.[0]?.finish_reason === 'stop') {
                                chunk.choices[0].finish_reason = 'tool_calls';
                            } else if (chunk.type === 'message_delta' && chunk.delta?.stop_reason === 'end_turn') {
                                chunk.delta.stop_reason = 'tool_use';
                            } else if (chunk.candidates?.[0]?.finishReason === 'STOP' || chunk.candidates?.[0]?.finishReason === 'stop') {
                                chunk.candidates[0].finishReason = 'TOOL_CALLS';
                            }
                        }

                        // Отслеживание окончания (точь-в-точь как в оригинале)
                        if (
                            chunk?.choices?.some((choice: any) => choice?.finish_reason) ||
                            chunk?.type === 'message_stop' ||
                            chunk?.type === 'done' ||
                            chunk?.candidates?.some((candidate: any) => candidate?.finishReason)
                        ) {
                            hasMessageStop = true;
                        }

                        // Отправка event для Claude/OpenAI Responses (точь-в-точь как в оригинале)
                        if (addEvent) {
                            try {
                                controller.enqueue(encoder.encode(`event: ${chunk.type}\n`));
                                anyDataSent = true;
                            } catch (writeErr) {
                                logger.error('[Stream] Failed to write event:', writeErr);
                                clientDisconnected.value = true;
                                break;
                            }
                        }

                        // Отправка data (точь-в-точь как в оригинале)
                        try {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                            anyDataSent = true;
                        } catch (writeErr) {
                            logger.error('[Stream] Failed to write data:', writeErr);
                            clientDisconnected.value = true;
                            break;
                        }
                    }
                }

                // Успешное завершение (точь-в-точь как в оригинале)
                if (poolManager && uuid) {
                    const customNameDisplay = customName ? `, ${customName}` : '';
                    logger.info(`[Provider Pool] Increasing usage count for ${providerType} (${uuid}${customNameDisplay}) after successful stream request`);
                    await poolManager.markProviderHealthy(providerType, uuid, false, null);
                }

                // Отправка завершающего маркера (точь-в-точь как в оригинале)
                if (!clientDisconnected.value && !isRetry) {
                    const clientProtocol = getProtocolPrefix(fromProvider);
                    
                    if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI) {
                        if (!hasMessageStop) {
                            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        }
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
                        if (!hasMessageStop) {
                            controller.enqueue(encoder.encode('event: message_stop\n'));
                            controller.enqueue(encoder.encode('data: {"type":"message_stop"}\n\n'));
                        }
                    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
                        if (!hasMessageStop) {
                            controller.enqueue(encoder.encode('data: {"candidates":[{"finishReason":"STOP"}]}\n\n'));
                        }
                    }
                }

                controller.close();

            } catch (error: any) {
                logger.error('[Stream] Error during stream processing:', error.stack || error.message);
                
                // Если клиент отключился (точь-в-точь как в оригинале)
                if (clientDisconnected.value) {
                    logger.info('[Stream] Skipping error response due to client disconnect');
                    controller.close();
                    return;
                }
                
                // Если данные уже отправлены - нельзя retry (точь-в-точь как в оригинале)
                if (anyDataSent) {
                    logger.info('[Stream Retry] Cannot retry: data already sent to client');
                    const errorPayload = createStreamErrorResponse(error, fromProvider);
                    controller.enqueue(encoder.encode(errorPayload));
                    controller.close();
                    return;
                }
                
                const status = error.response?.status;
                const skipErrorCount = error.skipErrorCount === true;
                const shouldSwitchCredential = error.shouldSwitchCredential === true;
                let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;
                
                // Маркировка провайдера как нездорового (точь-в-точь как в оригинале)
                if (!credentialMarkedUnhealthy && !skipErrorCount && poolManager && uuid) {
                    if (error.response?.status === 400) {
                        logger.info(`[Provider Pool] Skipping unhealthy marking for ${providerType} (${uuid}) due to status 400 (client error)`);
                    } else {
                        logger.info(`[Provider Pool] Marking ${providerType} as unhealthy due to stream error (status: ${status || 'unknown'})`);
                        await poolManager.markProviderUnhealthy(providerType, uuid, error.message);
                        credentialMarkedUnhealthy = true;
                    }
                }
                
                if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
                    credentialMarkedUnhealthy = true;
                }
                
                // Retry с новым провайдером (точь-в-точь как в оригинале)
                if (credentialMarkedUnhealthy && currentRetry < maxRetries && poolManager && CONFIG) {
                    const randomDelay = Math.floor(Math.random() * 10000);
                    logger.info(`[Stream Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
                    await new Promise(resolve => setTimeout(resolve, randomDelay));
                    
                    try {
                        const result = await selectProviderForModel(poolManager, CONFIG, model);
                        
                        if (result) {
                            logger.info(`[Stream Retry] Switched to new credential: ${result.providerConfig.uuid} (provider: ${result.providerType})`);
                            logger.warn('[Stream Retry] Retry in Next.js streams not fully implemented');
                        } else {
                            logger.info('[Stream Retry] No healthy credential available for retry.');
                        }
                    } catch (retryError: any) {
                        logger.error('[Stream Retry] Failed to get alternative service:', retryError.message);
                    }
                }

                // Отправка ошибки (точь-в-точь как в оригинале)
                const errorPayload = createStreamErrorResponse(error, fromProvider);
                controller.enqueue(encoder.encode(errorPayload));
                controller.close();
            } finally {
                // Освобождение слота (точь-в-точь как в оригинале)
                if (poolManager && uuid) {
                    await poolManager.releaseSlot(providerType, uuid);
                }
            }
        }
    });

    return new NextResponse(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}

/**
 * Create stream error response (ported from common.js::createStreamErrorResponse)
 */
function createStreamErrorResponse(error: any, fromProvider: string): string {
    const clientProtocol = getProtocolPrefix(fromProvider);
    const errorMessage = error.message || 'Internal server error';
    
    if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI) {
        return `data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`;
    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
        return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: errorMessage } })}\n\n`;
    } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
        return `data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`;
    }
    
    return `data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`;
}

/**
 * Extract response text (ported from common.js::extractResponseText)
 */
function extractResponseText(response: any, provider: string): string {
    const protocol = getProtocolPrefix(provider);
    
    if (protocol === MODEL_PROTOCOL_PREFIX.OPENAI) {
        return response.choices?.[0]?.delta?.content || response.choices?.[0]?.message?.content || '';
    } else if (protocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
        if (response.type === 'content_block_delta') {
            return response.delta?.text || '';
        }
        if (Array.isArray(response.content)) {
            return response.content.filter((item: any) => item.type === 'text').map((item: any) => item.text).join('');
        }
        return '';
    } else if (protocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
        return response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }
    
    return '';
}

/**
        return NextResponse.json(errorResponse, { status: status || 500 });
    }
}

/**
 * Extract model and stream info from request (ported from common.js::_extractModelAndStreamInfo)
 */
function extractModelAndStreamInfo(requestBody: any, fromProvider: string): { model: string; isStream: boolean } {
    // OpenAI format
    if (fromProvider === MODEL_PROTOCOL_PREFIX.OPENAI || fromProvider === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
        return {
            model: requestBody.model || '',
            isStream: requestBody.stream === true
        };
    }

    // Claude format
    if (fromProvider === MODEL_PROTOCOL_PREFIX.CLAUDE) {
        return {
            model: requestBody.model || '',
            isStream: requestBody.stream === true
        };
    }

    // Gemini format
    if (fromProvider === MODEL_PROTOCOL_PREFIX.GEMINI) {
        return {
            model: requestBody.model || '',
            isStream: false // Gemini uses different endpoint for streaming
        };
    }

    return { model: '', isStream: false };
}

/**
 * Select provider for model (ported from service-manager.js::getApiServiceWithFallback)
 */
async function selectProviderForModel(poolManager: any, globalConfig: any, model: string) {
    const providerTypes = poolManager.getProviderTypes();

    for (const providerType of providerTypes) {
        try {
            // Передаем модель в selectProvider для фильтрации (точь-в-точь как в оригинале)
            const providerConfig = await poolManager.selectProvider(providerType, model, { skipUsageCount: false });

            if (!providerConfig) {
                continue;
            }

            const tempConfig = {
                ...globalConfig,
                ...providerConfig,
                MODEL_PROVIDER: providerType
            };

            const serviceAdapter = getServiceAdapter(tempConfig);

            return {
                providerType,
                providerConfig,
                serviceAdapter
            };
        } catch (error: any) {
            logger.warn(`[Provider Selection] Failed ${providerType}: ${error.message}`);
            continue;
        }
    }

    return null;
}

/**
 * Select specific provider (ported from request-handler.js path routing)
 * Используется когда провайдер указан в пути: /{provider}/v1/...
 */
async function selectSpecificProvider(poolManager: any, globalConfig: any, providerType: string, model: string) {
    try {
        logger.info(`[Provider Selection] Using specific provider from path: ${providerType}`);
        
        // Выбираем провайдер указанного типа (точь-в-точь как в оригинале)
        const providerConfig = await poolManager.selectProvider(providerType, model, { skipUsageCount: false });

        if (!providerConfig) {
            logger.warn(`[Provider Selection] No healthy providers for ${providerType}`);
            return null;
        }

        const tempConfig = {
            ...globalConfig,
            ...providerConfig,
            MODEL_PROVIDER: providerType
        };

        const serviceAdapter = getServiceAdapter(tempConfig);

        return {
            providerType,
            providerConfig,
            serviceAdapter
        };
    } catch (error: any) {
        logger.error(`[Provider Selection] Failed to select ${providerType}: ${error.message}`);
        return null;
    }
}

/**
 * Create error response in client format (ported from common.js::createErrorResponse)
 */
function createErrorResponse(error: any, fromProvider: string): any {
    const message = error.message || 'An error occurred';
    const status = error.response?.status || error.statusCode || 500;

    // OpenAI format
    if (fromProvider === MODEL_PROTOCOL_PREFIX.OPENAI || fromProvider === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {
        return {
            error: {
                message,
                type: 'api_error',
                code: status
            }
        };
    }

    // Claude format
    if (fromProvider === MODEL_PROTOCOL_PREFIX.CLAUDE) {
        return {
            type: 'error',
            error: {
                type: 'api_error',
                message
            }
        };
    }

    // Gemini format
    if (fromProvider === MODEL_PROTOCOL_PREFIX.GEMINI) {
        return {
            error: {
                code: status,
                message,
                status: 'FAILED_PRECONDITION'
            }
        };
    }

    return { error: { message } };
}
