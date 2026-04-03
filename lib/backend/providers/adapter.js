import { OpenAIResponsesApiService } from "./openai/openai-responses-core.js";

import { GeminiApiService } from "./gemini/gemini-core.js";

import { AntigravityApiService } from "./gemini/antigravity-core.js";

import { OpenAIApiService } from "./openai/openai-core.js";

import { ClaudeApiService } from "./claude/claude-core.js";

import { KiroApiService } from "./claude/claude-kiro.js";

import { QwenApiService } from "./openai/qwen-core.js";

import { IFlowApiService } from "./openai/iflow-core.js";

import { CodexApiService } from "./openai/codex-core.js";

import { ForwardApiService } from "./forward/forward-core.js";

import { GrokApiService } from "./grok/grok-core.js";

import { GigaChatApiService } from "./gigachat/gigachat-core.js";

import { MODEL_PROVIDER } from "../utils/common.js";

import logger from "../utils/logger.js";

const adapterRegistry = new Map;

export function registerAdapter(provider, adapterClass) {
  logger.info(`[Adapter] Registering adapter for provider: ${provider}`);
  adapterRegistry.set(provider, adapterClass);
}

export function getRegisteredProviders() {
  return Array.from(adapterRegistry.keys());
}

export class ApiServiceAdapter {
  constructor() {
    if (new.target === ApiServiceAdapter) {
      throw new TypeError("Cannot construct ApiServiceAdapter instances directly");
    }
  }
  async generateContent(model, requestBody) {
    throw new Error("Method 'generateContent()' must be implemented.");
  }
  async* generateContentStream(model, requestBody) {
    throw new Error("Method 'generateContentStream()' must be implemented.");
  }
  async listModels() {
    throw new Error("Method 'listModels()' must be implemented.");
  }
  async refreshToken() {
    throw new Error("Method 'refreshToken()' must be implemented.");
  }
  async forceRefreshToken() {
    throw new Error("Method 'forceRefreshToken()' must be implemented.");
  }
  isExpiryDateNear() {
    throw new Error("Method 'isExpiryDateNear()' must be implemented.");
  }
}

export class GeminiApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.geminiApiService = new GeminiApiService(config);
  }
  async generateContent(model, requestBody) {
    if (!this.geminiApiService.isInitialized) {
      logger.warn("geminiApiService not initialized, attempting to re-initialize...");
      await this.geminiApiService.initialize();
    }
    return this.geminiApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    if (!this.geminiApiService.isInitialized) {
      logger.warn("geminiApiService not initialized, attempting to re-initialize...");
      await this.geminiApiService.initialize();
    }
    yield* this.geminiApiService.generateContentStream(model, requestBody);
  }
  async listModels() {
    if (!this.geminiApiService.isInitialized) {
      logger.warn("geminiApiService not initialized, attempting to re-initialize...");
      await this.geminiApiService.initialize();
    }
    return this.geminiApiService.listModels();
  }
  async refreshToken() {
    if (!this.geminiApiService.isInitialized) {
      await this.geminiApiService.initialize();
    }
    if (this.isExpiryDateNear() === true) {
      logger.info(`[Gemini] Expiry date is near, refreshing token...`);
      return this.geminiApiService.initializeAuth(true);
    }
    return Promise.resolve();
  }
  async forceRefreshToken() {
    if (!this.geminiApiService.isInitialized) {
      await this.geminiApiService.initialize();
    }
    logger.info(`[Gemini] Force refreshing token...`);
    return this.geminiApiService.initializeAuth(true);
  }
  isExpiryDateNear() {
    return this.geminiApiService.isExpiryDateNear();
  }
  async getUsageLimits() {
    if (!this.geminiApiService.isInitialized) {
      logger.warn("geminiApiService not initialized, attempting to re-initialize...");
      await this.geminiApiService.initialize();
    }
    return this.geminiApiService.getUsageLimits();
  }
}

export class AntigravityApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.antigravityApiService = new AntigravityApiService(config);
  }
  async generateContent(model, requestBody) {
    if (!this.antigravityApiService.isInitialized) {
      logger.warn("antigravityApiService not initialized, attempting to re-initialize...");
      await this.antigravityApiService.initialize();
    }
    return this.antigravityApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    if (!this.antigravityApiService.isInitialized) {
      logger.warn("antigravityApiService not initialized, attempting to re-initialize...");
      await this.antigravityApiService.initialize();
    }
    yield* this.antigravityApiService.generateContentStream(model, requestBody);
  }
  async listModels() {
    if (!this.antigravityApiService.isInitialized) {
      logger.warn("antigravityApiService not initialized, attempting to re-initialize...");
      await this.antigravityApiService.initialize();
    }
    return this.antigravityApiService.listModels();
  }
  async refreshToken() {
    if (!this.antigravityApiService.isInitialized) {
      await this.antigravityApiService.initialize();
    }
    if (this.isExpiryDateNear() === true) {
      logger.info(`[Antigravity] Expiry date is near, refreshing token...`);
      return this.antigravityApiService.initializeAuth(true);
    }
    return Promise.resolve();
  }
  async forceRefreshToken() {
    if (!this.antigravityApiService.isInitialized) {
      await this.antigravityApiService.initialize();
    }
    logger.info(`[Antigravity] Force refreshing token...`);
    return this.antigravityApiService.initializeAuth(true);
  }
  isExpiryDateNear() {
    return this.antigravityApiService.isExpiryDateNear();
  }
  async getUsageLimits() {
    if (!this.antigravityApiService.isInitialized) {
      logger.warn("antigravityApiService not initialized, attempting to re-initialize...");
      await this.antigravityApiService.initialize();
    }
    return this.antigravityApiService.getUsageLimits();
  }
}

export class OpenAIApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.openAIApiService = new OpenAIApiService(config);
  }
  async generateContent(model, requestBody) {
    return this.openAIApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    const stream = this.openAIApiService.generateContentStream(model, requestBody);
    yield* stream;
  }
  async listModels() {
    return this.openAIApiService.listModels();
  }
  async refreshToken() {
    return Promise.resolve();
  }
  async forceRefreshToken() {
    return Promise.resolve();
  }
  isExpiryDateNear() {
    return false;
  }
}

export class OpenAIResponsesApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.openAIResponsesApiService = new OpenAIResponsesApiService(config);
  }
  async generateContent(model, requestBody) {
    return this.openAIResponsesApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    const stream = this.openAIResponsesApiService.generateContentStream(model, requestBody);
    yield* stream;
  }
  async listModels() {
    return this.openAIResponsesApiService.listModels();
  }
  async refreshToken() {
    return Promise.resolve();
  }
  async forceRefreshToken() {
    return Promise.resolve();
  }
  isExpiryDateNear() {
    return false;
  }
}

export class ClaudeApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.claudeApiService = new ClaudeApiService(config);
  }
  async generateContent(model, requestBody) {
    return this.claudeApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    const stream = this.claudeApiService.generateContentStream(model, requestBody);
    yield* stream;
  }
  async listModels() {
    return this.claudeApiService.listModels();
  }
  async refreshToken() {
    return Promise.resolve();
  }
  async forceRefreshToken() {
    return Promise.resolve();
  }
  isExpiryDateNear() {
    return false;
  }
}

export class KiroApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.kiroApiService = new KiroApiService(config);
  }
  async generateContent(model, requestBody) {
    if (!this.kiroApiService.isInitialized) {
      logger.warn("kiroApiService not initialized, attempting to re-initialize...");
      await this.kiroApiService.initialize();
    }
    return this.kiroApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    if (!this.kiroApiService.isInitialized) {
      logger.warn("kiroApiService not initialized, attempting to re-initialize...");
      await this.kiroApiService.initialize();
    }
    const stream = this.kiroApiService.generateContentStream(model, requestBody);
    yield* stream;
  }
  async listModels() {
    if (!this.kiroApiService.isInitialized) {
      logger.warn("kiroApiService not initialized, attempting to re-initialize...");
      await this.kiroApiService.initialize();
    }
    return this.kiroApiService.listModels();
  }
  async refreshToken() {
    if (!this.kiroApiService.isInitialized) {
      await this.kiroApiService.initialize();
    }
    if (this.isExpiryDateNear() === true) {
      logger.info(`[Kiro] Expiry date is near, refreshing token...`);
      return this.kiroApiService.initializeAuth(true);
    }
    return Promise.resolve();
  }
  async forceRefreshToken() {
    if (!this.kiroApiService.isInitialized) {
      await this.kiroApiService.initialize();
    }
    logger.info(`[Kiro] Force refreshing token...`);
    return this.kiroApiService.initializeAuth(true);
  }
  isExpiryDateNear() {
    return this.kiroApiService.isExpiryDateNear();
  }
  async getUsageLimits() {
    if (!this.kiroApiService.isInitialized) {
      logger.warn("kiroApiService not initialized, attempting to re-initialize...");
      await this.kiroApiService.initialize();
    }
    return this.kiroApiService.getUsageLimits();
  }
  countTokens(requestBody) {
    return this.kiroApiService.countTokens(requestBody);
  }
}

export class QwenApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.qwenApiService = new QwenApiService(config);
  }
  async generateContent(model, requestBody) {
    if (!this.qwenApiService.isInitialized) {
      logger.warn("qwenApiService not initialized, attempting to re-initialize...");
      await this.qwenApiService.initialize();
    }
    return this.qwenApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    if (!this.qwenApiService.isInitialized) {
      logger.warn("qwenApiService not initialized, attempting to re-initialize...");
      await this.qwenApiService.initialize();
    }
    yield* this.qwenApiService.generateContentStream(model, requestBody);
  }
  async listModels() {
    if (!this.qwenApiService.isInitialized) {
      logger.warn("qwenApiService not initialized, attempting to re-initialize...");
      await this.qwenApiService.initialize();
    }
    return this.qwenApiService.listModels();
  }
  async refreshToken() {
    if (!this.qwenApiService.isInitialized) {
      await this.qwenApiService.initialize();
    }
    if (this.isExpiryDateNear()) {
      logger.info(`[Qwen] Expiry date is near, refreshing token...`);
      return this.qwenApiService._initializeAuth(true);
    }
    return Promise.resolve();
  }
  async forceRefreshToken() {
    if (!this.qwenApiService.isInitialized) {
      await this.qwenApiService.initialize();
    }
    logger.info(`[Qwen] Force refreshing token...`);
    return this.qwenApiService._initializeAuth(true);
  }
  isExpiryDateNear() {
    return this.qwenApiService.isExpiryDateNear();
  }
}

export class IFlowApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.iflowApiService = new IFlowApiService(config);
  }
  async generateContent(model, requestBody) {
    if (!this.iflowApiService.isInitialized) {
      logger.warn("iflowApiService not initialized, attempting to re-initialize...");
      await this.iflowApiService.initialize();
    }
    return this.iflowApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    if (!this.iflowApiService.isInitialized) {
      logger.warn("iflowApiService not initialized, attempting to re-initialize...");
      await this.iflowApiService.initialize();
    }
    yield* this.iflowApiService.generateContentStream(model, requestBody);
  }
  async listModels() {
    if (!this.iflowApiService.isInitialized) {
      logger.warn("iflowApiService not initialized, attempting to re-initialize...");
      await this.iflowApiService.initialize();
    }
    return this.iflowApiService.listModels();
  }
  async refreshToken() {
    if (!this.iflowApiService.isInitialized) {
      await this.iflowApiService.initialize();
    }
    if (this.isExpiryDateNear()) {
      logger.info(`[iFlow] Expiry date is near, refreshing API key...`);
      await this.iflowApiService.initializeAuth(true);
    }
    return Promise.resolve();
  }
  async forceRefreshToken() {
    if (!this.iflowApiService.isInitialized) {
      await this.iflowApiService.initialize();
    }
    logger.info(`[iFlow] Force refreshing API key...`);
    return this.iflowApiService.initializeAuth(true);
  }
  isExpiryDateNear() {
    return this.iflowApiService.isExpiryDateNear();
  }
}

export class CodexApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.codexApiService = new CodexApiService(config);
  }
  async generateContent(model, requestBody) {
    if (!this.codexApiService.isInitialized) {
      logger.warn("codexApiService not initialized, attempting to re-initialize...");
      await this.codexApiService.initialize();
    }
    return this.codexApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    if (!this.codexApiService.isInitialized) {
      logger.warn("codexApiService not initialized, attempting to re-initialize...");
      await this.codexApiService.initialize();
    }
    yield* this.codexApiService.generateContentStream(model, requestBody);
  }
  async listModels() {
    return this.codexApiService.listModels();
  }
  async refreshToken() {
    if (!this.codexApiService.isInitialized) {
      await this.codexApiService.initialize();
    }
    if (this.isExpiryDateNear()) {
      logger.info(`[Codex] Expiry date is near, refreshing token...`);
      await this.codexApiService.initializeAuth(true);
    }
    return Promise.resolve();
  }
  async forceRefreshToken() {
    if (!this.codexApiService.isInitialized) {
      await this.codexApiService.initialize();
    }
    logger.info(`[Codex] Force refreshing token...`);
    return this.codexApiService.initializeAuth(true);
  }
  isExpiryDateNear() {
    return this.codexApiService.isExpiryDateNear();
  }
  async getUsageLimits() {
    if (!this.codexApiService.isInitialized) {
      logger.warn("codexApiService not initialized, attempting to re-initialize...");
      await this.codexApiService.initialize();
    }
    return this.codexApiService.getUsageLimits();
  }
}

export class ForwardApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.forwardApiService = new ForwardApiService(config);
  }
  async generateContent(model, requestBody) {
    return this.forwardApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    yield* this.forwardApiService.generateContentStream(model, requestBody);
  }
  async listModels() {
    return this.forwardApiService.listModels();
  }
  async refreshToken() {
    return Promise.resolve();
  }
  async forceRefreshToken() {
    return Promise.resolve();
  }
  isExpiryDateNear() {
    return false;
  }
}

export class GrokApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.grokApiService = new GrokApiService(config);
  }
  async generateContent(model, requestBody) {
    if (!this.grokApiService.isInitialized) {
      await this.grokApiService.initialize();
    }
    return this.grokApiService.generateContent(model, requestBody);
  }
  async* generateContentStream(model, requestBody) {
    if (!this.grokApiService.isInitialized) {
      await this.grokApiService.initialize();
    }
    yield* this.grokApiService.generateContentStream(model, requestBody);
  }
  async listModels() {
    if (!this.grokApiService.isInitialized) {
      await this.grokApiService.initialize();
    }
    return this.grokApiService.listModels();
  }
  async refreshToken() {
    return this.grokApiService.refreshToken();
  }
  async forceRefreshToken() {
    return this.grokApiService.refreshToken();
  }
  isExpiryDateNear() {
    return this.grokApiService.isExpiryDateNear();
  }
  async getUsageLimits() {
    if (!this.grokApiService.isInitialized) {
      await this.grokApiService.initialize();
    }
    return this.grokApiService.getUsageLimits();
  }
}

export class GigaChatApiServiceAdapter extends ApiServiceAdapter {
  constructor(config) {
    super();
    this.gigachatApiService = new GigaChatApiService(config);
  }
  async generateContent(model, requestBody) {
    return this.gigachatApiService.generateContent(requestBody, false);
  }
  async* generateContentStream(model, requestBody) {
    const stream = await this.gigachatApiService.generateContent(requestBody, true);
    yield* stream;
  }
  async listModels() {
    return { data: [{ id: 'GigaChat' }, { id: 'GigaChat-2' }, { id: 'GigaChat-Max' }, { id: 'GigaChat-Pro' }] };
  }
  async refreshToken() {
    return this.gigachatApiService.getAccessToken(false);
  }
  async forceRefreshToken() {
    return this.gigachatApiService.getAccessToken(true);
  }
  isExpiryDateNear() {
    const now = Date.now();
    return this.gigachatApiService.tokenExpiresAt < now + 300000;
  }
}

registerAdapter(MODEL_PROVIDER.OPENAI_CUSTOM, OpenAIApiServiceAdapter);

registerAdapter(MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES, OpenAIResponsesApiServiceAdapter);

registerAdapter(MODEL_PROVIDER.GEMINI_CLI, GeminiApiServiceAdapter);

registerAdapter(MODEL_PROVIDER.ANTIGRAVITY, AntigravityApiServiceAdapter);

registerAdapter(MODEL_PROVIDER.CLAUDE_CUSTOM, ClaudeApiServiceAdapter);

registerAdapter(MODEL_PROVIDER.KIRO_API, KiroApiServiceAdapter);

registerAdapter(MODEL_PROVIDER.QWEN_API, QwenApiServiceAdapter);

registerAdapter(MODEL_PROVIDER.CODEX_API, CodexApiServiceAdapter);

registerAdapter(MODEL_PROVIDER.GROK_CUSTOM, GrokApiServiceAdapter);

registerAdapter(MODEL_PROVIDER.GIGACHAT_API, GigaChatApiServiceAdapter);

export const serviceInstances = {};

export function getServiceAdapter(config) {
  const customNameDisplay = config.customName ? ` (${config.customName})` : "";
  logger.info(`[Adapter] getServiceAdapter, provider: ${config.MODEL_PROVIDER}, uuid: ${config.uuid}${customNameDisplay}`);
  const provider = config.MODEL_PROVIDER;
  const providerKey = config.uuid ? provider + config.uuid : provider;
  if (!serviceInstances[providerKey]) {
    const AdapterClass = adapterRegistry.get(provider);
    if (AdapterClass) {
      serviceInstances[providerKey] = new AdapterClass(config);
    } else {
      throw new Error(`Unsupported model provider: ${provider}`);
    }
  }
  return serviceInstances[providerKey];
}