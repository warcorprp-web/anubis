import { v4 as uuidv4 } from "uuid";

import logger from "../utils/logger.js";

import { MODEL_PROTOCOL_PREFIX, getProtocolPrefix } from "../utils/common.js";

import { streamStateManager, generateResponseCreated, generateResponseInProgress, generateOutputItemAdded, generateContentPartAdded, generateOutputTextDelta, generateOutputTextDone, generateContentPartDone, generateOutputItemDone, generateResponseCompleted } from "./openai/openai-responses-core.mjs";

const DEFAULT_MAX_TOKENS = 8192;

const DEFAULT_GEMINI_MAX_TOKENS = 65535;

const DEFAULT_TEMPERATURE = 1;

const DEFAULT_TOP_P = .95;

function checkAndAssignOrDefault(value, defaultValue) {
  if (value !== undefined && value !== 0) {
    return value;
  }
  return defaultValue;
}

function _mapFinishReason(reason, sourceFormat, targetFormat) {
  const reasonMappings = {
    openai: {
      anthropic: {
        stop: "end_turn",
        length: "max_tokens",
        content_filter: "stop_sequence",
        tool_calls: "tool_use"
      }
    },
    gemini: {
      anthropic: {
        STOP: "end_turn",
        MAX_TOKENS: "max_tokens",
        SAFETY: "stop_sequence",
        RECITATION: "stop_sequence",
        stop: "end_turn",
        length: "max_tokens",
        safety: "stop_sequence",
        recitation: "stop_sequence",
        other: "end_turn"
      }
    }
  };
  try {
    return reasonMappings[sourceFormat][targetFormat][reason] || "end_turn";
  } catch (e) {
    return "end_turn";
  }
}

function _cleanJsonSchemaProperties(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(schema)) {
    if ([ "type", "description", "properties", "required", "enum", "items" ].includes(key)) {
      sanitized[key] = value;
    }
  }
  if (sanitized.properties && typeof sanitized.properties === "object") {
    const cleanProperties = {};
    for (const [propName, propSchema] of Object.entries(sanitized.properties)) {
      cleanProperties[propName] = _cleanJsonSchemaProperties(propSchema);
    }
    sanitized.properties = cleanProperties;
  }
  if (sanitized.items) {
    sanitized.items = _cleanJsonSchemaProperties(sanitized.items);
  }
  return sanitized;
}

function _determineReasoningEffortFromBudget(budgetTokens) {
  if (budgetTokens === null || budgetTokens === undefined) {
    logger.info("No budget_tokens provided, defaulting to reasoning_effort='high'");
    return "high";
  }
  const LOW_THRESHOLD = 50;
  const HIGH_THRESHOLD = 200;
  logger.debug(`Threshold configuration: low <= ${LOW_THRESHOLD}, medium <= ${HIGH_THRESHOLD}, high > ${HIGH_THRESHOLD}`);
  let effort;
  if (budgetTokens <= LOW_THRESHOLD) {
    effort = "low";
  } else if (budgetTokens <= HIGH_THRESHOLD) {
    effort = "medium";
  } else {
    effort = "high";
  }
  logger.info(`🎯 Budget tokens ${budgetTokens} -> reasoning_effort '${effort}' (thresholds: low<=${LOW_THRESHOLD}, high<=${HIGH_THRESHOLD})`);
  return effort;
}

class ToolStateManager {
  constructor() {
    if (ToolStateManager.instance) {
      return ToolStateManager.instance;
    }
    ToolStateManager.instance = this;
    this._toolMappings = {};
    return this;
  }
  storeToolMapping(funcName, toolId) {
    this._toolMappings[funcName] = toolId;
  }
  getToolId(funcName) {
    return this._toolMappings[funcName] || null;
  }
  clearMappings() {
    this._toolMappings = {};
  }
}

const toolStateManager = new ToolStateManager;

export function convertData(data, type, fromProvider, toProvider, model) {
  const conversionMap = {
    request: {
      [MODEL_PROTOCOL_PREFIX.OPENAI]: {
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIRequestFromGemini,
        [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIRequestFromClaude
      },
      [MODEL_PROTOCOL_PREFIX.CLAUDE]: {
        [MODEL_PROTOCOL_PREFIX.OPENAI]: toClaudeRequestFromOpenAI,
        [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: toClaudeRequestFromOpenAIResponses
      },
      [MODEL_PROTOCOL_PREFIX.GEMINI]: {
        [MODEL_PROTOCOL_PREFIX.OPENAI]: toGeminiRequestFromOpenAI,
        [MODEL_PROTOCOL_PREFIX.CLAUDE]: toGeminiRequestFromClaude,
        [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: toGeminiRequestFromOpenAIResponses
      }
    },
    response: {
      [MODEL_PROTOCOL_PREFIX.OPENAI]: {
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIChatCompletionFromGemini,
        [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIChatCompletionFromClaude
      },
      [MODEL_PROTOCOL_PREFIX.CLAUDE]: {
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toClaudeChatCompletionFromGemini,
        [MODEL_PROTOCOL_PREFIX.OPENAI]: toClaudeChatCompletionFromOpenAI
      },
      [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: {
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIResponsesFromGemini,
        [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIResponsesFromClaude
      }
    },
    streamChunk: {
      [MODEL_PROTOCOL_PREFIX.OPENAI]: {
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIStreamChunkFromGemini,
        [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIStreamChunkFromClaude
      },
      [MODEL_PROTOCOL_PREFIX.CLAUDE]: {
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toClaudeStreamChunkFromGemini,
        [MODEL_PROTOCOL_PREFIX.OPENAI]: toClaudeStreamChunkFromOpenAI
      },
      [MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES]: {
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIResponsesStreamChunkFromGemini,
        [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIResponsesStreamChunkFromClaude
      }
    },
    modelList: {
      [MODEL_PROTOCOL_PREFIX.OPENAI]: {
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIModelListFromGemini,
        [MODEL_PROTOCOL_PREFIX.CLAUDE]: toOpenAIModelListFromClaude
      },
      [MODEL_PROTOCOL_PREFIX.CLAUDE]: {
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toClaudeModelListFromGemini,
        [MODEL_PROTOCOL_PREFIX.OPENAI]: toClaudeModelListFromOpenAI
      }
    }
  };
  const targetConversions = conversionMap[type];
  if (!targetConversions) {
    throw new Error(`Unsupported conversion type: ${type}`);
  }
  const toConversions = targetConversions[getProtocolPrefix(toProvider)];
  if (!toConversions) {
    throw new Error(`No conversions defined for target protocol: ${getProtocolPrefix(toProvider)} for type: ${type}`);
  }
  const conversionFunction = toConversions[getProtocolPrefix(fromProvider)];
  if (!conversionFunction) {
    throw new Error(`No conversion function found from ${getProtocolPrefix(fromProvider)} to ${toProvider} for type: ${type}`);
  }
  logger.info(conversionFunction);
  if (type === "response" || type === "streamChunk" || type === "modelList") {
    return conversionFunction(data, model);
  } else {
    return conversionFunction(data);
  }
}

export function toOpenAIRequestFromGemini(geminiRequest) {
  const openaiRequest = {
    messages: [],
    model: geminiRequest.model,
    max_tokens: checkAndAssignOrDefault(geminiRequest.max_tokens, DEFAULT_MAX_TOKENS),
    temperature: checkAndAssignOrDefault(geminiRequest.temperature, DEFAULT_TEMPERATURE),
    top_p: checkAndAssignOrDefault(geminiRequest.top_p, DEFAULT_TOP_P)
  };
  if (geminiRequest.systemInstruction && Array.isArray(geminiRequest.systemInstruction.parts)) {
    const systemContent = processGeminiPartsToOpenAIContent(geminiRequest.systemInstruction.parts);
    if (systemContent) {
      openaiRequest.messages.push({
        role: "system",
        content: systemContent
      });
    }
  }
  if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
    geminiRequest.contents.forEach(content => {
      if (content && Array.isArray(content.parts)) {
        const openaiContent = processGeminiPartsToOpenAIContent(content.parts);
        if (openaiContent && openaiContent.length > 0) {
          const openaiRole = content.role === "model" ? "assistant" : content.role;
          openaiRequest.messages.push({
            role: openaiRole,
            content: openaiContent
          });
        }
      }
    });
  }
  return openaiRequest;
}

function processGeminiPartsToOpenAIContent(parts) {
  if (!parts || !Array.isArray(parts)) return "";
  const contentArray = [];
  parts.forEach(part => {
    if (!part) return;
    if (typeof part.text === "string") {
      contentArray.push({
        type: "text",
        text: part.text
      });
    }
    if (part.inlineData) {
      const {mimeType: mimeType, data: data} = part.inlineData;
      if (mimeType && data) {
        contentArray.push({
          type: "image_url",
          image_url: {
            url: `data:${mimeType};base64,${data}`
          }
        });
      }
    }
    if (part.fileData) {
      const {mimeType: mimeType, fileUri: fileUri} = part.fileData;
      if (mimeType && fileUri) {
        if (mimeType.startsWith("image/")) {
          contentArray.push({
            type: "image_url",
            image_url: {
              url: fileUri
            }
          });
        } else if (mimeType.startsWith("audio/")) {
          contentArray.push({
            type: "text",
            text: `[Audio file: ${fileUri}]`
          });
        }
      }
    }
  });
  return contentArray.length === 1 && contentArray[0].type === "text" ? contentArray[0].text : contentArray;
}

export function toOpenAIModelListFromGemini(geminiModels) {
  return {
    object: "list",
    data: geminiModels.models.map(m => ({
      id: m.name.startsWith("models/") ? m.name.substring(7) : m.name,
      object: "model",
      created: Math.floor(Date.now() / 1e3),
      owned_by: "google"
    }))
  };
}

export function toOpenAIChatCompletionFromGemini(geminiResponse, model) {
  const content = processGeminiResponseContent(geminiResponse);
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model: model,
    choices: [ {
      index: 0,
      message: {
        role: "assistant",
        content: content
      },
      finish_reason: "stop"
    } ],
    usage: geminiResponse.usageMetadata ? {
      prompt_tokens: geminiResponse.usageMetadata.promptTokenCount || 0,
      completion_tokens: geminiResponse.usageMetadata.candidatesTokenCount || 0,
      total_tokens: geminiResponse.usageMetadata.totalTokenCount || 0
    } : {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

function processGeminiResponseContent(geminiResponse) {
  if (!geminiResponse || !geminiResponse.candidates) return "";
  const contents = [];
  geminiResponse.candidates.forEach(candidate => {
    if (candidate.content && candidate.content.parts) {
      candidate.content.parts.forEach(part => {
        if (part.text) {
          contents.push(part.text);
        }
      });
    }
  });
  return contents.join("\n");
}

export function toOpenAIStreamChunkFromGemini(geminiChunk, model) {
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model: model,
    choices: [ {
      index: 0,
      delta: {
        content: geminiChunk
      },
      finish_reason: null
    } ],
    usage: geminiChunk.usageMetadata ? {
      prompt_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
      completion_tokens: geminiChunk.usageMetadata.candidatesTokenCount || 0,
      total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0
    } : {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

export function toOpenAIChatCompletionFromClaude(claudeResponse, model) {
  if (!claudeResponse || !claudeResponse.content || claudeResponse.content.length === 0) {
    return {
      id: `chatcmpl-${uuidv4()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1e3),
      model: model,
      choices: [ {
        index: 0,
        message: {
          role: "assistant",
          content: ""
        },
        finish_reason: "stop"
      } ],
      usage: {
        prompt_tokens: claudeResponse.usage?.input_tokens || 0,
        completion_tokens: claudeResponse.usage?.output_tokens || 0,
        total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
      }
    };
  }
  const content = processClaudeResponseContent(claudeResponse.content);
  const finishReason = claudeResponse.stop_reason === "end_turn" ? "stop" : claudeResponse.stop_reason;
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1e3),
    model: model,
    choices: [ {
      index: 0,
      message: {
        role: "assistant",
        content: content
      },
      finish_reason: finishReason
    } ],
    usage: {
      prompt_tokens: claudeResponse.usage?.input_tokens || 0,
      completion_tokens: claudeResponse.usage?.output_tokens || 0,
      total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
    }
  };
}

function processClaudeResponseContent(content) {
  if (!content || !Array.isArray(content)) return "";
  const contentArray = [];
  content.forEach(block => {
    if (!block) return;
    switch (block.type) {
     case "text":
      contentArray.push({
        type: "text",
        text: block.text || ""
      });
      break;

     case "image":
      if (block.source && block.source.type === "base64") {
        contentArray.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`
          }
        });
      }
      break;

     default:
      if (block.text) {
        contentArray.push({
          type: "text",
          text: block.text
        });
      }
    }
  });
  return contentArray.length === 1 && contentArray[0].type === "text" ? contentArray[0].text : contentArray;
}

export function toOpenAIStreamChunkFromClaude(claudeChunk, model) {
  if (!claudeChunk) {
    return null;
  }
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1e3),
    model: model,
    system_fingerprint: "",
    choices: [ {
      index: 0,
      delta: {
        content: claudeChunk,
        reasoning_content: ""
      },
      finish_reason: !claudeChunk ? "stop" : null,
      message: {
        content: claudeChunk,
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

export function toOpenAIModelListFromClaude(claudeModels) {
  return {
    object: "list",
    data: claudeModels.models.map(m => ({
      id: m.id || m.name,
      object: "model",
      created: Math.floor(Date.now() / 1e3),
      owned_by: "anthropic"
    }))
  };
}

export function toClaudeChatCompletionFromOpenAI(openaiResponse, model) {
  if (!openaiResponse || !openaiResponse.choices || openaiResponse.choices.length === 0) {
    return {
      id: `msg_${uuidv4()}`,
      type: "message",
      role: "assistant",
      content: [],
      model: model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: openaiResponse?.usage?.prompt_tokens || 0,
        output_tokens: openaiResponse?.usage?.completion_tokens || 0
      }
    };
  }
  const choice = openaiResponse.choices[0];
  const contentList = [];
  const toolCalls = choice.message?.tool_calls || [];
  for (const toolCall of toolCalls.filter(tc => tc && typeof tc === "object")) {
    if (toolCall.function) {
      const func = toolCall.function;
      const argStr = func.arguments || "{}";
      let argObj;
      try {
        argObj = typeof argStr === "string" ? JSON.parse(argStr) : argStr;
      } catch (e) {
        argObj = {};
      }
      contentList.push({
        type: "tool_use",
        id: toolCall.id || "",
        name: func.name || "",
        input: argObj
      });
    }
  }
  const contentText = choice.message?.content || "";
  if (contentText) {
    const extractedContent = _extractThinkingFromOpenAIText(contentText);
    if (Array.isArray(extractedContent)) {
      contentList.push(...extractedContent);
    } else {
      contentList.push({
        type: "text",
        text: extractedContent
      });
    }
  }
  const stopReason = _mapFinishReason(choice.finish_reason || "stop", "openai", "anthropic");
  return {
    id: `msg_${uuidv4()}`,
    type: "message",
    role: "assistant",
    content: contentList,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0
    }
  };
}

export function toOpenAIRequestFromClaude(claudeRequest) {
  const openaiMessages = [];
  let systemMessageContent = "";
  if (claudeRequest.system) {
    systemMessageContent = claudeRequest.system;
  }
  if (claudeRequest.messages && Array.isArray(claudeRequest.messages)) {
    const tempOpenAIMessages = [];
    for (const msg of claudeRequest.messages) {
      const role = msg.role;
      if (role === "user" && Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(item => item && typeof item === "object" && item.type === "tool_result");
        if (hasToolResult) {
          for (const item of msg.content) {
            if (item && typeof item === "object" && item.type === "tool_result") {
              const toolUseId = item.tool_use_id || item.id || "";
              const contentStr = String(item.content || "");
              tempOpenAIMessages.push({
                role: "tool",
                tool_call_id: toolUseId,
                content: contentStr
              });
            }
          }
          continue;
        }
      }
      if (role === "assistant" && Array.isArray(msg.content) && msg.content.length > 0) {
        const firstPart = msg.content[0];
        if (firstPart.type === "tool_use") {
          const funcName = firstPart.name || "";
          const funcArgs = firstPart.input || {};
          tempOpenAIMessages.push({
            role: "assistant",
            content: "",
            tool_calls: [ {
              id: firstPart.id || `call_${funcName}_1`,
              type: "function",
              function: {
                name: funcName,
                arguments: JSON.stringify(funcArgs)
              },
              index: firstPart.index || 0
            } ]
          });
          continue;
        }
      }
      const contentConverted = processClaudeContentToOpenAIContent(msg.content || "");
      if (contentConverted && (Array.isArray(contentConverted) ? contentConverted.length > 0 : contentConverted.trim().length > 0)) {
        tempOpenAIMessages.push({
          role: role,
          content: contentConverted
        });
      }
    }
    const validatedMessages = [];
    for (let idx = 0; idx < tempOpenAIMessages.length; idx++) {
      const m = tempOpenAIMessages[idx];
      if (m.role === "assistant" && m.tool_calls) {
        const callIds = m.tool_calls.map(tc => tc.id).filter(id => id);
        let unmatched = new Set(callIds);
        for (let laterIdx = idx + 1; laterIdx < tempOpenAIMessages.length; laterIdx++) {
          const later = tempOpenAIMessages[laterIdx];
          if (later.role === "tool" && unmatched.has(later.tool_call_id)) {
            unmatched.delete(later.tool_call_id);
          }
          if (unmatched.size === 0) {
            break;
          }
        }
        if (unmatched.size > 0) {
          m.tool_calls = m.tool_calls.filter(tc => !unmatched.has(tc.id));
          if (m.tool_calls.length === 0) {
            delete m.tool_calls;
            if (m.content === null) {
              m.content = "";
            }
          }
        }
      }
      validatedMessages.push(m);
    }
    openaiMessages.push(...validatedMessages);
  }
  const openaiRequest = {
    model: claudeRequest.model,
    messages: openaiMessages,
    max_tokens: checkAndAssignOrDefault(claudeRequest.max_tokens, DEFAULT_MAX_TOKENS),
    temperature: checkAndAssignOrDefault(claudeRequest.temperature, DEFAULT_TEMPERATURE),
    top_p: checkAndAssignOrDefault(claudeRequest.top_p, DEFAULT_TOP_P),
    stream: claudeRequest.stream
  };
  if (claudeRequest.tools) {
    const openaiTools = [];
    for (const tool of claudeRequest.tools) {
      openaiTools.push({
        type: "function",
        function: {
          name: tool.name || "",
          description: tool.description || "",
          parameters: _cleanJsonSchemaProperties(tool.input_schema || {})
        }
      });
    }
    openaiRequest.tools = openaiTools;
    openaiRequest.tool_choice = "auto";
  }
  if (claudeRequest.thinking && claudeRequest.thinking.type === "enabled") {
    const budgetTokens = claudeRequest.thinking.budget_tokens;
    const reasoningEffort = _determineReasoningEffortFromBudget(budgetTokens);
    openaiRequest.reasoning_effort = reasoningEffort;
    let maxCompletionTokens = null;
    if (claudeRequest.max_tokens !== undefined) {
      maxCompletionTokens = claudeRequest.max_tokens;
      delete openaiRequest.max_tokens;
      logger.info(`Using client max_tokens as max_completion_tokens: ${maxCompletionTokens}`);
    } else {
      const envMaxTokens = process.env.OPENAI_REASONING_MAX_TOKENS;
      if (envMaxTokens) {
        try {
          maxCompletionTokens = parseInt(envMaxTokens, 10);
          logger.info(`Using OPENAI_REASONING_MAX_TOKENS from environment: ${maxCompletionTokens}`);
        } catch (e) {
          logger.warn(`Invalid OPENAI_REASONING_MAX_TOKENS value '${envMaxTokens}', must be integer`);
        }
      }
      if (!envMaxTokens) {
        throw new Error("For OpenAI reasoning models, max_completion_tokens is required. Please specify max_tokens in the request or set OPENAI_REASONING_MAX_TOKENS environment variable.");
      }
    }
    openaiRequest.max_completion_tokens = maxCompletionTokens;
    logger.info(`Anthropic thinking enabled -> OpenAI reasoning_effort='${reasoningEffort}', max_completion_tokens=${maxCompletionTokens}`);
    if (budgetTokens) {
      logger.info(`Budget tokens: ${budgetTokens} -> reasoning_effort: '${reasoningEffort}'`);
    }
  }
  if (systemMessageContent) {
    let stringifiedSystemMessageContent = systemMessageContent;
    if (Array.isArray(systemMessageContent)) {
      stringifiedSystemMessageContent = systemMessageContent.map(item => typeof item === "string" ? item : item.text).join("\n");
    }
    openaiRequest.messages.unshift({
      role: "system",
      content: stringifiedSystemMessageContent
    });
  }
  return openaiRequest;
}

function processClaudeContentToOpenAIContent(content) {
  if (!content || !Array.isArray(content)) return [];
  const contentArray = [];
  content.forEach(block => {
    if (!block) return;
    switch (block.type) {
     case "text":
      if (block.text) {
        contentArray.push({
          type: "text",
          text: block.text
        });
      }
      break;

     case "image":
      if (block.source && block.source.type === "base64") {
        contentArray.push({
          type: "image_url",
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`
          }
        });
      }
      break;

     case "tool_use":
      contentArray.push({
        type: "text",
        text: `[Tool use: ${block.name}]`
      });
      break;

     case "tool_result":
      contentArray.push({
        type: "text",
        text: typeof block.content === "string" ? block.content : JSON.stringify(block.content)
      });
      break;

     default:
      if (block.text) {
        contentArray.push({
          type: "text",
          text: block.text
        });
      }
    }
  });
  return contentArray;
}

export function toGeminiRequestFromOpenAI(openaiRequest) {
  const messages = openaiRequest.messages || [];
  const {systemInstruction: systemInstruction, nonSystemMessages: nonSystemMessages} = extractAndProcessSystemMessages(messages);
  const processedMessages = [];
  let lastMessage = null;
  for (const message of nonSystemMessages) {
    const geminiRole = message.role === "assistant" ? "model" : message.role;
    if (geminiRole === "tool") {
      if (lastMessage) processedMessages.push(lastMessage);
      processedMessages.push({
        role: "function",
        parts: [ {
          functionResponse: {
            name: message.name,
            response: {
              content: safeParseJSON(message.content)
            }
          }
        } ]
      });
      lastMessage = null;
      continue;
    }
    const processedContent = processOpenAIContentToGeminiParts(message.content);
    if (lastMessage && lastMessage.role === geminiRole && !message.tool_calls && Array.isArray(processedContent) && processedContent.every(p => p.text) && Array.isArray(lastMessage.parts) && lastMessage.parts.every(p => p.text)) {
      lastMessage.parts.push(...processedContent);
      continue;
    }
    if (lastMessage) processedMessages.push(lastMessage);
    lastMessage = {
      role: geminiRole,
      parts: processedContent
    };
  }
  if (lastMessage) processedMessages.push(lastMessage);
  const geminiRequest = {
    contents: processedMessages.filter(item => item.parts && item.parts.length > 0)
  };
  if (systemInstruction) geminiRequest.systemInstruction = systemInstruction;
  if (openaiRequest.tools?.length) {
    geminiRequest.tools = [ {
      functionDeclarations: openaiRequest.tools.map(t => {
        if (!t || typeof t !== "object" || !t.function) {
          logger.warn("Skipping invalid tool declaration in openaiRequest.tools.");
          return null;
        }
        const func = t.function;
        const parameters = _cleanJsonSchemaProperties(func.parameters || {});
        return {
          name: String(func.name || ""),
          description: String(func.description || ""),
          parameters: parameters
        };
      }).filter(Boolean)
    } ];
    if (geminiRequest.tools[0].functionDeclarations.length === 0) {
      delete geminiRequest.tools;
    }
  }
  if (openaiRequest.tool_choice) {
    geminiRequest.toolConfig = buildToolConfig(openaiRequest.tool_choice);
  }
  const config = buildGenerationConfig(openaiRequest);
  if (Object.keys(config).length) geminiRequest.generationConfig = config;
  if (geminiRequest.contents[0]?.role !== "user") {
    logger.warn(`[Request Conversion] Warning: Conversation does not start with a 'user' role.`);
  }
  return geminiRequest;
}

function processOpenAIContentToGeminiParts(content) {
  if (!content) return [];
  if (typeof content === "string") {
    return [ {
      text: content
    } ];
  }
  if (Array.isArray(content)) {
    const parts = [];
    content.forEach(item => {
      if (!item) return;
      switch (item.type) {
       case "text":
        if (item.text) {
          parts.push({
            text: item.text
          });
        }
        break;

       case "image_url":
        if (item.image_url) {
          const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url.url;
          if (imageUrl.startsWith("data:")) {
            const [header, data] = imageUrl.split(",");
            const mimeType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
            parts.push({
              inlineData: {
                mimeType: mimeType,
                data: data
              }
            });
          } else {
            parts.push({
              fileData: {
                mimeType: "image/jpeg",
                fileUri: imageUrl
              }
            });
          }
        }
        break;

       case "audio":
        if (item.audio_url) {
          const audioUrl = typeof item.audio_url === "string" ? item.audio_url : item.audio_url.url;
          if (audioUrl.startsWith("data:")) {
            const [header, data] = audioUrl.split(",");
            const mimeType = header.match(/data:([^;]+)/)?.[1] || "audio/wav";
            parts.push({
              inlineData: {
                mimeType: mimeType,
                data: data
              }
            });
          } else {
            parts.push({
              fileData: {
                mimeType: "audio/wav",
                fileUri: audioUrl
              }
            });
          }
        }
        break;
      }
    });
    return parts;
  }
  return [];
}

function safeParseJSON(str) {
  if (!str) {
    return str;
  }
  let cleanedStr = str;
  if (cleanedStr.endsWith("\\") && !cleanedStr.endsWith("\\\\")) {
    cleanedStr = cleanedStr.substring(0, cleanedStr.length - 1);
  } else if (cleanedStr.endsWith("\\u") || cleanedStr.endsWith("\\u0") || cleanedStr.endsWith("\\u00")) {
    const idx = cleanedStr.lastIndexOf("\\u");
    cleanedStr = cleanedStr.substring(0, idx);
  }
  try {
    return JSON.parse(cleanedStr || "{}");
  } catch (e) {
    return str;
  }
}

function buildToolConfig(toolChoice) {
  if (typeof toolChoice === "string" && [ "none", "auto" ].includes(toolChoice)) {
    return {
      functionCallingConfig: {
        mode: toolChoice.toUpperCase()
      }
    };
  }
  if (typeof toolChoice === "object" && toolChoice.function) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [ toolChoice.function.name ]
      }
    };
  }
  return null;
}

function _buildFunctionResponse(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const isResult = item.type === "tool_result" || item.tool_use_id !== undefined || item.tool_output !== undefined || item.result !== undefined || item.content !== undefined;
  if (!isResult) {
    return null;
  }
  let funcName = null;
  const toolUseId = item.tool_use_id || item.id;
  if (!funcName && toolUseId) {
    let potentialFuncName = null;
    if (String(toolUseId).startsWith("call_")) {
      const nameAndHash = toolUseId.substring(4);
      potentialFuncName = nameAndHash.substring(0, nameAndHash.lastIndexOf("_"));
    }
    if (potentialFuncName) {
      const storedId = toolStateManager.getToolId(potentialFuncName);
      if (storedId === toolUseId) {
        funcName = potentialFuncName;
      }
    }
  }
  if (!funcName && toolUseId && String(toolUseId).startsWith("call_")) {
    const nameAndHash = toolUseId.substring(4);
    funcName = nameAndHash.substring(0, nameAndHash.lastIndexOf("_"));
  }
  if (!funcName) {
    funcName = item.tool_name || item.name || item.function_name;
  }
  if (!funcName) {
    return null;
  }
  let funcResponse = null;
  for (const key of [ "content", "tool_output", "output", "response", "result" ]) {
    if (item[key] !== undefined) {
      funcResponse = item[key];
      break;
    }
  }
  if (Array.isArray(funcResponse) && funcResponse.length > 0) {
    const textParts = funcResponse.filter(p => p && typeof p === "object" && p.type === "text").map(p => p.text || "");
    if (textParts.length > 0) {
      funcResponse = textParts.join("");
    }
  }
  if (funcResponse === null || funcResponse === undefined) {
    funcResponse = "";
  }
  if (typeof funcResponse !== "object") {
    funcResponse = {
      content: String(funcResponse)
    };
  }
  return {
    functionResponse: {
      name: funcName,
      response: funcResponse
    }
  };
}

export function toClaudeModelListFromGemini(geminiModels) {
  return {
    models: geminiModels.models.map(m => ({
      name: m.name.startsWith("models/") ? m.name.substring(7) : m.name,
      description: ""
    }))
  };
}

export function toClaudeModelListFromOpenAI(openaiModels) {
  return {
    models: openaiModels.data.map(m => ({
      name: m.id,
      description: ""
    }))
  };
}

function _extractThinkingFromOpenAIText(text) {
  const thinkingPattern = /<thinking>\s*(.*?)\s*<\/thinking>/gs;
  const matches = [ ...text.matchAll(thinkingPattern) ];
  const contentBlocks = [];
  let lastEnd = 0;
  for (const match of matches) {
    const beforeText = text.substring(lastEnd, match.index).trim();
    if (beforeText) {
      contentBlocks.push({
        type: "text",
        text: beforeText
      });
    }
    const thinkingText = match[1].trim();
    if (thinkingText) {
      contentBlocks.push({
        type: "thinking",
        thinking: thinkingText
      });
    }
    lastEnd = match.index + match[0].length;
  }
  const afterText = text.substring(lastEnd).trim();
  if (afterText) {
    contentBlocks.push({
      type: "text",
      text: afterText
    });
  }
  if (contentBlocks.length === 0) {
    return text;
  }
  if (contentBlocks.length === 1 && contentBlocks[0].type === "text") {
    return contentBlocks[0].text;
  }
  return contentBlocks;
}

export function toClaudeStreamChunkFromOpenAI(openaiChunk, model) {
  if (!openaiChunk) {
    return null;
  }
  if (Array.isArray(openaiChunk)) {
    const toolCall = openaiChunk[0];
    if (toolCall) {
      if (toolCall.function && toolCall.function.name) {
        const toolUseBlock = {
          type: "tool_use",
          id: toolCall.id || `call_${toolCall.function.name}_${Date.now()}`,
          name: toolCall.function.name,
          input: toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {}
        };
        return {
          type: "content_block_start",
          index: 1,
          content_block: toolUseBlock
        };
      }
    }
  }
  if (typeof openaiChunk === "string") {
    return {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: openaiChunk
      }
    };
  }
  return null;
}

function buildGenerationConfig({temperature: temperature, max_tokens: max_tokens, top_p: top_p, stop: stop}) {
  const config = {};
  config.temperature = checkAndAssignOrDefault(temperature, DEFAULT_TEMPERATURE);
  config.maxOutputTokens = checkAndAssignOrDefault(max_tokens, DEFAULT_GEMINI_MAX_TOKENS);
  config.topP = checkAndAssignOrDefault(top_p, DEFAULT_TOP_P);
  if (stop !== undefined) config.stopSequences = Array.isArray(stop) ? stop : [ stop ];
  return config;
}

export function toClaudeRequestFromOpenAI(openaiRequest) {
  const messages = openaiRequest.messages || [];
  const {systemInstruction: systemInstruction, nonSystemMessages: nonSystemMessages} = extractAndProcessSystemMessages(messages);
  const claudeMessages = [];
  for (const message of nonSystemMessages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    let content = [];
    if (message.role === "tool") {
      content.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: safeParseJSON(message.content)
      });
      claudeMessages.push({
        role: "user",
        content: content
      });
    } else if (message.role === "assistant" && message.tool_calls?.length) {
      const toolUseBlocks = message.tool_calls.map(tc => ({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: safeParseJSON(tc.function.arguments)
      }));
      claudeMessages.push({
        role: "assistant",
        content: toolUseBlocks
      });
    } else {
      if (typeof message.content === "string") {
        if (message.content) {
          content.push({
            type: "text",
            text: message.content
          });
        }
      } else if (Array.isArray(message.content)) {
        message.content.forEach(item => {
          if (!item) return;
          switch (item.type) {
           case "text":
            if (item.text) {
              content.push({
                type: "text",
                text: item.text
              });
            }
            break;

           case "image_url":
            if (item.image_url) {
              const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url.url;
              if (imageUrl.startsWith("data:")) {
                const [header, data] = imageUrl.split(",");
                const mediaType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
                content.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: data
                  }
                });
              } else {
                content.push({
                  type: "text",
                  text: `[Image: ${imageUrl}]`
                });
              }
            }
            break;

           case "audio":
            if (item.audio_url) {
              const audioUrl = typeof item.audio_url === "string" ? item.audio_url : item.audio_url.url;
              content.push({
                type: "text",
                text: `[Audio: ${audioUrl}]`
              });
            }
            break;
          }
        });
      }
      if (content.length > 0) {
        claudeMessages.push({
          role: role,
          content: content
        });
      }
    }
  }
  const claudeRequest = {
    model: openaiRequest.model,
    messages: claudeMessages,
    max_tokens: checkAndAssignOrDefault(openaiRequest.max_tokens, DEFAULT_MAX_TOKENS),
    temperature: checkAndAssignOrDefault(openaiRequest.temperature, DEFAULT_TEMPERATURE),
    top_p: checkAndAssignOrDefault(openaiRequest.top_p, DEFAULT_TOP_P)
  };
  if (systemInstruction) {
    claudeRequest.system = extractTextFromMessageContent(systemInstruction.parts[0].text);
  }
  if (openaiRequest.tools?.length) {
    claudeRequest.tools = openaiRequest.tools.map(t => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || {
        type: "object",
        properties: {}
      }
    }));
    claudeRequest.tool_choice = buildClaudeToolChoice(openaiRequest.tool_choice);
  }
  return claudeRequest;
}

function buildClaudeToolChoice(toolChoice) {
  if (typeof toolChoice === "string") {
    const mapping = {
      auto: "auto",
      none: "none",
      required: "any"
    };
    return {
      type: mapping[toolChoice]
    };
  }
  if (typeof toolChoice === "object" && toolChoice.function) {
    return {
      type: "tool",
      name: toolChoice.function.name
    };
  }
  return undefined;
}

export function extractAndProcessSystemMessages(messages) {
  const systemContents = [];
  const nonSystemMessages = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemContents.push(extractTextFromMessageContent(message.content));
    } else {
      nonSystemMessages.push(message);
    }
  }
  let systemInstruction = null;
  if (systemContents.length > 0) {
    systemInstruction = {
      parts: [ {
        text: systemContents.join("\n")
      } ]
    };
  }
  return {
    systemInstruction: systemInstruction,
    nonSystemMessages: nonSystemMessages
  };
}

export function extractTextFromMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.filter(part => part.type === "text" && part.text).map(part => part.text).join("\n");
  }
  return "";
}

export function toGeminiRequestFromClaude(claudeRequest) {
  if (!claudeRequest || typeof claudeRequest !== "object") {
    logger.warn("Invalid claudeRequest provided to toGeminiRequestFromClaude.");
    return {
      contents: []
    };
  }
  const geminiRequest = {
    contents: []
  };
  if (claudeRequest.system) {
    let incomingSystemText = null;
    if (typeof claudeRequest.system === "string") {
      incomingSystemText = claudeRequest.system;
    } else if (typeof claudeRequest.system === "object") {
      incomingSystemText = JSON.stringify(claudeRequest.system);
    } else if (claudeRequest.messages?.length > 0) {
      const userMessage = claudeRequest.messages.find(m => m.role === "user");
      if (userMessage) {
        if (Array.isArray(userMessage.content)) {
          incomingSystemText = userMessage.content.map(block => block.text).join("");
        } else {
          incomingSystemText = userMessage.content;
        }
      }
    }
    geminiRequest.systemInstruction = {
      parts: [ {
        text: incomingSystemText
      } ]
    };
  }
  if (Array.isArray(claudeRequest.messages)) {
    claudeRequest.messages.forEach(message => {
      if (!message || typeof message !== "object" || !message.role || !message.content) {
        logger.warn("Skipping invalid message in claudeRequest.messages.");
        return;
      }
      const geminiRole = message.role === "assistant" ? "model" : "user";
      const processedParts = processClaudeContentToGeminiParts(message.content);
      const functionResponsePart = processedParts.find(part => part.functionResponse);
      if (functionResponsePart) {
        geminiRequest.contents.push({
          role: "function",
          parts: [ functionResponsePart ]
        });
      } else if (processedParts.length > 0) {
        geminiRequest.contents.push({
          role: geminiRole,
          parts: processedParts
        });
      }
    });
  }
  const generationConfig = {};
  generationConfig.maxOutputTokens = checkAndAssignOrDefault(claudeRequest.max_tokens, DEFAULT_GEMINI_MAX_TOKENS);
  generationConfig.temperature = checkAndAssignOrDefault(claudeRequest.temperature, DEFAULT_TEMPERATURE);
  generationConfig.topP = checkAndAssignOrDefault(claudeRequest.top_p, DEFAULT_TOP_P);
  if (Object.keys(generationConfig).length > 0) {
    geminiRequest.generationConfig = generationConfig;
  }
  if (Array.isArray(claudeRequest.tools)) {
    geminiRequest.tools = [ {
      functionDeclarations: claudeRequest.tools.map(tool => {
        if (!tool || typeof tool !== "object" || !tool.name) {
          logger.warn("Skipping invalid tool declaration in claudeRequest.tools.");
          return null;
        }
        delete tool.input_schema.$schema;
        return {
          name: String(tool.name),
          description: String(tool.description || ""),
          parameters: tool.input_schema && typeof tool.input_schema === "object" ? tool.input_schema : {
            type: "object",
            properties: {}
          }
        };
      }).filter(Boolean)
    } ];
    if (geminiRequest.tools[0].functionDeclarations.length === 0) {
      delete geminiRequest.tools;
    }
  }
  if (claudeRequest.tool_choice) {
    geminiRequest.toolConfig = buildGeminiToolConfigFromClaude(claudeRequest.tool_choice);
  }
  return geminiRequest;
}

function buildGeminiToolConfigFromClaude(claudeToolChoice) {
  if (!claudeToolChoice || typeof claudeToolChoice !== "object" || !claudeToolChoice.type) {
    logger.warn("Invalid claudeToolChoice provided to buildGeminiToolConfigFromClaude.");
    return undefined;
  }
  switch (claudeToolChoice.type) {
   case "auto":
    return {
      functionCallingConfig: {
        mode: "AUTO"
      }
    };

   case "none":
    return {
      functionCallingConfig: {
        mode: "NONE"
      }
    };

   case "tool":
    if (claudeToolChoice.name && typeof claudeToolChoice.name === "string") {
      return {
        functionCallingConfig: {
          mode: "ANY",
          allowedFunctionNames: [ claudeToolChoice.name ]
        }
      };
    }
    logger.warn("Invalid tool name in claudeToolChoice of type 'tool'.");
    return undefined;

   default:
    logger.warn(`Unsupported claudeToolChoice type: ${claudeToolChoice.type}`);
    return undefined;
  }
}

function processClaudeContentToGeminiParts(content) {
  if (!content) return [];
  if (typeof content === "string") {
    return [ {
      text: content
    } ];
  }
  if (Array.isArray(content)) {
    const parts = [];
    content.forEach(block => {
      if (!block || typeof block !== "object" || !block.type) {
        logger.warn("Skipping invalid content block in processClaudeContentToGeminiParts.");
        return;
      }
      switch (block.type) {
       case "text":
        if (typeof block.text === "string") {
          parts.push({
            text: block.text
          });
        } else {
          logger.warn("Invalid text content in Claude text block.");
        }
        break;

       case "image":
        if (block.source && typeof block.source === "object" && block.source.type === "base64" && typeof block.source.media_type === "string" && typeof block.source.data === "string") {
          parts.push({
            inlineData: {
              mimeType: block.source.media_type,
              data: block.source.data
            }
          });
        } else {
          logger.warn("Invalid image source in Claude image block.");
        }
        break;

       case "tool_use":
        if (typeof block.name === "string" && block.input && typeof block.input === "object") {
          parts.push({
            functionCall: {
              name: block.name,
              args: block.input
            }
          });
        } else {
          logger.warn("Invalid tool_use block in Claude content.");
        }
        break;

       case "tool_result":
        if (typeof block.tool_use_id === "string") {
          parts.push({
            functionResponse: {
              name: block.tool_use_id,
              response: {
                content: block.content
              }
            }
          });
        } else {
          logger.warn("Invalid tool_result block in Claude content: missing tool_use_id.");
        }
        break;

       default:
        if (typeof block.text === "string") {
          parts.push({
            text: block.text
          });
        } else {
          logger.warn(`Unsupported Claude content block type: ${block.type}. Skipping.`);
        }
      }
    });
    return parts;
  }
  return [];
}

export function toClaudeChatCompletionFromGemini(geminiResponse, model) {
  if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) {
    return {
      id: `msg_${uuidv4()}`,
      type: "message",
      role: "assistant",
      content: [],
      model: model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: geminiResponse?.usageMetadata?.promptTokenCount || 0,
        output_tokens: geminiResponse?.usageMetadata?.candidatesTokenCount || 0
      }
    };
  }
  const candidate = geminiResponse.candidates[0];
  const content = processGeminiResponseToClaudeContent(geminiResponse);
  const finishReason = candidate.finishReason;
  let stopReason = "end_turn";
  if (finishReason) {
    switch (finishReason) {
     case "STOP":
      stopReason = "end_turn";
      break;

     case "MAX_TOKENS":
      stopReason = "max_tokens";
      break;

     case "SAFETY":
      stopReason = "safety";
      break;

     case "RECITATION":
      stopReason = "recitation";
      break;

     case "OTHER":
      stopReason = "other";
      break;

     default:
      stopReason = "end_turn";
    }
  }
  return {
    id: `msg_${uuidv4()}`,
    type: "message",
    role: "assistant",
    content: content,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
      output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0
    }
  };
}

function processGeminiResponseToClaudeContent(geminiResponse) {
  if (!geminiResponse || !geminiResponse.candidates || geminiResponse.candidates.length === 0) return [];
  const content = [];
  for (const candidate of geminiResponse.candidates) {
    if (candidate.finishReason && candidate.finishReason !== "STOP") {
      if (candidate.finishMessage) {
        content.push({
          type: "text",
          text: `Error: ${candidate.finishMessage}`
        });
      }
      continue;
    }
    if (candidate.content && candidate.content.parts) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          content.push({
            type: "text",
            text: part.text
          });
        } else if (part.inlineData) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: part.inlineData.mimeType,
              data: part.inlineData.data
            }
          });
        } else if (part.functionCall) {
          content.push({
            type: "tool_use",
            id: uuidv4(),
            name: part.functionCall.name,
            input: part.functionCall.args || {}
          });
        }
      }
    }
  }
  return content;
}

export function toClaudeStreamChunkFromGemini(geminiChunk, model) {
  if (!geminiChunk) {
    return null;
  }
  if (typeof geminiChunk === "string") {
    return {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: geminiChunk
      }
    };
  }
  return null;
}

export function toOpenAIResponsesFromClaude(claudeResponse, model) {
  const content = processClaudeResponseContent(claudeResponse.content);
  const textContent = typeof content === "string" ? content : JSON.stringify(content);
  let output = [];
  output.push({
    type: "message",
    id: `msg_${uuidv4().replace(/-/g, "")}`,
    summary: [],
    type: "message",
    role: "assistant",
    status: "completed",
    content: [ {
      annotations: [],
      logprobs: [],
      text: textContent,
      type: "output_text"
    } ]
  });
  return {
    background: false,
    created_at: Math.floor(Date.now() / 1e3),
    error: null,
    id: `resp_${uuidv4().replace(/-/g, "")}`,
    incomplete_details: null,
    max_output_tokens: null,
    max_tool_calls: null,
    metadata: {},
    model: model || claudeResponse.model,
    object: "response",
    output: output,
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt_cache_key: null,
    reasoning: {},
    safety_identifier: "user-" + uuidv4().replace(/-/g, ""),
    service_tier: "default",
    status: "completed",
    store: false,
    temperature: 1,
    text: {
      format: {
        type: "text"
      }
    },
    tool_choice: "auto",
    tools: [],
    top_logprobs: 0,
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: claudeResponse.usage?.input_tokens || 0,
      input_tokens_details: {
        cached_tokens: claudeResponse.usage?.cache_creation_input_tokens || 0
      },
      output_tokens: claudeResponse.usage?.output_tokens || 0,
      output_tokens_details: {
        reasoning_tokens: 0
      },
      total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
    },
    user: null
  };
}

export function toOpenAIResponsesFromGemini(geminiResponse, model) {
  const content = processGeminiResponseContent(geminiResponse);
  const textContent = typeof content === "string" ? content : JSON.stringify(content);
  let output = [];
  output.push({
    id: `msg_${uuidv4().replace(/-/g, "")}`,
    summary: [],
    type: "message",
    role: "assistant",
    status: "completed",
    content: [ {
      annotations: [],
      logprobs: [],
      text: textContent,
      type: "output_text"
    } ]
  });
  return {
    background: false,
    created_at: Math.floor(Date.now() / 1e3),
    error: null,
    id: `resp_${uuidv4().replace(/-/g, "")}`,
    incomplete_details: null,
    max_output_tokens: null,
    max_tool_calls: null,
    metadata: {},
    model: model,
    object: "response",
    output: output,
    parallel_tool_calls: true,
    previous_response_id: null,
    prompt_cache_key: null,
    reasoning: {},
    safety_identifier: "user-" + uuidv4().replace(/-/g, ""),
    service_tier: "default",
    status: "completed",
    store: false,
    temperature: 1,
    text: {
      format: {
        type: "text"
      }
    },
    tool_choice: "auto",
    tools: [],
    top_logprobs: 0,
    top_p: 1,
    truncation: "disabled",
    usage: {
      input_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
      input_tokens_details: {
        cached_tokens: geminiResponse.usageMetadata?.cachedTokens || 0
      },
      output_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
      output_tokens_details: {
        reasoning_tokens: 0
      },
      total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0
    },
    user: null
  };
}

export function toClaudeRequestFromOpenAIResponses(responsesRequest) {
  const claudeRequest = {
    model: responsesRequest.model,
    max_tokens: checkAndAssignOrDefault(responsesRequest.max_tokens, DEFAULT_MAX_TOKENS),
    temperature: checkAndAssignOrDefault(responsesRequest.temperature, DEFAULT_TEMPERATURE),
    top_p: checkAndAssignOrDefault(responsesRequest.top_p, DEFAULT_TOP_P)
  };
  if (responsesRequest.instructions) {
    claudeRequest.system = [];
    claudeRequest.system.push({
      text: typeof responsesRequest.instructions === "string" ? responsesRequest.instructions : JSON.stringify(responsesRequest.instructions)
    });
  }
  const claudeMessages = [];
  if (responsesRequest.input) {
    if (typeof responsesRequest.input === "string") {
      claudeMessages.push({
        role: "user",
        content: [ {
          type: "text",
          text: responsesRequest.input
        } ]
      });
    } else {
      for (const message of responsesRequest.input) {
        const role = message.role === "assistant" ? "assistant" : "user";
        let content = [];
        if (message.role === "tool") {
          content.push({
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: safeParseJSON(message.content)
          });
          claudeMessages.push({
            role: "user",
            content: content
          });
        } else if (message.role === "assistant" && message.tool_calls?.length) {
          const toolUseBlocks = message.tool_calls.map(tc => ({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: safeParseJSON(tc.function.arguments)
          }));
          claudeMessages.push({
            role: "assistant",
            content: toolUseBlocks
          });
        } else {
          if (typeof message.content === "string") {
            if (message.content) {
              content.push({
                type: "text",
                text: message.content
              });
            }
          } else if (Array.isArray(message.content)) {
            message.content.forEach(item => {
              if (!item) return;
              switch (item.type) {
               case "input_text":
                if (item.text) {
                  content.push({
                    type: "text",
                    text: item.text
                  });
                }
                break;

               case "output_text":
                if (item.text) {
                  content.push({
                    type: "text",
                    text: item.text
                  });
                }
                break;

               case "image_url":
                if (item.image_url) {
                  const imageUrl = typeof item.image_url === "string" ? item.image_url : item.image_url.url;
                  if (imageUrl.startsWith("data:")) {
                    const [header, data] = imageUrl.split(",");
                    const mediaType = header.match(/data:([^;]+)/)?.[1] || "image/jpeg";
                    content.push({
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: mediaType,
                        data: data
                      }
                    });
                  } else {
                    content.push({
                      type: "text",
                      text: `[Image: ${imageUrl}]`
                    });
                  }
                }
                break;

               case "audio":
                if (item.audio_url) {
                  const audioUrl = typeof item.audio_url === "string" ? item.audio_url : item.audio_url.url;
                  content.push({
                    type: "text",
                    text: `[Audio: ${audioUrl}]`
                  });
                }
                break;
              }
            });
          }
          if (content.length > 0) {
            claudeMessages.push({
              role: role,
              content: content
            });
          }
        }
      }
    }
  }
  claudeRequest.messages = claudeMessages;
  claudeRequest.stream = responsesRequest.stream || false;
  return claudeRequest;
}

export function toGeminiRequestFromOpenAIResponses(responsesRequest) {
  const geminiRequest = {
    contents: []
  };
  if (responsesRequest.instructions) {
    let instructionsText = "";
    if (typeof responsesRequest.instructions === "string") {
      instructionsText = responsesRequest.instructions;
    } else {
      instructionsText = JSON.stringify(responsesRequest.instructions);
    }
    geminiRequest.systemInstruction = {
      parts: [ {
        text: instructionsText
      } ]
    };
  }
  if (responsesRequest.input) {
    let inputContent = "";
    if (typeof responsesRequest.input === "string") {
      inputContent = responsesRequest.input;
    } else if (Array.isArray(responsesRequest.input)) {
      if (responsesRequest.input.length > 0) {
        const lastInputItem = [ ...responsesRequest.input ].reverse().find(item => item && (item.content && typeof item.content === "string" || item.content && Array.isArray(item.content) && item.content.some(c => c && c.text) || item.role === "user" && item.content));
        if (lastInputItem) {
          if (typeof lastInputItem.content === "string") {
            inputContent = lastInputItem.content;
          } else if (Array.isArray(lastInputItem.content)) {
            inputContent = lastInputItem.content.filter(block => block && block.text).map(block => block.text).join(" ");
          } else {
            inputContent = JSON.stringify(lastInputItem.content || lastInputItem);
          }
        }
      }
    }
    if (inputContent) {
      geminiRequest.contents.push({
        role: "user",
        parts: [ {
          text: inputContent
        } ]
      });
    }
  } else {
    geminiRequest.contents.push({
      role: "user",
      parts: [ {
        text: "Hello"
      } ]
    });
  }
  const generationConfig = {};
  generationConfig.maxOutputTokens = checkAndAssignOrDefault(responsesRequest.max_tokens, DEFAULT_GEMINI_MAX_TOKENS);
  generationConfig.temperature = checkAndAssignOrDefault(responsesRequest.temperature, DEFAULT_TEMPERATURE);
  generationConfig.topP = checkAndAssignOrDefault(responsesRequest.top_p, DEFAULT_TOP_P);
  if (Object.keys(generationConfig).length > 0) {
    geminiRequest.generationConfig = generationConfig;
  }
  if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
    geminiRequest.tools = [ {
      functionDeclarations: responsesRequest.tools.filter(tool => tool && (tool.type === "function" || tool.function)).map(tool => {
        const func = tool.function || tool;
        return {
          name: String(func.name || tool.name || ""),
          description: String(func.description || tool.description || ""),
          parameters: func.parameters || tool.parameters || {
            type: "object",
            properties: {}
          }
        };
      }).filter(Boolean)
    } ];
    if (geminiRequest.tools[0].functionDeclarations.length === 0) {
      delete geminiRequest.tools;
    }
  }
  return geminiRequest;
}

export function toOpenAIResponsesStreamChunkFromClaude(claudeChunk, model, requestId = null) {
  if (!claudeChunk) {
    return [];
  }
  const id = requestId || Date.now().toString();
  if (!requestId) {
    streamStateManager.setModel(id, model);
  }
  let content = "";
  if (typeof claudeChunk === "string") {
    content = claudeChunk;
  } else if (claudeChunk && typeof claudeChunk === "object" && claudeChunk.delta?.text) {
    content = claudeChunk.delta.text;
  } else if (claudeChunk && typeof claudeChunk === "object") {
    content = claudeChunk;
  }
  const state = streamStateManager.getOrCreateState(id);
  if (state.fullText === "" && !requestId) {
    state.fullText = content;
    return [ generateOutputTextDelta(id, content) ];
  } else if (content === "") {
    const doneEvents = getOpenAIResponsesStreamChunkEnd(id);
    streamStateManager.cleanup(id);
    return doneEvents;
  } else {
    streamStateManager.updateText(id, content);
    return [ generateOutputTextDelta(id, content) ];
  }
}

export function toOpenAIResponsesStreamChunkFromGemini(geminiChunk, model, requestId = null) {
  if (!geminiChunk) {
    return [];
  }
  const id = requestId || Date.now().toString();
  if (!requestId) {
    streamStateManager.setModel(id, model);
  }
  let content = "";
  if (typeof geminiChunk === "string") {
    content = geminiChunk;
  } else if (geminiChunk && typeof geminiChunk === "object") {
    content = geminiChunk.content || geminiChunk.text || geminiChunk;
  }
  const state = streamStateManager.getOrCreateState(id);
  if (state.fullText === "" && !requestId) {
    state.fullText = content;
    return [ generateOutputTextDelta(id, content) ];
  } else if (content === "") {
    const doneEvents = getOpenAIResponsesStreamChunkEnd(id);
    streamStateManager.cleanup(id);
    return doneEvents;
  } else {
    streamStateManager.updateText(id, content);
    return [ generateOutputTextDelta(id, content) ];
  }
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