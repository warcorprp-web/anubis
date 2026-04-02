import axios from "axios";

import logger from "../../utils/logger.js";

import * as http from "http";

import * as https from "https";

import { promises as fs } from "fs";

import * as path from "path";

import * as os from "os";

import * as crypto from "crypto";

import { configureAxiosProxy } from "../../utils/proxy-utils.js";

import { isRetryableNetworkError, MODEL_PROVIDER, formatExpiryLog } from "../../utils/common.js";

import { getProviderPoolManager } from "../../services/service-manager.js";

import { getProviderModels } from "../provider-models.js";

const IFLOW_API_BASE_URL = "https://apis.iflow.cn/v1";

const IFLOW_USER_AGENT = "iFlow-Cli";

const IFLOW_OAUTH_TOKEN_ENDPOINT = "https://iflow.cn/oauth/token";

const IFLOW_USER_INFO_ENDPOINT = "https://iflow.cn/api/oauth/getUserInfo";

const IFLOW_OAUTH_CLIENT_ID = "10009311001";

const IFLOW_OAUTH_CLIENT_SECRET = "4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW";

const IFLOW_MODELS = getProviderModels(MODEL_PROVIDER.IFLOW_API);

const THINKING_MODEL_PREFIXES = [ "glm-", "qwen3-235b-a22b-thinking", "deepseek-r1" ];

class IFlowTokenStorage {
  constructor(data = {}) {
    this.accessToken = data.accessToken || data.access_token || "";
    this.refreshToken = data.refreshToken || data.refresh_token || "";
    this.expiryDate = data.expiryDate || data.expiry_date || "";
    this.apiKey = data.apiKey || data.api_key || "";
    this.tokenType = data.tokenType || data.token_type || "";
    this.scope = data.scope || "";
  }
  toJSON() {
    return {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expiry_date: this.expiryDate,
      token_type: this.tokenType,
      scope: this.scope,
      apiKey: this.apiKey
    };
  }
  static fromJSON(json) {
    return new IFlowTokenStorage(json);
  }
}

async function loadTokenFromFile(filePath) {
  try {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const data = await fs.readFile(absolutePath, "utf-8");
    const json = JSON.parse(data);
    const refreshToken = json.refreshToken || json.refresh_token || "";
    logger.info(`[iFlow] Token loaded from: ${filePath} (refresh_token: ${refreshToken ? refreshToken.substring(0, 8) + "..." : "EMPTY"})`);
    return IFlowTokenStorage.fromJSON(json);
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.warn(`[iFlow] Token file not found: ${filePath}`);
      return null;
    }
    throw new Error(`[iFlow] Failed to load token from file: ${error.message}`);
  }
}

async function saveTokenToFile(filePath, tokenStorage, uuid = null) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  try {
    const dir = path.dirname(absolutePath);
    await fs.mkdir(dir, {
      recursive: true
    });
    const json = tokenStorage.toJSON();
    if (!json.refresh_token || json.refresh_token.trim() === "") {
      logger.error("[iFlow] WARNING: Attempting to save token file with empty refresh_token!");
    }
    if (!json.apiKey || json.apiKey.trim() === "") {
      logger.error("[iFlow] WARNING: Attempting to save token file with empty apiKey!");
    }
    await fs.writeFile(absolutePath, JSON.stringify(json, null, 2), "utf-8");
    logger.info(`[iFlow] Token saved to: ${filePath} (refresh_token: ${json.refresh_token ? json.refresh_token.substring(0, 8) + "..." : "EMPTY"})`);
  } catch (error) {
    throw new Error(`[iFlow] Failed to save token to file: ${error.message}`);
  }
}

async function refreshOAuthTokens(refreshToken, axiosInstance = null) {
  if (!refreshToken || refreshToken.trim() === "") {
    throw new Error("[iFlow] refresh_token is empty");
  }
  logger.info("[iFlow] Refreshing OAuth tokens...");
  const params = new URLSearchParams;
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", refreshToken);
  params.append("client_id", IFLOW_OAUTH_CLIENT_ID);
  params.append("client_secret", IFLOW_OAUTH_CLIENT_SECRET);
  const basicAuth = Buffer.from(`${IFLOW_OAUTH_CLIENT_ID}:${IFLOW_OAUTH_CLIENT_SECRET}`).toString("base64");
  const requestConfig = {
    method: "POST",
    url: IFLOW_OAUTH_TOKEN_ENDPOINT,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${basicAuth}`
    },
    data: params.toString(),
    timeout: 3e4
  };
  try {
    const response = axiosInstance ? await axiosInstance.request(requestConfig) : await axios.request(requestConfig);
    const tokenResp = response.data;
    if (!tokenResp.access_token) {
      logger.error("[iFlow] Token response:", JSON.stringify(tokenResp));
      throw new Error("[iFlow] Missing access_token in response");
    }
    const expiresIn = tokenResp.expires_in || 3600;
    const expireTimestamp = Date.now() + expiresIn * 1e3;
    const tokenData = {
      accessToken: tokenResp.access_token,
      refreshToken: tokenResp.refresh_token || refreshToken,
      tokenType: tokenResp.token_type || "Bearer",
      scope: tokenResp.scope || "",
      expiryDate: expireTimestamp
    };
    logger.info("[iFlow] OAuth tokens refreshed successfully");
    const userInfo = await fetchUserInfo(tokenData.accessToken, axiosInstance);
    if (userInfo && userInfo.apiKey) {
      tokenData.apiKey = userInfo.apiKey;
      tokenData.email = userInfo.email || userInfo.phone || "";
    }
    return tokenData;
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    logger.error(`[iFlow] OAuth token refresh failed (Status: ${status}):`, data || error.message);
    throw error;
  }
}

async function fetchUserInfo(accessToken, axiosInstance = null) {
  if (!accessToken || accessToken.trim() === "") {
    throw new Error("[iFlow] access_token is empty");
  }
  const url = `${IFLOW_USER_INFO_ENDPOINT}?accessToken=${encodeURIComponent(accessToken)}`;
  const requestConfig = {
    method: "GET",
    url: url,
    headers: {
      Accept: "application/json"
    },
    timeout: 3e4
  };
  try {
    const response = axiosInstance ? await axiosInstance.request(requestConfig) : await axios.request(requestConfig);
    const result = response.data;
    if (!result.success) {
      throw new Error("[iFlow] User info request not successful");
    }
    if (!result.data || !result.data.apiKey) {
      throw new Error("[iFlow] Missing apiKey in user info response");
    }
    return {
      apiKey: result.data.apiKey,
      email: result.data.email || "",
      phone: result.data.phone || ""
    };
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    logger.error(`[iFlow] Fetch user info failed (Status: ${status}):`, data || error.message);
    throw error;
  }
}

function generateUUID() {
  return crypto.randomUUID();
}

function createIFlowSignature(userAgent, sessionID, timestamp, apiKey) {
  if (!apiKey) {
    return "";
  }
  const payload = `${userAgent}:${sessionID}:${timestamp}`;
  const hmac = crypto.createHmac("sha256", apiKey);
  hmac.update(payload);
  return hmac.digest("hex");
}

function isThinkingModel(model) {
  if (!model) return false;
  const lowerModel = model.toLowerCase();
  return THINKING_MODEL_PREFIXES.some(prefix => lowerModel.startsWith(prefix));
}

function applyIFlowThinkingConfig(body, model) {
  if (!body || !model) return body;
  const lowerModel = model.toLowerCase();
  const reasoningEffort = body.reasoning_effort;
  if (reasoningEffort === undefined) return body;
  const enableThinking = reasoningEffort !== "none" && reasoningEffort !== "";
  const newBody = {
    ...body
  };
  delete newBody.reasoning_effort;
  delete newBody.thinking;
  if (lowerModel.startsWith("glm-4")) {
    newBody.chat_template_kwargs = {
      ...newBody.chat_template_kwargs || {},
      enable_thinking: enableThinking
    };
    if (enableThinking) {
      newBody.chat_template_kwargs.clear_thinking = false;
    }
    return newBody;
  }
  if (lowerModel.includes("thinking")) {
    return newBody;
  }
  if (lowerModel.startsWith("deepseek-r1")) {
    return newBody;
  }
  return newBody;
}

function preserveReasoningContentInMessages(body, model) {
  if (!body || !model) return body;
  const lowerModel = model.toLowerCase();
  const needsPreservation = lowerModel.startsWith("glm-4") || lowerModel.startsWith("minimax-m2");
  if (!needsPreservation) {
    return body;
  }
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;
  const hasReasoningContent = messages.some(msg => msg.role === "assistant" && msg.reasoning_content && msg.reasoning_content !== "");
  if (hasReasoningContent) {
    logger.debug(`[iFlow] reasoning_content found in message history for ${model}`);
  }
  return body;
}

function ensureToolsArray(body) {
  if (!body || !body.tools) return body;
  if (Array.isArray(body.tools) && body.tools.length === 0) {
    return {
      ...body,
      tools: [ {
        type: "function",
        function: {
          name: "noop",
          description: "Placeholder tool to stabilise streaming",
          parameters: {
            type: "object"
          }
        }
      } ]
    };
  }
  return body;
}

function preprocessRequestBody(body, model) {
  let targetModel = model;
  if (Array.isArray(IFLOW_MODELS) && IFLOW_MODELS.length > 0) {
    if (!IFLOW_MODELS.includes(model)) {
      logger.warn(`[iFlow] Model "${model}" not found in IFLOW_MODELS, defaulting to "${IFLOW_MODELS[0]}"`);
      targetModel = IFLOW_MODELS[0];
    }
  }
  let processedBody = {
    ...body
  };
  processedBody.model = targetModel;
  processedBody = applyIFlowThinkingConfig(processedBody, targetModel);
  processedBody = preserveReasoningContentInMessages(processedBody, targetModel);
  processedBody = ensureToolsArray(processedBody);
  return processedBody;
}

const DEFAULT_TOKEN_FILE_PATH = path.join(os.homedir(), ".iflow", "oauth_creds.json");

export class IFlowApiService {
  constructor(config) {
    this.config = config;
    this.apiKey = null;
    this.baseUrl = config.IFLOW_BASE_URL || IFLOW_API_BASE_URL;
    this.tokenFilePath = config.IFLOW_TOKEN_FILE_PATH || DEFAULT_TOKEN_FILE_PATH;
    this.uuid = config.uuid;
    this.isInitialized = false;
    this.tokenStorage = null;
    const httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: 12e4
    });
    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: 12e4
    });
    const axiosConfig = {
      baseURL: this.baseUrl,
      httpAgent: httpAgent,
      httpsAgent: httpsAgent,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": IFLOW_USER_AGENT
      }
    };
    configureAxiosProxy(axiosConfig, config, "openai-iflow");
    this.axiosInstance = axios.create(axiosConfig);
  }
  async initialize() {
    if (this.isInitialized) return;
    logger.info("[iFlow] Initializing iFlow API Service...");
    await this.loadCredentials();
    this.isInitialized = true;
    logger.info("[iFlow] Initialization complete.");
  }
  async loadCredentials() {
    try {
      this.tokenStorage = await loadTokenFromFile(this.tokenFilePath);
      if (this.tokenStorage && this.tokenStorage.apiKey) {
        this.apiKey = this.tokenStorage.apiKey;
        this.axiosInstance.defaults.headers["Authorization"] = `Bearer ${this.apiKey}`;
        logger.info("[iFlow Auth] Credentials loaded successfully from file");
      }
    } catch (error) {
      logger.warn(`[iFlow Auth] Failed to load credentials from file: ${error.message}`);
    }
  }
  async initializeAuth(forceRefresh = false) {
    await this.loadCredentials();
    if (this.apiKey && !forceRefresh) return;
    if (!this.tokenFilePath) {
      throw new Error("[iFlow] IFLOW_TOKEN_FILE_PATH is required.");
    }
    try {
      if (!this.tokenStorage) {
        this.tokenStorage = await loadTokenFromFile(this.tokenFilePath);
        logger.info("[iFlow Auth] Loaded credentials from file");
      }
      if (this.tokenStorage && this.tokenStorage.apiKey) {
        this.apiKey = this.tokenStorage.apiKey;
        logger.info("[iFlow Auth] Authentication configured successfully from file.");
        if (forceRefresh) {
          logger.info("[iFlow Auth] Forcing token refresh...");
          await this._refreshOAuthTokens();
          logger.info("[iFlow Auth] Token refreshed and saved successfully.");
          const poolManager = getProviderPoolManager();
          if (poolManager && this.uuid) {
            poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.IFLOW_API, this.uuid);
          }
        }
      } else {
        throw new Error("[iFlow] No refresh token available in credentials.");
      }
    } catch (error) {
      logger.error("[iFlow Auth] Failed to initialize authentication:", error.message);
      throw new Error(`[iFlow Auth] Failed to load OAuth credentials.`);
    }
  }
  async _checkAndRefreshTokenIfNeeded() {
    if (!this.tokenStorage) {
      return false;
    }
    if (!this.tokenStorage.refreshToken || this.tokenStorage.refreshToken.trim() === "") {
      logger.info("[iFlow] No refresh_token available, skipping token refresh check");
      return false;
    }
    logger.info("[iFlow] Token is expiring soon, attempting refresh...");
    try {
      await this._refreshOAuthTokens();
      return true;
    } catch (error) {
      logger.error("[iFlow] Token refresh failed:", error.message);
      return false;
    }
  }
  async _refreshOAuthTokens() {
    if (!this.tokenStorage || !this.tokenStorage.refreshToken) {
      throw new Error("[iFlow] No refresh_token available");
    }
    const oldAccessToken = this.tokenStorage.accessToken;
    if (oldAccessToken) {
      logger.info(`[iFlow] Refreshing access token, old: ${this._maskToken(oldAccessToken)}`);
    }
    const oldRefreshToken = this.tokenStorage.refreshToken;
    const tokenData = await refreshOAuthTokens(oldRefreshToken, this.axiosInstance);
    this.tokenStorage.accessToken = tokenData.accessToken;
    this.tokenStorage.refreshToken = tokenData.refreshToken;
    if (tokenData.refreshToken !== oldRefreshToken) {
      logger.info(`[iFlow] refresh_token has been rotated (old: ${this._maskToken(oldRefreshToken)}, new: ${this._maskToken(tokenData.refreshToken)})`);
    }
    if (tokenData.apiKey) {
      this.tokenStorage.apiKey = tokenData.apiKey;
      this.apiKey = tokenData.apiKey;
    }
    this.tokenStorage.expiryDate = tokenData.expiryDate;
    this.tokenStorage.tokenType = tokenData.tokenType || "Bearer";
    this.tokenStorage.scope = tokenData.scope || "";
    if (tokenData.email) {
      this.tokenStorage.email = tokenData.email;
    }
    this.axiosInstance.defaults.headers["Authorization"] = `Bearer ${this.apiKey}`;
    await saveTokenToFile(this.tokenFilePath, this.tokenStorage, this.uuid);
    logger.info(`[iFlow] Token refresh successful, new: ${this._maskToken(tokenData.accessToken)}`);
  }
  _maskToken(token) {
    if (!token || token.length < 10) {
      return "***";
    }
    return `${token.substring(0, 4)}...${token.substring(token.length - 4)}`;
  }
  async refreshToken() {
    if (!this.isInitialized) {
      await this.initialize();
    }
    try {
      await this._refreshOAuthTokens();
      return true;
    } catch (error) {
      logger.error("[iFlow] Manual token refresh failed:", error.message);
      return false;
    }
  }
  isExpiryDateNear() {
    try {
      if (!this.tokenStorage || !this.tokenStorage.expiryDate) {
        return false;
      }
      const cronNearMinutes = 60 * 45;
      let expireTime;
      const expireValue = this.tokenStorage.expiryDate;
      if (typeof expireValue === "number") {
        expireTime = expireValue;
      } else if (typeof expireValue === "string") {
        if (/^\d+$/.test(expireValue)) {
          expireTime = parseInt(expireValue, 10);
        } else if (expireValue.includes("T")) {
          expireTime = new Date(expireValue).getTime();
        } else {
          expireTime = new Date(expireValue.replace(" ", "T") + ":00").getTime();
        }
      } else {
        logger.error(`[iFlow] Invalid expiry date type: ${typeof expireValue}`);
        return false;
      }
      if (isNaN(expireTime)) {
        logger.error(`[iFlow] Error parsing expiry date: ${expireValue}`);
        return false;
      }
      const {message: message, isNearExpiry: isNearExpiry} = formatExpiryLog("iFlow", expireTime, cronNearMinutes);
      logger.info(message);
      return isNearExpiry;
    } catch (error) {
      logger.error(`[iFlow] Error checking expiry date: ${error.message}`);
      return false;
    }
  }
  _getHeaders(stream = false) {
    const sessionID = "session-" + generateUUID();
    const timestamp = Date.now();
    const signature = createIFlowSignature(IFLOW_USER_AGENT, sessionID, timestamp, this.apiKey);
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": IFLOW_USER_AGENT,
      "session-id": sessionID,
      "x-iflow-timestamp": timestamp.toString()
    };
    if (signature) {
      headers["x-iflow-signature"] = signature;
    }
    if (stream) {
      headers["Accept"] = "text/event-stream";
    } else {
      headers["Accept"] = "application/json";
    }
    return headers;
  }
  async callApi(endpoint, body, model, isRetry = false, retryCount = 0) {
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    const processedBody = preprocessRequestBody(body, model);
    try {
      const response = await this.axiosInstance.post(endpoint, processedBody, {
        headers: this._getHeaders(false)
      });
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      if ((status === 400 || status === 401) && !isRetry) {
        logger.info(`[iFlow] Received ${status}. Triggering background refresh via PoolManager...`);
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          logger.info(`[iFlow] Marking credential ${this.uuid} as needs refresh. Reason: ${status} Unauthorized`);
          poolManager.markProviderNeedRefresh(MODEL_PROVIDER.IFLOW_API, {
            uuid: this.uuid
          });
          error.credentialMarkedUnhealthy = true;
        }
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 401 || status === 403) {
        logger.error(`[iFlow] Received ${status}. API Key might be invalid or expired.`);
        throw error;
      }
      if (status === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[iFlow] Received 429 (Too Many Requests). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(endpoint, body, model, isRetry, retryCount + 1);
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[iFlow] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(endpoint, body, model, isRetry, retryCount + 1);
      }
      if (isNetworkError && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        const errorIdentifier = errorCode || errorMessage.substring(0, 50);
        logger.info(`[iFlow] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(endpoint, body, model, isRetry, retryCount + 1);
      }
      logger.error(`[iFlow] Error calling API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
      throw error;
    }
  }
  async* streamApi(endpoint, body, model, isRetry = false, retryCount = 0) {
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    const processedBody = preprocessRequestBody({
      ...body,
      stream: true
    }, model);
    try {
      const response = await this.axiosInstance.post(endpoint, processedBody, {
        responseType: "stream",
        headers: this._getHeaders(true)
      });
      const stream = response.data;
      let buffer = "";
      for await (const chunk of stream) {
        buffer += chunk.toString();
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.substring(0, newlineIndex);
          buffer = buffer.substring(newlineIndex + 1);
          const trimmedLine = line.trim();
          if (trimmedLine === "") {
            continue;
          }
          if (trimmedLine.startsWith("data:")) {
            let jsonData = trimmedLine.substring(5);
            if (jsonData.startsWith(" ")) {
              jsonData = jsonData.substring(1);
            }
            jsonData = jsonData.trim();
            if (jsonData === "[DONE]") {
              return;
            }
            if (jsonData === "") {
              continue;
            }
            try {
              const parsedChunk = JSON.parse(jsonData);
              yield parsedChunk;
            } catch (e) {
              logger.warn("[iFlow] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData.substring(0, 200));
            }
          }
        }
      }
      if (buffer.trim() !== "") {
        const trimmedLine = buffer.trim();
        if (trimmedLine.startsWith("data:")) {
          let jsonData = trimmedLine.substring(5);
          if (jsonData.startsWith(" ")) {
            jsonData = jsonData.substring(1);
          }
          jsonData = jsonData.trim();
          if (jsonData !== "[DONE]" && jsonData !== "") {
            try {
              const parsedChunk = JSON.parse(jsonData);
              yield parsedChunk;
            } catch (e) {
              logger.warn("[iFlow] Failed to parse final stream chunk JSON:", e.message);
            }
          }
        }
      }
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      if ((status === 400 || status === 401) && !isRetry) {
        logger.info(`[iFlow] Received ${status} during stream. Triggering background refresh via PoolManager...`);
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          logger.info(`[iFlow] Marking credential ${this.uuid} as needs refresh. Reason: ${status} Unauthorized in stream`);
          poolManager.markProviderNeedRefresh(MODEL_PROVIDER.IFLOW_API, {
            uuid: this.uuid
          });
          error.credentialMarkedUnhealthy = true;
        }
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 401 || status === 403) {
        logger.error(`[iFlow] Received ${status} during stream. API Key might be invalid or expired.`);
        throw error;
      }
      if (status === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[iFlow] Received 429 (Too Many Requests) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(endpoint, body, model, isRetry, retryCount + 1);
        return;
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[iFlow] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(endpoint, body, model, isRetry, retryCount + 1);
        return;
      }
      if (isNetworkError && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        const errorIdentifier = errorCode || errorMessage.substring(0, 50);
        logger.info(`[iFlow] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(endpoint, body, model, isRetry, retryCount + 1);
        return;
      }
      logger.error(`[iFlow] Error calling streaming API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
      throw error;
    }
  }
  async generateContent(model, requestBody) {
    if (!this.isInitialized) {
      await this.initialize();
    }
    if (requestBody._monitorRequestId) {
      this.config._monitorRequestId = requestBody._monitorRequestId;
      delete requestBody._monitorRequestId;
    }
    if (requestBody._requestBaseUrl) {
      delete requestBody._requestBaseUrl;
    }
    if (this.isExpiryDateNear()) {
      const poolManager = getProviderPoolManager();
      if (poolManager && this.uuid) {
        logger.info(`[iFlow] Token is near expiry, marking credential ${this.uuid} for refresh`);
        poolManager.markProviderNeedRefresh(MODEL_PROVIDER.IFLOW_API, {
          uuid: this.uuid
        });
      }
    }
    return this.callApi("/chat/completions", requestBody, model);
  }
  async* generateContentStream(model, requestBody) {
    if (!this.isInitialized) {
      await this.initialize();
    }
    if (requestBody._monitorRequestId) {
      this.config._monitorRequestId = requestBody._monitorRequestId;
      delete requestBody._monitorRequestId;
    }
    if (requestBody._requestBaseUrl) {
      delete requestBody._requestBaseUrl;
    }
    if (this.isExpiryDateNear()) {
      const poolManager = getProviderPoolManager();
      if (poolManager && this.uuid) {
        logger.info(`[iFlow] Token is near expiry, marking credential ${this.uuid} for refresh`);
        poolManager.markProviderNeedRefresh(MODEL_PROVIDER.IFLOW_API, {
          uuid: this.uuid
        });
      }
    }
    yield* this.streamApi("/chat/completions", requestBody, model);
  }
  async listModels() {
    if (!this.isInitialized) {
      await this.initialize();
    }
    const manualModels = [ "glm-4.7", "glm-5", "kimi-k2.5", "minimax-m2.1", "minimax-m2.5" ];
    try {
      const response = await this.axiosInstance.get("/models", {
        headers: this._getHeaders(false)
      });
      const modelsData = response.data;
      if (modelsData && modelsData.data && Array.isArray(modelsData.data)) {
        for (const modelId of manualModels) {
          const hasModel = modelsData.data.some(model => model.id === modelId);
          if (!hasModel) {
            modelsData.data.push({
              id: modelId,
              object: "model",
              created: Math.floor(Date.now() / 1e3),
              owned_by: "iflow"
            });
            logger.info(`[iFlow] Added ${modelId} to models list`);
          }
        }
      }
      return modelsData;
    } catch (error) {
      logger.warn("[iFlow] Failed to fetch models from API, using default list:", error.message);
      const defaultModels = [ ...IFLOW_MODELS ];
      for (const modelId of manualModels) {
        if (!defaultModels.includes(modelId)) {
          defaultModels.push(modelId);
        }
      }
      return {
        object: "list",
        data: defaultModels.map(id => ({
          id: id,
          object: "model",
          created: Math.floor(Date.now() / 1e3),
          owned_by: "iflow"
        }))
      };
    }
  }
}

export { IFLOW_MODELS, IFLOW_USER_AGENT, IFlowTokenStorage, loadTokenFromFile, saveTokenToFile, refreshOAuthTokens, fetchUserInfo, isThinkingModel, applyIFlowThinkingConfig, preserveReasoningContentInMessages, ensureToolsArray, preprocessRequestBody };