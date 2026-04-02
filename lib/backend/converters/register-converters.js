import { MODEL_PROTOCOL_PREFIX } from "../utils/common.js";

import { ConverterFactory } from "./ConverterFactory.js";

import { OpenAIConverter } from "./strategies/OpenAIConverter.js";

import { OpenAIResponsesConverter } from "./strategies/OpenAIResponsesConverter.js";

import { ClaudeConverter } from "./strategies/ClaudeConverter.js";

import { GeminiConverter } from "./strategies/GeminiConverter.js";

import { CodexConverter } from "./strategies/CodexConverter.js";

import { GrokConverter } from "./strategies/GrokConverter.js";

export function registerAllConverters() {
  ConverterFactory.registerConverter(MODEL_PROTOCOL_PREFIX.OPENAI, OpenAIConverter);
  ConverterFactory.registerConverter(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES, OpenAIResponsesConverter);
  ConverterFactory.registerConverter(MODEL_PROTOCOL_PREFIX.CLAUDE, ClaudeConverter);
  ConverterFactory.registerConverter(MODEL_PROTOCOL_PREFIX.GEMINI, GeminiConverter);
  ConverterFactory.registerConverter(MODEL_PROTOCOL_PREFIX.CODEX, CodexConverter);
  ConverterFactory.registerConverter(MODEL_PROTOCOL_PREFIX.GROK, GrokConverter);
}

registerAllConverters();