import { v4 as uuidv4 } from "uuid";

import logger from "../utils/logger.js";

import { MODEL_PROTOCOL_PREFIX, getProtocolPrefix } from "../utils/common.js";

import { ConverterFactory } from "../converters/ConverterFactory.js";

import { generateResponseCreated, generateResponseInProgress, generateOutputItemAdded, generateContentPartAdded, generateOutputTextDone, generateContentPartDone, generateOutputItemDone, generateResponseCompleted } from "../providers/openai/openai-responses-core.mjs";

export function convertData(data, type, fromProvider, toProvider, model, requestId) {
  try {
    const fromProtocol = getProtocolPrefix(fromProvider);
    const toProtocol = getProtocolPrefix(toProvider);
    if (toProtocol === MODEL_PROTOCOL_PREFIX.FORWARD || fromProtocol === MODEL_PROTOCOL_PREFIX.FORWARD) {
      logger.info(`[Convert] Target protocol is forward, skipping conversion`);
      return data;
    }
    const converter = ConverterFactory.getConverter(fromProtocol);
    if (!converter) {
      throw new Error(`No converter found for protocol: ${fromProtocol}`);
    }
    switch (type) {
     case "request":
      return converter.convertRequest(data, toProtocol);

     case "response":
      return converter.convertResponse(data, toProtocol, model);

     case "streamChunk":
      return converter.convertStreamChunk(data, toProtocol, model, requestId);

     case "modelList":
      return converter.convertModelList(data, toProtocol);

     default:
      throw new Error(`Unsupported conversion type: ${type}`);
    }
  } catch (error) {
    logger.error(`Conversion error: ${error.message}`);
    throw error;
  }
}

export function toOpenAIRequestFromGemini(geminiRequest) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
  return converter.toOpenAIRequest(geminiRequest);
}

export function toOpenAIRequestFromClaude(claudeRequest) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
  return converter.toOpenAIRequest(claudeRequest);
}

export function toOpenAIChatCompletionFromGemini(geminiResponse, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
  return converter.toOpenAIResponse(geminiResponse, model);
}

export function toOpenAIChatCompletionFromClaude(claudeResponse, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
  return converter.toOpenAIResponse(claudeResponse, model);
}

export function toOpenAIStreamChunkFromGemini(geminiChunk, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
  return converter.toOpenAIStreamChunk(geminiChunk, model);
}

export function toOpenAIStreamChunkFromClaude(claudeChunk, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
  return converter.toOpenAIStreamChunk(claudeChunk, model);
}

export function toOpenAIModelListFromGemini(geminiModels) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
  return converter.toOpenAIModelList(geminiModels);
}

export function toOpenAIModelListFromClaude(claudeModels) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
  return converter.toOpenAIModelList(claudeModels);
}

export function toClaudeRequestFromOpenAI(openaiRequest) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
  return converter.toClaudeRequest(openaiRequest);
}

export function toClaudeRequestFromOpenAIResponses(responsesRequest) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
  return converter.toClaudeRequest(responsesRequest);
}

export function toClaudeChatCompletionFromOpenAI(openaiResponse, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
  return converter.toClaudeResponse(openaiResponse, model);
}

export function toClaudeChatCompletionFromGemini(geminiResponse, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
  return converter.toClaudeResponse(geminiResponse, model);
}

export function toClaudeStreamChunkFromOpenAI(openaiChunk, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
  return converter.toClaudeStreamChunk(openaiChunk, model);
}

export function toClaudeStreamChunkFromGemini(geminiChunk, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
  return converter.toClaudeStreamChunk(geminiChunk, model);
}

export function toClaudeModelListFromOpenAI(openaiModels) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
  return converter.toClaudeModelList(openaiModels);
}

export function toClaudeModelListFromGemini(geminiModels) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
  return converter.toClaudeModelList(geminiModels);
}

export function toGeminiRequestFromOpenAI(openaiRequest) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
  return converter.toGeminiRequest(openaiRequest);
}

export function toGeminiRequestFromClaude(claudeRequest) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
  return converter.toGeminiRequest(claudeRequest);
}

export function toGeminiRequestFromOpenAIResponses(responsesRequest) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
  return converter.toGeminiRequest(responsesRequest);
}

export function toOpenAIResponsesFromOpenAI(openaiResponse, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
  return converter.toOpenAIResponsesResponse(openaiResponse, model);
}

export function toOpenAIResponsesFromClaude(claudeResponse, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
  return converter.toOpenAIResponsesResponse(claudeResponse, model);
}

export function toOpenAIResponsesFromGemini(geminiResponse, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
  return converter.toOpenAIResponsesResponse(geminiResponse, model);
}

export function toOpenAIResponsesStreamChunkFromOpenAI(openaiChunk, model, requestId) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI);
  return converter.toOpenAIResponsesStreamChunk(openaiChunk, model, requestId);
}

export function toOpenAIResponsesStreamChunkFromClaude(claudeChunk, model, requestId) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CLAUDE);
  return converter.toOpenAIResponsesStreamChunk(claudeChunk, model, requestId);
}

export function toOpenAIResponsesStreamChunkFromGemini(geminiChunk, model, requestId) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.GEMINI);
  return converter.toOpenAIResponsesStreamChunk(geminiChunk, model, requestId);
}

export function toOpenAIRequestFromOpenAIResponses(responsesRequest) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
  return converter.toOpenAIRequest(responsesRequest);
}

export function toOpenAIChatCompletionFromOpenAIResponses(responsesResponse, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
  return converter.toOpenAIResponse(responsesResponse, model);
}

export function toOpenAIStreamChunkFromOpenAIResponses(responsesChunk, model) {
  const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
  return converter.toOpenAIStreamChunk(responsesChunk, model);
}

export async function extractAndProcessSystemMessages(messages) {
  const {Utils: Utils} = await import("../converters/utils.js");
  return Utils.extractSystemMessages(messages);
}

export async function extractTextFromMessageContent(content) {
  const {Utils: Utils} = await import("../converters/utils.js");
  return Utils.extractText(content);
}

export function getRegisteredProtocols() {
  return ConverterFactory.getRegisteredProtocols();
}

export function isProtocolRegistered(protocol) {
  return ConverterFactory.isProtocolRegistered(protocol);
}

export function clearConverterCache() {
  ConverterFactory.clearCache();
}

export function getConverter(protocol) {
  return ConverterFactory.getConverter(protocol);
}

export function getOpenAIStreamChunkStop(model) {
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model: model,
    system_fingerprint: "",
    choices: [ {
      index: 0,
      delta: {
        content: "",
        reasoning_content: ""
      },
      finish_reason: "stop",
      message: {
        content: "",
        reasoning_content: ""
      }
    } ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

export function getOpenAIResponsesStreamChunkBegin(id, model) {
  return [ generateResponseCreated(id, model), generateResponseInProgress(id), generateOutputItemAdded(id), generateContentPartAdded(id) ];
}

export function getOpenAIResponsesStreamChunkEnd(id) {
  return [ generateOutputTextDone(id), generateContentPartDone(id), generateOutputItemDone(id), generateResponseCompleted(id) ];
}

export default {
  convertData: convertData,
  getRegisteredProtocols: getRegisteredProtocols,
  isProtocolRegistered: isProtocolRegistered,
  clearConverterCache: clearConverterCache,
  getConverter: getConverter,
  toOpenAIRequestFromGemini: toOpenAIRequestFromGemini,
  toOpenAIRequestFromClaude: toOpenAIRequestFromClaude,
  toOpenAIChatCompletionFromGemini: toOpenAIChatCompletionFromGemini,
  toOpenAIChatCompletionFromClaude: toOpenAIChatCompletionFromClaude,
  toOpenAIStreamChunkFromGemini: toOpenAIStreamChunkFromGemini,
  toOpenAIStreamChunkFromClaude: toOpenAIStreamChunkFromClaude,
  toOpenAIModelListFromGemini: toOpenAIModelListFromGemini,
  toOpenAIModelListFromClaude: toOpenAIModelListFromClaude,
  toClaudeRequestFromOpenAI: toClaudeRequestFromOpenAI,
  toClaudeChatCompletionFromOpenAI: toClaudeChatCompletionFromOpenAI,
  toClaudeChatCompletionFromGemini: toClaudeChatCompletionFromGemini,
  toClaudeStreamChunkFromOpenAI: toClaudeStreamChunkFromOpenAI,
  toClaudeStreamChunkFromGemini: toClaudeStreamChunkFromGemini,
  toClaudeModelListFromOpenAI: toClaudeModelListFromOpenAI,
  toClaudeModelListFromGemini: toClaudeModelListFromGemini,
  toGeminiRequestFromOpenAI: toGeminiRequestFromOpenAI,
  toGeminiRequestFromClaude: toGeminiRequestFromClaude,
  toOpenAIResponsesFromOpenAI: toOpenAIResponsesFromOpenAI,
  toOpenAIResponsesFromClaude: toOpenAIResponsesFromClaude,
  toOpenAIResponsesFromGemini: toOpenAIResponsesFromGemini,
  toOpenAIResponsesStreamChunkFromOpenAI: toOpenAIResponsesStreamChunkFromOpenAI,
  toOpenAIResponsesStreamChunkFromClaude: toOpenAIResponsesStreamChunkFromClaude,
  toOpenAIResponsesStreamChunkFromGemini: toOpenAIResponsesStreamChunkFromGemini,
  toOpenAIRequestFromOpenAIResponses: toOpenAIRequestFromOpenAIResponses,
  toOpenAIChatCompletionFromOpenAIResponses: toOpenAIChatCompletionFromOpenAIResponses,
  toOpenAIStreamChunkFromOpenAIResponses: toOpenAIStreamChunkFromOpenAIResponses,
  toClaudeRequestFromOpenAIResponses: toClaudeRequestFromOpenAIResponses,
  toGeminiRequestFromOpenAIResponses: toGeminiRequestFromOpenAIResponses
};