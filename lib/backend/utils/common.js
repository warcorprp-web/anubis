import { promises as fs } from "fs";

import * as path from "path";

import * as http from "http";

import * as crypto from "crypto";

import logger from "./logger.js";

import { convertData, getOpenAIStreamChunkStop } from "../convert/convert.js";

import { ProviderStrategyFactory } from "./provider-strategies.js";

import { getPluginManager } from "../core/plugin-manager.js";

export const RETRYABLE_NETWORK_ERRORS = [ "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "EAI_AGAIN", "ECONNABORTED", "ESOCKETTIMEDOUT" ];

export function isRetryableNetworkError(error) {
  if (!error) return false;
  const errorCode = error.code || "";
  const errorMessage = error.message || "";
  return RETRYABLE_NETWORK_ERRORS.some(errId => errorCode === errId || errorMessage.includes(errId));
}

export const API_ACTIONS = {
  GENERATE_CONTENT: "generateContent",
  STREAM_GENERATE_CONTENT: "streamGenerateContent"
};

export const MODEL_PROTOCOL_PREFIX = {
  GEMINI: "gemini",
  OPENAI: "openai",
  OPENAI_RESPONSES: "openaiResponses",
  CLAUDE: "claude",
  CODEX: "codex",
  FORWARD: "forward",
  GROK: "grok"
};

export const MODEL_PROVIDER = {
  GEMINI_CLI: "gemini-cli-oauth",
  ANTIGRAVITY: "gemini-antigravity",
  OPENAI_CUSTOM: "openai-custom",
  OPENAI_CUSTOM_RESPONSES: "openaiResponses-custom",
  CLAUDE_CUSTOM: "claude-custom",
  KIRO_API: "claude-kiro-oauth",
  QWEN_API: "openai-qwen-oauth",
  IFLOW_API: "openai-iflow",
  CODEX_API: "openai-codex-oauth",
  FORWARD_API: "forward-api",
  GROK_CUSTOM: "grok-custom",
  AUTO: "auto"
};

export function getProtocolPrefix(provider) {
  if (provider === "openai-codex-oauth") {
    return "codex";
  }
  const hyphenIndex = provider.indexOf("-");
  if (hyphenIndex !== -1) {
    return provider.substring(0, hyphenIndex);
  }
  return provider;
}

export const ENDPOINT_TYPE = {
  OPENAI_CHAT: "openai_chat",
  OPENAI_RESPONSES: "openai_responses",
  GEMINI_CONTENT: "gemini_content",
  CLAUDE_MESSAGE: "claude_message",
  OPENAI_MODEL_LIST: "openai_model_list",
  GEMINI_MODEL_LIST: "gemini_model_list"
};

export const FETCH_SYSTEM_PROMPT_FILE = path.join(process.cwd(), "configs", "fetch_system_prompt.txt");

export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), "configs", "input_system_prompt.txt");

export function formatExpiryTime(expiryTimestamp) {
  if (!expiryTimestamp || typeof expiryTimestamp !== "number") return "No expiry date available";
  const diffMs = expiryTimestamp - Date.now();
  if (diffMs <= 0) return "Token has expired";
  let totalSeconds = Math.floor(diffMs / 1e3);
  const hours = Math.floor(totalSeconds / 3600);
  totalSeconds %= 3600;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const pad = num => String(num).padStart(2, "0");
  return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

export function formatLog(tag, message, data = null) {
  let logMessage = `[${tag}] ${message}`;
  if (data !== null && data !== undefined) {
    if (typeof data === "object") {
      const dataStr = Object.entries(data).map(([key, value]) => `${key}: ${value}`).join(", ");
      logMessage += ` | ${dataStr}`;
    } else {
      logMessage += ` | ${data}`;
    }
  }
  return logMessage;
}

export function formatExpiryLog(tag, expiryDate, nearMinutes) {
  const currentTime = Date.now();
  const nearMinutesInMillis = nearMinutes * 60 * 1e3;
  const thresholdTime = currentTime + nearMinutesInMillis;
  const isNearExpiry = expiryDate <= thresholdTime;
  const message = formatLog(tag, "Checking expiry date", {
    "Expiry date": expiryDate,
    "Current time": currentTime,
    [`${nearMinutes} minutes from now`]: thresholdTime,
    "Is near expiry": isNearExpiry
  });
  return {
    message: message,
    isNearExpiry: isNearExpiry
  };
}

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  let ip = forwarded ? forwarded.split(",")[0].trim() : req.socket.remoteAddress;
  if (ip && ip.includes("::ffff:")) {
    ip = ip.replace("::ffff:", "");
  }
  return ip || "unknown";
}

export function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
    });
    req.on("end", () => {
      if (!body) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON in request body."));
      }
    });
    req.on("error", err => {
      reject(err);
    });
  });
}

export async function logConversation(type, content, logMode, logFilename) {
  if (logMode === "none") return;
  if (!content) return;
  const timestamp = (new Date).toLocaleString();
  const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;
  if (logMode === "console") {
    logger.info(logEntry);
  } else if (logMode === "file") {
    try {
      await fs.appendFile(logFilename, logEntry);
    } catch (err) {
      logger.error(`[Error] Failed to write conversation log to ${logFilename}:`, err);
    }
  }
}

export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
  const authHeader = req.headers["authorization"];
  const queryKey = requestUrl.searchParams.get("key");
  const googApiKey = req.headers["x-goog-api-key"];
  const claudeApiKey = req.headers["x-api-key"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    if (token === REQUIRED_API_KEY) {
      return true;
    }
  }
  if (queryKey === REQUIRED_API_KEY) {
    return true;
  }
  if (googApiKey === REQUIRED_API_KEY) {
    return true;
  }
  if (claudeApiKey === REQUIRED_API_KEY) {
    return true;
  }
  logger.info(`[Auth] Unauthorized request denied. Bearer: "${authHeader ? "present" : "N/A"}", Query Key: "${queryKey}", x-goog-api-key: "${googApiKey}", x-api-key: "${claudeApiKey}"`);
  return false;
}

export async function handleUnifiedResponse(res, responsePayload, isStream) {
  if (isStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked"
    });
  } else {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
  }
  if (isStream) {} else {
    res.end(responsePayload);
  }
}

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
  let fullResponseText = "";
  let fullResponseJson = "";
  let fullOldResponseJson = "";
  let responseClosed = false;
  let anyDataSent = retryContext?.anyDataSent || false;
  const maxRetries = retryContext?.maxRetries ?? 5;
  const currentRetry = retryContext?.currentRetry ?? 0;
  const CONFIG = retryContext?.CONFIG;
  const isRetry = currentRetry > 0;
  let clientDisconnected = retryContext?.clientDisconnected || {
    value: false
  };
  if (!isRetry) {
    clientDisconnected = {
      value: false
    };
  }
  const onClientClose = () => {
    clientDisconnected.value = true;
    logger.info("[Stream] Client disconnected, stopping stream processing");
  };
  const onClientError = err => {
    clientDisconnected.value = true;
    logger.error("[Stream] Response stream error:", err.message);
  };
  if (!isRetry) {
    res.on("close", onClientClose);
    res.on("error", onClientError);
  }
  if (!isRetry) {
    await handleUnifiedResponse(res, "", true);
  }
  let hasToolCall = false;
  let hasMessageStop = false;
  try {
    const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
    requestBody.model = model;
    const nativeStream = await service.generateContentStream(model, requestBody);
    const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    const streamRequestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    for await (const nativeChunk of nativeStream) {
      if (clientDisconnected.value) {
        logger.info("[Stream] Stopping iteration due to client disconnect");
        break;
      }
      const chunkText = extractResponseText(nativeChunk, toProvider);
      if (chunkText && !Array.isArray(chunkText)) {
        fullResponseText += chunkText;
      }
      const chunkToSend = needsConversion ? convertData(nativeChunk, "streamChunk", toProvider, fromProvider, model, streamRequestId) : nativeChunk;
      if (CONFIG?._monitorRequestId) {
        try {
          const pluginManager = getPluginManager();
          await pluginManager.executeHook("onStreamChunk", {
            nativeChunk: nativeChunk,
            chunkToSend: chunkToSend,
            fromProvider: fromProvider,
            toProvider: toProvider,
            model: model,
            requestId: CONFIG._monitorRequestId
          });
        } catch (e) {}
      }
      if (!chunkToSend) {
        continue;
      }
      const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [ chunkToSend ];
      for (const chunk of chunksToSend) {
        if (clientDisconnected.value) {
          break;
        }
        if (chunk.choices?.[0]?.delta?.tool_calls || chunk.choices?.[0]?.finish_reason === "tool_calls") {
          hasToolCall = true;
        }
        if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
          hasToolCall = true;
        }
        if (chunk.type === "message_delta" && (chunk.delta?.stop_reason === "tool_use" || chunk.stop_reason === "tool_use")) {
          hasToolCall = true;
        }
        if (chunk.candidates?.[0]?.content?.parts?.some(p => p.functionCall)) {
          hasToolCall = true;
        }
        if (hasToolCall && needsConversion) {
          if (chunk.choices?.[0]?.finish_reason === "stop") {
            chunk.choices[0].finish_reason = "tool_calls";
          } else if (chunk.type === "message_delta" && chunk.delta?.stop_reason === "end_turn") {
            chunk.delta.stop_reason = "tool_use";
          } else if (chunk.candidates?.[0]?.finishReason === "STOP" || chunk.candidates?.[0]?.finishReason === "stop") {
            chunk.candidates[0].finishReason = "TOOL_CALLS";
          }
        }
        if (chunk?.choices?.some(choice => choice?.finish_reason) || chunk?.type === "message_stop" || chunk?.type === "done" || chunk?.candidates?.some(candidate => candidate?.finishReason)) {
          hasMessageStop = true;
        }
        if (addEvent) {
          if (!clientDisconnected.value && !res.writableEnded) {
            try {
              res.write(`event: ${chunk.type}\n`);
              anyDataSent = true;
            } catch (writeErr) {
              logger.error("[Stream] Failed to write event:", writeErr.message);
              clientDisconnected.value = true;
              break;
            }
          }
        }
        if (!clientDisconnected.value && !res.writableEnded) {
          try {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            anyDataSent = true;
          } catch (writeErr) {
            logger.error("[Stream] Failed to write data:", writeErr.message);
            clientDisconnected.value = true;
            break;
          }
        }
      }
    }
    if (providerPoolManager && pooluuid) {
      const customNameDisplay = customName ? `, ${customName}` : "";
      logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful stream request`);
      providerPoolManager.markProviderHealthy(toProvider, {
        uuid: pooluuid
      });
    }
  } catch (error) {
    logger.error("\n[Server] Error during stream processing:", error.stack);
    if (clientDisconnected.value) {
      logger.info("[Stream] Skipping error response due to client disconnect");
      responseClosed = true;
      return;
    }
    if (anyDataSent) {
      logger.info(`[Stream Retry] Cannot retry: data already sent to client`);
      const errorPayload = createStreamErrorResponse(error, fromProvider);
      if (!res.writableEnded) {
        try {
          res.write(errorPayload);
          res.end();
        } catch (writeErr) {
          logger.error("[Stream] Failed to write error response:", writeErr.message);
        }
      }
      responseClosed = true;
      return;
    }
    const status = error.response?.status;
    const skipErrorCount = error.skipErrorCount === true;
    const shouldSwitchCredential = error.shouldSwitchCredential === true;
    let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;
    if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
      if (error.response?.status === 400) {
        logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to status 400 (client error)`);
      } else {
        logger.info(`[Provider Pool] Marking ${toProvider} as unhealthy due to stream error (status: ${status || "unknown"})`);
        providerPoolManager.markProviderUnhealthy(toProvider, {
          uuid: pooluuid
        }, error.message);
        credentialMarkedUnhealthy = true;
      }
    }
    if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
      credentialMarkedUnhealthy = true;
    }
    if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
      const randomDelay = Math.floor(Math.random() * 1e4);
      logger.info(`[Stream Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      try {
        const {getApiServiceWithFallback: getApiServiceWithFallback} = await import("../services/service-manager.js");
        const result = await getApiServiceWithFallback(CONFIG, model, {
          acquireSlot: true
        });
        if (result && result.service) {
          logger.info(`[Stream Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);
          const newRetryContext = {
            ...retryContext,
            CONFIG: CONFIG,
            currentRetry: currentRetry + 1,
            maxRetries: maxRetries,
            clientDisconnected: clientDisconnected,
            anyDataSent: anyDataSent
          };
          return await handleStreamRequest(res, result.service, result.actualModel || model, requestBody, fromProvider, result.actualProviderType || toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, result.uuid, result.serviceConfig?.customName || customName, newRetryContext);
        } else {
          logger.info(`[Stream Retry] No healthy credential available for retry.`);
        }
      } catch (retryError) {
        logger.error(`[Stream Retry] Failed to get alternative service:`, retryError.message);
      }
    }
    const errorPayload = createStreamErrorResponse(error, fromProvider);
    if (!clientDisconnected.value && !res.writableEnded) {
      try {
        res.write(errorPayload);
        res.end();
      } catch (writeErr) {
        logger.error("[Stream] Failed to write error response:", writeErr.message);
      }
    }
    responseClosed = true;
  } finally {
    if (providerPoolManager && pooluuid) {
      providerPoolManager.releaseSlot(toProvider, pooluuid);
    }
    if (!isRetry) {
      res.off("close", onClientClose);
      res.off("error", onClientError);
    }
    if (!responseClosed && !clientDisconnected.value && !isRetry) {
      const clientProtocol = getProtocolPrefix(fromProvider);
      if (!res.writableEnded) {
        try {
          if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI) {
            if (!hasMessageStop) {
              res.write("data: [DONE]\n\n");
              hasMessageStop = true;
            }
          } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES) {} else if (clientProtocol === MODEL_PROTOCOL_PREFIX.CLAUDE) {
            if (!hasMessageStop) {
              res.write("event: message_stop\n");
              res.write('data: {"type":"message_stop"}\n\n');
              hasMessageStop = true;
            }
          } else if (clientProtocol === MODEL_PROTOCOL_PREFIX.GEMINI) {
            if (!hasMessageStop) {
              res.write('data: {"candidates":[{"finishReason":"STOP"}]}\n\n');
              hasMessageStop = true;
            }
          }
          res.end();
        } catch (writeErr) {
          logger.error("[Stream] Failed to write completion marker:", writeErr.message);
        }
      }
    }
    if (!isRetry) {
      await logConversation("output", fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    }
  }
}

export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, retryContext = null) {
  const maxRetries = retryContext?.maxRetries ?? 5;
  const currentRetry = retryContext?.currentRetry ?? 0;
  const CONFIG = retryContext?.CONFIG;
  try {
    const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider);
    requestBody.model = model;
    const nativeResponse = await service.generateContent(model, requestBody);
    const responseText = extractResponseText(nativeResponse, toProvider);
    let clientResponse = nativeResponse;
    if (needsConversion) {
      logger.info(`[Response Convert] Converting response from ${toProvider} to ${fromProvider}`);
      clientResponse = convertData(nativeResponse, "response", toProvider, fromProvider, model);
    }
    if (CONFIG?._monitorRequestId) {
      try {
        const pluginManager = getPluginManager();
        await pluginManager.executeHook("onUnaryResponse", {
          nativeResponse: nativeResponse,
          clientResponse: clientResponse,
          fromProvider: fromProvider,
          toProvider: toProvider,
          model: model,
          requestId: CONFIG._monitorRequestId
        });
      } catch (e) {}
    }
    await handleUnifiedResponse(res, JSON.stringify(clientResponse), false);
    await logConversation("output", responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    if (providerPoolManager && pooluuid) {
      const customNameDisplay = customName ? `, ${customName}` : "";
      logger.info(`[Provider Pool] Increasing usage count for ${toProvider} (${pooluuid}${customNameDisplay}) after successful unary request`);
      providerPoolManager.markProviderHealthy(toProvider, {
        uuid: pooluuid
      });
    }
  } catch (error) {
    logger.error("\n[Server] Error during unary processing:", error.stack);
    const status = error.response?.status;
    const skipErrorCount = error.skipErrorCount === true;
    const shouldSwitchCredential = error.shouldSwitchCredential === true;
    let credentialMarkedUnhealthy = error.credentialMarkedUnhealthy === true;
    if (!credentialMarkedUnhealthy && !skipErrorCount && providerPoolManager && pooluuid) {
      if (error.response?.status === 400) {
        logger.info(`[Provider Pool] Skipping unhealthy marking for ${toProvider} (${pooluuid}) due to status 400 (client error)`);
      } else {
        logger.info(`[Provider Pool] Marking ${toProvider} as unhealthy due to unary error (status: ${status || "unknown"})`);
        providerPoolManager.markProviderUnhealthy(toProvider, {
          uuid: pooluuid
        }, error.message);
        credentialMarkedUnhealthy = true;
      }
    }
    if (shouldSwitchCredential && !credentialMarkedUnhealthy) {
      credentialMarkedUnhealthy = true;
    }
    if (credentialMarkedUnhealthy && currentRetry < maxRetries && providerPoolManager && CONFIG) {
      const randomDelay = Math.floor(Math.random() * 1e4);
      logger.info(`[Unary Retry] Credential marked unhealthy. Waiting ${randomDelay}ms before retry ${currentRetry + 1}/${maxRetries} with different credential...`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      try {
        const {getApiServiceWithFallback: getApiServiceWithFallback} = await import("../services/service-manager.js");
        const result = await getApiServiceWithFallback(CONFIG, model, {
          acquireSlot: true
        });
        if (result && result.service) {
          logger.info(`[Unary Retry] Switched to new credential: ${result.uuid} (provider: ${result.actualProviderType})`);
          const newRetryContext = {
            ...retryContext,
            CONFIG: CONFIG,
            currentRetry: currentRetry + 1,
            maxRetries: maxRetries
          };
          return await handleUnaryRequest(res, result.service, result.actualModel || model, requestBody, fromProvider, result.actualProviderType || toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, result.uuid, result.serviceConfig?.customName || customName, newRetryContext);
        } else {
          logger.info(`[Unary Retry] No healthy credential available for retry.`);
        }
      } catch (retryError) {
        logger.error(`[Unary Retry] Failed to get alternative service:`, retryError.message);
      }
    }
    const errorResponse = createErrorResponse(error, fromProvider);
    await handleUnifiedResponse(res, JSON.stringify(errorResponse), false);
  } finally {
    if (providerPoolManager && pooluuid) {
      providerPoolManager.releaseSlot(toProvider, pooluuid);
    }
  }
}

export async function handleModelListRequest(req, res, service, endpointType, CONFIG, providerPoolManager, pooluuid) {
  try {
    const clientProviderMap = {
      [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
      [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI
    };
    const fromProvider = clientProviderMap[endpointType];
    if (!fromProvider) {
      throw new Error(`Unsupported endpoint type for model list: ${endpointType}`);
    }
    let clientModelList;
    if (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO && providerPoolManager) {
      logger.info(`[ModelList] Aggregating models for 'auto' mode...`);
      clientModelList = await providerPoolManager.getAllAvailableModels(endpointType);
    } else {
      const toProvider = CONFIG.MODEL_PROVIDER;
      let resolvedService = service;
      if (!resolvedService) {
        const {getApiService: getApiService} = await import("../services/service-manager.js");
        resolvedService = await getApiService(CONFIG, null, {
          skipUsageCount: true
        });
      }
      if (!resolvedService || typeof resolvedService.listModels !== "function") {
        throw new Error(`[ModelList] Service adapter is unavailable or does not implement listModels() for provider: ${toProvider}`);
      }
      const nativeModelList = await resolvedService.listModels();
      clientModelList = nativeModelList;
      if (!getProtocolPrefix(toProvider).includes(getProtocolPrefix(fromProvider))) {
        logger.info(`[ModelList Convert] Converting model list from ${toProvider} to ${fromProvider}`);
        clientModelList = convertData(nativeModelList, "modelList", toProvider, fromProvider);
      } else {
        logger.info(`[ModelList Convert] Model list format matches. No conversion needed.`);
      }
    }
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(clientModelList));
  } catch (error) {
    logger.error("\n[Server] Error during model list processing:", error.stack);
    handleError(res, error, CONFIG.MODEL_PROVIDER);
  }
}

export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, requestPath = null) {
  const originalRequestBody = await getRequestBody(req);
  if (!originalRequestBody) {
    throw new Error("Request body is missing for content generation.");
  }
  const clientProviderMap = {
    [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
    [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
    [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
    [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI
  };
  const fromProvider = clientProviderMap[endpointType];
  let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
  let actualUuid = pooluuid;
  if (!fromProvider) {
    throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
  }
  let {model: model, isStream: isStream} = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);
  if (!model) {
    throw new Error("Could not determine the model from the request.");
  }
  logger.info(`[Content Generation] Model: ${model}, Stream: ${isStream}`);
  let actualCustomName = CONFIG.customName;
  const shouldSelectByPool = providerPoolManager && (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO || CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]);
  if (!service || shouldSelectByPool) {
    const {getApiServiceWithFallback: getApiServiceWithFallback} = await import("../services/service-manager.js");
    const result = await getApiServiceWithFallback(CONFIG, model, {
      acquireSlot: shouldSelectByPool
    });
    service = result.service;
    toProvider = result.actualProviderType;
    actualUuid = result.uuid || pooluuid;
    actualCustomName = result.serviceConfig?.customName || CONFIG.customName;
    if (result.actualModel && result.actualModel !== model) {
      logger.info(`[Content Generation] Model Fallback: ${model} -> ${result.actualModel}`);
      model = result.actualModel;
    }
    if (result.isFallback) {
      logger.info(`[Content Generation] Fallback activated: ${CONFIG.MODEL_PROVIDER} -> ${toProvider} (uuid: ${actualUuid})`);
    } else {
      logger.info(`[Content Generation] Selected service adapter based on model: ${model}`);
    }
  }
  let processedRequestBody = originalRequestBody;
  if (CONFIG._monitorRequestId) {
    processedRequestBody._monitorRequestId = CONFIG._monitorRequestId;
  }
  if (CONFIG.requestBaseUrl) {
    processedRequestBody._requestBaseUrl = CONFIG.requestBaseUrl;
  }
  if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider)) {
    logger.info(`[Request Convert] Converting request from ${fromProvider} to ${toProvider}`);
    processedRequestBody = convertData(originalRequestBody, "request", fromProvider, toProvider);
  } else {
    logger.info(`[Request Convert] Request format matches backend provider. No conversion needed.`);
  }
  if (requestPath && toProvider === MODEL_PROVIDER.FORWARD_API) {
    logger.info(`[Forward API] Request path: ${requestPath}`);
    processedRequestBody.endpoint = requestPath;
  }
  processedRequestBody = await _applySystemPromptFromFile(CONFIG, processedRequestBody, toProvider);
  await _manageSystemPrompt(processedRequestBody, toProvider);
  const promptText = extractPromptText(processedRequestBody, toProvider);
  await logConversation("input", promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
  const credentialSwitchMaxRetries = CONFIG.CREDENTIAL_SWITCH_MAX_RETRIES || 5;
  const retryContext = providerPoolManager ? {
    CONFIG: CONFIG,
    currentRetry: 0,
    maxRetries: credentialSwitchMaxRetries
  } : null;
  if (isStream) {
    await handleStreamRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
  } else {
    await handleUnaryRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, retryContext);
  }
  try {
    const pluginManager = getPluginManager();
    await pluginManager.executeHook("onContentGenerated", {
      ...CONFIG,
      originalRequestBody: originalRequestBody,
      processedRequestBody: processedRequestBody,
      fromProvider: fromProvider,
      toProvider: toProvider,
      model: model,
      isStream: isStream
    });
  } catch (e) {}
}

function _extractModelAndStreamInfo(req, requestBody, fromProvider) {
  const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider));
  return strategy.extractModelAndStreamInfo(req, requestBody);
}

async function _applySystemPromptFromFile(config, requestBody, toProvider) {
  const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(toProvider));
  return strategy.applySystemPromptFromFile(config, requestBody);
}

export async function _manageSystemPrompt(requestBody, provider) {
  const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
  await strategy.manageSystemPrompt(requestBody);
}

export function extractResponseText(response, provider) {
  const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
  return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody, provider) {
  const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
  return strategy.extractPromptText(requestBody);
}

export function handleError(res, error, provider = null) {
  const statusCode = error.response?.status || error.statusCode || error.status || error.code || 500;
  let errorMessage = error.message;
  let suggestions = [];
  const hasOriginalMessage = error.message && error.message.trim() !== "";
  const providerSuggestions = _getProviderSpecificSuggestions(statusCode, provider);
  switch (statusCode) {
   case 401:
    errorMessage = "Authentication failed. Please check your credentials.";
    suggestions = providerSuggestions.auth;
    break;

   case 403:
    errorMessage = "Access forbidden. Insufficient permissions.";
    suggestions = providerSuggestions.permission;
    break;

   case 429:
    errorMessage = "Too many requests. Rate limit exceeded.";
    suggestions = providerSuggestions.rateLimit;
    break;

   case 500:
   case 502:
   case 503:
   case 504:
    errorMessage = "Server error occurred. This is usually temporary.";
    suggestions = providerSuggestions.serverError;
    break;

   default:
    if (statusCode >= 400 && statusCode < 500) {
      errorMessage = `Client error (${statusCode}): ${error.message}`;
      suggestions = providerSuggestions.clientError;
    } else if (statusCode >= 500) {
      errorMessage = `Server error (${statusCode}): ${error.message}`;
      suggestions = providerSuggestions.serverError;
    }
  }
  errorMessage = hasOriginalMessage ? error.message.trim() : errorMessage;
  logger.error(`\n[Server] Request failed (${statusCode}): ${errorMessage}`);
  if (suggestions.length > 0) {
    logger.error("[Server] Suggestions:");
    suggestions.forEach((suggestion, index) => {
      logger.error(`  ${index + 1}. ${suggestion}`);
    });
  }
  logger.error("[Server] Full error details:", error.stack);
  if (res.writableEnded || res.destroyed) {
    logger.warn("[Server] Response already ended or destroyed, skipping error response");
    return;
  }
  if (!res.headersSent) {
    res.writeHead(statusCode, {
      "Content-Type": "application/json"
    });
  }
  const errorPayload = {
    error: {
      message: errorMessage,
      code: statusCode,
      suggestions: suggestions,
      details: error.response?.data
    }
  };
  try {
    res.end(JSON.stringify(errorPayload));
  } catch (writeError) {
    logger.error("[Server] Failed to write error response:", writeError.message);
  }
}

function _getProviderSpecificSuggestions(statusCode, provider) {
  const protocolPrefix = provider ? getProtocolPrefix(provider) : null;
  const defaultSuggestions = {
    auth: [ "Verify your API key or credentials are valid", "Check if your credentials have expired", "Ensure the API key has the necessary permissions" ],
    permission: [ "Check if your account has the necessary permissions", "Verify the API endpoint is accessible with your credentials", "Contact your administrator if permissions are restricted" ],
    rateLimit: [ "The request has been automatically retried with exponential backoff", "If the issue persists, try reducing the request frequency", "Consider upgrading your API quota if available" ],
    serverError: [ "The request has been automatically retried", "If the issue persists, try again in a few minutes", "Check the service status page for outages" ],
    clientError: [ "Check your request format and parameters", "Verify the model name is correct", "Ensure all required fields are provided" ]
  };
  switch (protocolPrefix) {
   case MODEL_PROTOCOL_PREFIX.GEMINI:
    return {
      auth: [ "Verify your OAuth credentials are valid", "Try re-authenticating by deleting the credentials file", "Check if your Google Cloud project has the necessary permissions" ],
      permission: [ "Ensure your Google Cloud project has the Gemini API enabled", "Check if your account has the necessary permissions", "Verify the project ID is correct" ],
      rateLimit: [ "The request has been automatically retried with exponential backoff", "If the issue persists, try reducing the request frequency", "Consider upgrading your Google Cloud API quota" ],
      serverError: [ "The request has been automatically retried", "If the issue persists, try again in a few minutes", "Check Google Cloud status page for service outages" ],
      clientError: [ "Check your request format and parameters", "Verify the model name is a valid Gemini model", "Ensure all required fields are provided" ]
    };

   case MODEL_PROTOCOL_PREFIX.OPENAI:
   case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
    return {
      auth: [ "Verify your OpenAI API key is valid", "Check if your API key has expired or been revoked", "Ensure the API key is correctly formatted (starts with sk-)" ],
      permission: [ "Check if your OpenAI account has access to the requested model", "Verify your organization settings allow this operation", "Ensure you have sufficient credits in your account" ],
      rateLimit: [ "The request has been automatically retried with exponential backoff", "If the issue persists, try reducing the request frequency", "Consider upgrading your OpenAI usage tier for higher limits" ],
      serverError: [ "The request has been automatically retried", "If the issue persists, try again in a few minutes", "Check OpenAI status page (status.openai.com) for outages" ],
      clientError: [ "Check your request format and parameters", "Verify the model name is a valid OpenAI model", "Ensure the message format is correct (role and content fields)" ]
    };

   case MODEL_PROTOCOL_PREFIX.CLAUDE:
    return {
      auth: [ "Verify your Anthropic API key is valid", "Check if your API key has expired or been revoked", "Ensure the x-api-key header is correctly set" ],
      permission: [ "Check if your Anthropic account has access to the requested model", "Verify your account is in good standing", "Ensure you have sufficient credits in your account" ],
      rateLimit: [ "The request has been automatically retried with exponential backoff", "If the issue persists, try reducing the request frequency", "Consider upgrading your Anthropic usage tier for higher limits" ],
      serverError: [ "The request has been automatically retried", "If the issue persists, try again in a few minutes", "Check Anthropic status page for service outages" ],
      clientError: [ "Check your request format and parameters", "Verify the model name is a valid Claude model", "Ensure the message format follows Anthropic API specifications" ]
    };

   default:
    return defaultSuggestions;
  }
}

export function extractSystemPromptFromRequestBody(requestBody, provider) {
  let incomingSystemText = "";
  switch (provider) {
   case MODEL_PROTOCOL_PREFIX.OPENAI:
    const openaiSystemMessage = requestBody.messages?.find(m => m.role === "system");
    if (openaiSystemMessage?.content) {
      incomingSystemText = openaiSystemMessage.content;
    } else if (requestBody.messages?.length > 0) {
      const userMessage = requestBody.messages.find(m => m.role === "user");
      if (userMessage) {
        incomingSystemText = userMessage.content;
      }
    }
    break;

   case MODEL_PROTOCOL_PREFIX.GEMINI:
    const geminiSystemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
    if (geminiSystemInstruction?.parts) {
      incomingSystemText = geminiSystemInstruction.parts.filter(p => p?.text).map(p => p.text).join("\n");
    } else if (requestBody.contents?.length > 0) {
      const userContent = requestBody.contents[0];
      if (userContent?.parts) {
        incomingSystemText = userContent.parts.filter(p => p?.text).map(p => p.text).join("\n");
      }
    }
    break;

   case MODEL_PROTOCOL_PREFIX.CLAUDE:
    if (typeof requestBody.system === "string") {
      incomingSystemText = requestBody.system;
    } else if (typeof requestBody.system === "object") {
      incomingSystemText = JSON.stringify(requestBody.system);
    } else if (requestBody.messages?.length > 0) {
      const userMessage = requestBody.messages.find(m => m.role === "user");
      if (userMessage) {
        if (Array.isArray(userMessage.content)) {
          incomingSystemText = userMessage.content.map(block => block.text).join("");
        } else {
          incomingSystemText = userMessage.content;
        }
      }
    }
    break;

   default:
    logger.warn(`[System Prompt] Unknown provider: ${provider}`);
    break;
  }
  return incomingSystemText;
}

export function getMD5Hash(obj) {
  const jsonString = JSON.stringify(obj);
  return crypto.createHash("md5").update(jsonString).digest("hex");
}

export function formatToLocal(dateInput) {
  try {
    if (!dateInput) return "--";
    let finalInput = dateInput;
    if (typeof dateInput === "number" && dateInput < 1e10) {
      finalInput = dateInput * 1e3;
    }
    const date = new Date(finalInput);
    if (isNaN(date.getTime())) return "--";
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).replace(/\//g, "-");
  } catch (e) {
    return "--";
  }
}

function createErrorResponse(error, fromProvider) {
  const protocolPrefix = getProtocolPrefix(fromProvider);
  const statusCode = error.status || error.code || 500;
  const errorMessage = error.message || "An error occurred during processing.";
  const getErrorType = code => {
    if (code === 401) return "authentication_error";
    if (code === 403) return "permission_error";
    if (code === 429) return "rate_limit_error";
    if (code >= 500) return "server_error";
    return "invalid_request_error";
  };
  const getGeminiStatus = code => {
    if (code === 400) return "INVALID_ARGUMENT";
    if (code === 401) return "UNAUTHENTICATED";
    if (code === 403) return "PERMISSION_DENIED";
    if (code === 404) return "NOT_FOUND";
    if (code === 429) return "RESOURCE_EXHAUSTED";
    if (code >= 500) return "INTERNAL";
    return "UNKNOWN";
  };
  switch (protocolPrefix) {
   case MODEL_PROTOCOL_PREFIX.OPENAI:
    return {
      error: {
        message: errorMessage,
        type: getErrorType(statusCode),
        code: getErrorType(statusCode)
      }
    };

   case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
    return {
      error: {
        type: getErrorType(statusCode),
        message: errorMessage,
        code: getErrorType(statusCode)
      }
    };

   case MODEL_PROTOCOL_PREFIX.CLAUDE:
    return {
      type: "error",
      error: {
        type: getErrorType(statusCode),
        message: errorMessage
      }
    };

   case MODEL_PROTOCOL_PREFIX.GEMINI:
    return {
      error: {
        code: statusCode,
        message: errorMessage,
        status: getGeminiStatus(statusCode)
      }
    };

   default:
    return {
      error: {
        message: errorMessage,
        type: getErrorType(statusCode),
        code: getErrorType(statusCode)
      }
    };
  }
}

function createStreamErrorResponse(error, fromProvider) {
  const protocolPrefix = getProtocolPrefix(fromProvider);
  const statusCode = error.status || error.code || 500;
  const errorMessage = error.message || "An error occurred during streaming.";
  const getErrorType = code => {
    if (code === 401) return "authentication_error";
    if (code === 403) return "permission_error";
    if (code === 429) return "rate_limit_error";
    if (code >= 500) return "server_error";
    return "invalid_request_error";
  };
  const getGeminiStatus = code => {
    if (code === 400) return "INVALID_ARGUMENT";
    if (code === 401) return "UNAUTHENTICATED";
    if (code === 403) return "PERMISSION_DENIED";
    if (code === 404) return "NOT_FOUND";
    if (code === 429) return "RESOURCE_EXHAUSTED";
    if (code >= 500) return "INTERNAL";
    return "UNKNOWN";
  };
  switch (protocolPrefix) {
   case MODEL_PROTOCOL_PREFIX.OPENAI:
    const openaiError = {
      error: {
        message: errorMessage,
        type: getErrorType(statusCode),
        code: null
      }
    };
    return `data: ${JSON.stringify(openaiError)}\n\n`;

   case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
    const responsesError = {
      id: `resp_${Date.now()}`,
      object: "error",
      created: Math.floor(Date.now() / 1e3),
      error: {
        type: getErrorType(statusCode),
        message: errorMessage,
        code: getErrorType(statusCode)
      }
    };
    return `event: error\ndata: ${JSON.stringify(responsesError)}\n\n`;

   case MODEL_PROTOCOL_PREFIX.CLAUDE:
    const claudeError = {
      type: "error",
      error: {
        type: getErrorType(statusCode),
        message: errorMessage
      }
    };
    return `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`;

   case MODEL_PROTOCOL_PREFIX.GEMINI:
    const geminiError = {
      error: {
        code: statusCode,
        message: errorMessage,
        status: getGeminiStatus(statusCode)
      }
    };
    return `data: ${JSON.stringify(geminiError)}\n\n`;

   default:
    const defaultError = {
      error: {
        message: errorMessage,
        type: getErrorType(statusCode),
        code: null
      }
    };
    return `data: ${JSON.stringify(defaultError)}\n\n`;
  }
}