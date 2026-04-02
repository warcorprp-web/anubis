import { v4 as uuidv4 } from "uuid";

import logger from "../utils/logger.js";

export const DEFAULT_MAX_TOKENS = 8192;

export const DEFAULT_TEMPERATURE = 1;

export const DEFAULT_TOP_P = .95;

export const OPENAI_DEFAULT_MAX_TOKENS = 128e3;

export const OPENAI_DEFAULT_TEMPERATURE = 1;

export const OPENAI_DEFAULT_TOP_P = .95;

export const OPENAI_DEFAULT_INPUT_TOKEN_LIMIT = 32768;

export const OPENAI_DEFAULT_OUTPUT_TOKEN_LIMIT = 128e3;

export const CLAUDE_DEFAULT_MAX_TOKENS = 2e5;

export const CLAUDE_DEFAULT_TEMPERATURE = 1;

export const CLAUDE_DEFAULT_TOP_P = .95;

export const GEMINI_DEFAULT_MAX_TOKENS = 65534;

export const GEMINI_DEFAULT_TEMPERATURE = 1;

export const GEMINI_DEFAULT_TOP_P = .95;

export const GEMINI_DEFAULT_INPUT_TOKEN_LIMIT = 32768;

export const GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT = 65534;

export const OPENAI_RESPONSES_DEFAULT_MAX_TOKENS = 128e3;

export const OPENAI_RESPONSES_DEFAULT_TEMPERATURE = 1;

export const OPENAI_RESPONSES_DEFAULT_TOP_P = .95;

export const OPENAI_RESPONSES_DEFAULT_INPUT_TOKEN_LIMIT = 32768;

export const OPENAI_RESPONSES_DEFAULT_OUTPUT_TOKEN_LIMIT = 128e3;

export function checkAndAssignOrDefault(value, defaultValue) {
  if (value !== undefined && value !== 0) {
    return value;
  }
  return defaultValue;
}

export function generateId(prefix = "") {
  return prefix ? `${prefix}_${uuidv4()}` : uuidv4();
}

export function safeParseJSON(str) {
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

export function extractTextFromMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.filter(part => part.type === "text" && part.text).map(part => part.text).join("\n");
  }
  return "";
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

export function cleanJsonSchemaProperties(schema) {
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  if (Array.isArray(schema)) {
    return schema.map(item => cleanJsonSchemaProperties(item));
  }
  const allowedKeys = [ "type", "description", "properties", "required", "enum", "items", "nullable" ];
  const sanitized = {};
  for (const [key, value] of Object.entries(schema)) {
    if (allowedKeys.includes(key)) {
      if (key === "properties" && typeof value === "object" && value !== null) {
        const cleanProperties = {};
        for (const [propName, propSchema] of Object.entries(value)) {
          cleanProperties[propName] = cleanJsonSchemaProperties(propSchema);
        }
        sanitized[key] = cleanProperties;
      } else if (key === "items") {
        sanitized[key] = cleanJsonSchemaProperties(value);
      } else if (key === "type") {
        if (Array.isArray(value)) {
          if (value.includes("null")) {
            sanitized.nullable = true;
          }
          const actualType = value.find(t => t !== "null");
          if (actualType) {
            sanitized[key] = actualType.toUpperCase();
          }
        } else if (typeof value === "string") {
          sanitized[key] = value.toUpperCase();
        }
      } else {
        sanitized[key] = value;
      }
    }
  }
  return sanitized;
}

export function mapFinishReason(reason, sourceFormat, targetFormat) {
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

export function determineReasoningEffortFromBudget(budgetTokens) {
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

export function extractThinkingFromOpenAIText(text) {
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

export const toolStateManager = new ToolStateManager;