import axios from "axios";

import logger from "../../utils/logger.js";

import crypto from "crypto";

import { promises as fs } from "fs";

import path from "path";

import os from "os";

import { refreshCodexTokensWithRetry } from "../../auth/oauth-handlers.js";

import { getProviderPoolManager } from "../../services/service-manager.js";

import { configureTLSSidecar } from "../../utils/proxy-utils.js";

import { MODEL_PROVIDER, formatExpiryLog } from "../../utils/common.js";

import { getProxyConfigForProvider } from "../../utils/proxy-utils.js";

import { getProviderModels } from "../provider-models.js";

const baseModels = getProviderModels(MODEL_PROVIDER.CODEX_API);

const fastModels = baseModels.map(m => `${m}-fast`);

const CODEX_MODELS = [ ...new Set([ ...baseModels, ...fastModels ]) ];

const CODEX_VERSION = "0.111.0";

export class CodexApiService {
  constructor(config) {
    this.config = config;
    this.baseUrl = config.CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex";
    this.accessToken = null;
    this.refreshToken = null;
    this.accountId = null;
    this.email = null;
    this.expiresAt = null;
    this.idToken = null;
    this.last_refresh = null;
    this.credsPath = null;
    this.uuid = config.uuid;
    this.isInitialized = false;
    this.conversationCache = new Map;
    this.startCacheCleanup();
  }
  _applySidecar(axiosConfig) {
    return configureTLSSidecar(axiosConfig, this.config, MODEL_PROVIDER.CODEX_API, this.baseUrl);
  }
  async initialize() {
    if (this.isInitialized) return;
    logger.info("[Codex] Initializing Codex API Service...");
    await this.loadCredentials();
    this.isInitialized = true;
    logger.info(`[Codex] Initialization complete. Account: ${this.email || "unknown"}`);
  }
  async loadCredentials() {
    const email = this.config.CODEX_EMAIL || "default";
    try {
      let creds;
      let credsPath;
      if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
        credsPath = this.config.CODEX_OAUTH_CREDS_FILE_PATH;
        const exists = await this.fileExists(credsPath);
        if (!exists) {
          throw new Error("Codex credentials not found. Please authenticate first using OAuth.");
        }
        creds = JSON.parse(await fs.readFile(credsPath, "utf8"));
      } else {
        const projectDir = process.cwd();
        const targetDir = path.join(projectDir, "configs", "codex");
        const files = await fs.readdir(targetDir);
        const matchingFile = files.filter(f => f.includes(`codex-${email}`) && f.endsWith(".json")).sort().pop();
        if (!matchingFile) {
          throw new Error("Codex credentials not found. Please authenticate first using OAuth.");
        }
        credsPath = path.join(targetDir, matchingFile);
        creds = JSON.parse(await fs.readFile(credsPath, "utf8"));
      }
      this.credsPath = credsPath;
      this.idToken = creds.id_token || this.idToken;
      this.accessToken = creds.access_token;
      this.refreshToken = creds.refresh_token;
      this.accountId = creds.account_id;
      this.email = creds.email;
      this.last_refresh = creds.last_refresh || this.last_refresh;
      this.expiresAt = new Date(creds.expired);
      if (this.isExpiryDateNear()) {
        this.triggerBackgroundRefresh();
      }
      this.isInitialized = true;
      logger.info(`[Codex] Initialized with account: ${this.email}`);
    } catch (error) {
      logger.warn(`[Codex Auth] Failed to load credentials: ${error.message}`);
    }
  }
  async initializeAuth(forceRefresh = false) {
    const needsRefresh = forceRefresh;
    if (this.accessToken && !needsRefresh) {
      return;
    }
    await this.loadCredentials();
    if (needsRefresh || !this.accessToken) {
      if (!this.refreshToken) {
        throw new Error("Codex credentials not found. Please authenticate first using OAuth.");
      }
      logger.info("[Codex] Token expiring soon or refresh requested, refreshing...");
      await this.refreshAccessToken();
    }
  }
  triggerBackgroundRefresh() {
    const poolManager = getProviderPoolManager();
    if (poolManager && this.uuid) {
      logger.info(`[Codex] Token is near expiry, marking credential ${this.uuid} for background refresh`);
      poolManager.markProviderNeedRefresh(MODEL_PROVIDER.CODEX_API, {
        uuid: this.uuid
      });
    }
  }
  async generateContent(model, requestBody) {
    if (!this.isInitialized) {
      await this.initialize();
    }
    let selectedModel = model;
    if (!CODEX_MODELS.includes(model)) {
      const defaultModel = CODEX_MODELS[0] || "gpt-5";
      logger.warn(`[Codex] Model '${model}' not found in supported list. Falling back to default: '${defaultModel}'`);
      selectedModel = defaultModel;
    }
    if (requestBody._monitorRequestId) {
      this.config._monitorRequestId = requestBody._monitorRequestId;
      delete requestBody._monitorRequestId;
    }
    if (requestBody._requestBaseUrl) {
      delete requestBody._requestBaseUrl;
    }
    if (this.isExpiryDateNear()) {
      this.triggerBackgroundRefresh();
    }
    const url = `${this.baseUrl}/responses`;
    const body = await this.prepareRequestBody(selectedModel, requestBody, true);
    const headers = this.buildHeaders(body.prompt_cache_key, true);
    try {
      const config = {
        headers: headers,
        responseType: "text",
        timeout: 12e4
      };
      const proxyConfig = getProxyConfigForProvider(this.config, "openai-codex-oauth");
      if (proxyConfig) {
        config.httpAgent = proxyConfig.httpAgent;
        config.httpsAgent = proxyConfig.httpsAgent;
      }
      const axiosRequestConfig = {
        method: "post",
        url: url,
        data: body,
        ...config
      };
      this._applySidecar(axiosRequestConfig);
      const response = await axios.request(axiosRequestConfig);
      return this.parseNonStreamResponse(response.data);
    } catch (error) {
      if (error.response?.status === 401) {
        logger.info("[Codex] Received 401. Triggering background refresh...");
        this.triggerBackgroundRefresh();
        error.credentialMarkedUnhealthy = true;
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      } else {
        logger.error(`[Codex] Error calling non-stream API (Status: ${error.response?.status}, Code: ${error.code || "N/A"}):`, error.message);
        throw error;
      }
    }
  }
  async* generateContentStream(model, requestBody) {
    if (!this.isInitialized) {
      await this.initialize();
    }
    let selectedModel = model;
    if (!CODEX_MODELS.includes(model)) {
      const defaultModel = CODEX_MODELS[0] || "gpt-5";
      logger.warn(`[Codex] Model '${model}' not found in supported list. Falling back to default: '${defaultModel}'`);
      selectedModel = defaultModel;
    }
    if (requestBody._monitorRequestId) {
      this.config._monitorRequestId = requestBody._monitorRequestId;
      delete requestBody._monitorRequestId;
    }
    if (requestBody._requestBaseUrl) {
      delete requestBody._requestBaseUrl;
    }
    if (this.isExpiryDateNear()) {
      this.triggerBackgroundRefresh();
    }
    const url = `${this.baseUrl}/responses`;
    const body = await this.prepareRequestBody(selectedModel, requestBody, true);
    const headers = this.buildHeaders(body.prompt_cache_key, true);
    try {
      const config = {
        headers: headers,
        responseType: "stream",
        timeout: 12e4
      };
      const proxyConfig = getProxyConfigForProvider(this.config, "openai-codex-oauth");
      if (proxyConfig) {
        config.httpAgent = proxyConfig.httpAgent;
        config.httpsAgent = proxyConfig.httpsAgent;
      }
      const axiosRequestConfig = {
        method: "post",
        url: url,
        data: body,
        ...config
      };
      this._applySidecar(axiosRequestConfig);
      const response = await axios.request(axiosRequestConfig);
      yield* this.parseSSEStream(response.data);
    } catch (error) {
      if (error.response?.status === 401) {
        logger.info("[Codex] Received 401 during stream. Triggering background refresh...");
        this.triggerBackgroundRefresh();
        error.credentialMarkedUnhealthy = true;
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      } else {
        logger.error(`[Codex] Error calling streaming API (Status: ${error.response?.status}, Code: ${error.code || "N/A"}):`, error.message);
        throw error;
      }
    }
  }
  buildHeaders(cacheId, stream = true) {
    const headers = {
      version: CODEX_VERSION,
      "x-codex-beta-features": "powershell_utf8",
      "x-oai-web-search-eligible": "true",
      authorization: `Bearer ${this.accessToken}`,
      "chatgpt-account-id": this.accountId,
      "content-type": "application/json",
      "user-agent": `codex_cli_rs/${CODEX_VERSION} (Windows 10.0.26100; x86_64) WindowsTerminal`,
      originator: "codex_cli_rs",
      host: "chatgpt.com",
      Connection: "Keep-Alive"
    };
    if (cacheId) {
      headers["Conversation_id"] = cacheId;
      headers["Session_id"] = cacheId;
    }
    if (stream) {
      headers["accept"] = "text/event-stream";
    } else {
      headers["accept"] = "application/json";
    }
    return headers;
  }
  async prepareRequestBody(model, requestBody, stream) {
    const metadata = requestBody.metadata || {};
    const sessionId = metadata.session_id || metadata.conversation_id || metadata.user_id || "default";
    const normalizedModel = String(model || "").trim();
    const isFastModel = /-fast$/i.test(normalizedModel);
    const upstreamModel = isFastModel ? normalizedModel.replace(/-fast$/i, "") : normalizedModel;
    const defaultServiceTier = isFastModel ? "priority" : "default";
    const defaultReasoningEffort = isFastModel ? "xhigh" : "medium";
    const cleanedBody = {
      ...requestBody
    };
    delete cleanedBody.metadata;
    cleanedBody.model = upstreamModel;
    if (isFastModel) {
      logger.info(`[Codex] Detected -fast model: ${normalizedModel} -> ${upstreamModel}, service_tier: ${cleanedBody.service_tier || defaultServiceTier}`);
    }
    let cacheKey = sessionId;
    if (sessionId === "default") {
      cacheKey = `${model}-default`;
    }
    let cache = this.conversationCache.get(cacheKey);
    if (!cache || cache.expire < Date.now()) {
      cache = {
        id: crypto.randomUUID(),
        expire: Date.now() + 36e5
      };
      this.conversationCache.set(cacheKey, cache);
    }
    const result = {
      ...cleanedBody,
      service_tier: cleanedBody.service_tier || defaultServiceTier,
      reasoning: {
        ...cleanedBody.reasoning,
        effort: isFastModel ? defaultReasoningEffort : cleanedBody.reasoning?.effort
      },
      stream: stream,
      prompt_cache_key: cache.id
    };
    if (result.service_tier !== "priority") {
      delete result.service_tier;
    }
    if (this.config?._monitorRequestId) {
      try {
        const {getPluginManager: getPluginManager} = await import("../../core/plugin-manager.js");
        const pluginManager = getPluginManager();
        if (pluginManager) {
          await pluginManager.executeHook("onInternalRequestConverted", {
            requestId: this.config._monitorRequestId,
            internalRequest: result,
            converterName: "prepareRequestBody"
          });
        }
      } catch (e) {
        logger.error("[Codex] Error calling onInternalRequestConverted hook:", e.message);
      }
    }
    return result;
  }
  async refreshAccessToken() {
    try {
      const newTokens = await refreshCodexTokensWithRetry(this.refreshToken, this.config);
      this.idToken = newTokens.id_token || this.idToken;
      this.accessToken = newTokens.access_token;
      this.refreshToken = newTokens.refresh_token;
      this.accountId = newTokens.account_id;
      this.email = newTokens.email;
      this.last_refresh = (new Date).toISOString();
      const expiredValue = newTokens.expired || newTokens.expire || newTokens.expires_at || newTokens.expiresAt;
      const parsedExpiry = expiredValue ? new Date(expiredValue) : null;
      if (!parsedExpiry || Number.isNaN(parsedExpiry.getTime())) {
        this.expiresAt = new Date(Date.now() + 3600 * 1e3);
        logger.warn("[Codex] Token refresh did not include a valid expiry time; falling back to 1h from now");
      } else {
        this.expiresAt = parsedExpiry;
      }
      await this.saveCredentials();
      const poolManager = getProviderPoolManager();
      if (poolManager && this.uuid) {
        poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.CODEX_API, this.uuid);
      }
      logger.info("[Codex] Token refreshed successfully");
    } catch (error) {
      logger.error("[Codex] Failed to refresh token:", error.message);
      throw new Error("Failed to refresh Codex token. Please re-authenticate.");
    }
  }
  isExpiryDateNear() {
    if (!this.expiresAt) return true;
    const expiry = this.expiresAt.getTime();
    if (Number.isNaN(expiry)) {
      logger.warn("[Codex] expiresAt is invalid (NaN). Treating as near expiry to force refresh");
      return true;
    }
    const nearMinutes = 20;
    const {message: message, isNearExpiry: isNearExpiry} = formatExpiryLog("Codex", expiry, nearMinutes);
    logger.info(message);
    return isNearExpiry;
  }
  getCredentialsPath() {
    const email = this.config.CODEX_EMAIL || this.email || "default";
    if (this.config.CODEX_OAUTH_CREDS_FILE_PATH) {
      return this.config.CODEX_OAUTH_CREDS_FILE_PATH;
    }
    if (this.credsPath) {
      return this.credsPath;
    }
    const projectDir = process.cwd();
    return path.join(projectDir, "configs", "codex", `${Date.now()}_codex-${email}.json`);
  }
  async saveCredentials() {
    const credsPath = this.getCredentialsPath();
    const credsDir = path.dirname(credsPath);
    if (!this.expiresAt || Number.isNaN(this.expiresAt.getTime())) {
      throw new Error("Invalid expiresAt when saving Codex credentials");
    }
    await fs.mkdir(credsDir, {
      recursive: true
    });
    await fs.writeFile(credsPath, JSON.stringify({
      id_token: this.idToken || "",
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      account_id: this.accountId,
      last_refresh: this.last_refresh || (new Date).toISOString(),
      email: this.email,
      type: "codex",
      expired: this.expiresAt.toISOString()
    }, null, 2), {
      mode: 384
    });
    this.credsPath = credsPath;
  }
  async fileExists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  async* parseSSEStream(stream) {
    let buffer = "";
    for await (const chunk of stream) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data && data !== "[DONE]") {
            try {
              const parsed = JSON.parse(data);
              yield parsed;
            } catch (e) {
              logger.error("[Codex] Failed to parse SSE data:", e.message);
            }
          }
        }
      }
    }
    if (buffer.trim()) {
      if (buffer.startsWith("data: ")) {
        const data = buffer.slice(6).trim();
        if (data && data !== "[DONE]") {
          try {
            const parsed = JSON.parse(data);
            yield parsed;
          } catch (e) {
            logger.error("[Codex] Failed to parse final SSE data:", e.message);
          }
        }
      }
    }
  }
  parseNonStreamResponse(data) {
    const responseText = typeof data === "string" ? data : String(data);
    const lines = responseText.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const jsonData = line.slice(6).trim();
        if (!jsonData || jsonData === "[DONE]") {
          continue;
        }
        try {
          const parsed = JSON.parse(jsonData);
          if (parsed.type === "response.completed") {
            return parsed;
          }
        } catch (e) {
          logger.debug("[Codex] Failed to parse SSE line:", e.message);
        }
      }
    }
    logger.error("[Codex] No completed response found in Codex response");
    throw new Error("stream error: stream disconnected before completion: stream closed before response.completed");
  }
  async listModels() {
    return {
      object: "list",
      data: CODEX_MODELS.map(id => ({
        id: id,
        object: "model",
        created: Math.floor(Date.now() / 1e3),
        owned_by: "openai"
      }))
    };
  }
  startCacheCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, cache] of this.conversationCache.entries()) {
        if (cache.expire < now) {
          this.conversationCache.delete(key);
        }
      }
    }, 15 * 60 * 1e3);
  }
  stopCacheCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
  async getUsageLimits() {
    if (!this.isInitialized) {
      await this.initialize();
    }
    try {
      const url = "https://chatgpt.com/backend-api/wham/usage";
      const headers = {
        "user-agent": `codex_cli_rs/${CODEX_VERSION} (Windows 10.0.26100; x86_64) WindowsTerminal`,
        authorization: `Bearer ${this.accessToken}`,
        "chatgpt-account-id": this.accountId,
        accept: "*/*",
        host: "chatgpt.com",
        Connection: "close"
      };
      const config = {
        headers: headers,
        timeout: 3e4
      };
      const proxyConfig = getProxyConfigForProvider(this.config, "openai-codex-oauth");
      if (proxyConfig) {
        config.httpAgent = proxyConfig.httpAgent;
        config.httpsAgent = proxyConfig.httpsAgent;
      }
      const axiosRequestConfig = {
        method: "get",
        url: url,
        ...config
      };
      this._applySidecar(axiosRequestConfig);
      const response = await axios.request(axiosRequestConfig);
      const data = response.data;
      const result = {
        lastUpdated: Date.now(),
        models: {}
      };
      if (data.rate_limit) {
        const primaryWindow = data.rate_limit.primary_window;
        const secondaryWindow = data.rate_limit.secondary_window;
        if (primaryWindow) {
          const remaining = 1 - (primaryWindow.used_percent || 0) / 100;
          const resetTime = primaryWindow.reset_at ? new Date(primaryWindow.reset_at * 1e3).toISOString() : null;
          const codexModels = [ "default" ];
          for (const modelId of codexModels) {
            result.models[modelId] = {
              remaining: Math.max(0, Math.min(1, remaining)),
              resetTime: resetTime,
              resetTimeRaw: primaryWindow.reset_at
            };
          }
        }
      }
      result.raw = {
        planType: data.plan_type || "unknown",
        rateLimit: data.rate_limit,
        codeReviewRateLimit: data.code_review_rate_limit,
        credits: data.credits
      };
      logger.info(`[Codex] Successfully fetched usage limits for plan: ${result.raw.planType}`);
      return result;
    } catch (error) {
      if (error.response?.status === 401) {
        logger.info("[Codex] Received 401 during getUsageLimits. Triggering background refresh...");
        this.triggerBackgroundRefresh();
        error.credentialMarkedUnhealthy = true;
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
      }
      logger.error("[Codex] Failed to get usage limits:", error.message);
      throw error;
    }
  }
}