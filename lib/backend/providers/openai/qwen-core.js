import axios from "axios";

import logger from "../../utils/logger.js";

import crypto from "crypto";

import path from "node:path";

import { promises as fs, unlinkSync } from "node:fs";

import * as os from "os";

import * as http from "http";

import * as https from "https";

import open from "open";

import { EventEmitter } from "events";

import { randomUUID } from "node:crypto";

import { getProviderModels } from "../provider-models.js";

import { handleQwenOAuth } from "../../auth/oauth-handlers.js";

import { configureAxiosProxy, configureTLSSidecar } from "../../utils/proxy-utils.js";

import { isRetryableNetworkError, MODEL_PROVIDER, formatExpiryLog } from "../../utils/common.js";

import { getProviderPoolManager } from "../../services/service-manager.js";

const QWEN_DIR = ".qwen";

const QWEN_CREDENTIAL_FILENAME = "oauth_creds.json";

const QWEN_MODELS = getProviderModels(MODEL_PROVIDER.QWEN_API);

const QWEN_MODEL_LIST = QWEN_MODELS.map(id => ({
  id: id,
  name: id.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ")
}));

const TOKEN_REFRESH_BUFFER_MS = 30 * 1e3;

const LOCK_TIMEOUT_MS = 1e4;

const CACHE_CHECK_INTERVAL_MS = 1e3;

const DEFAULT_LOCK_CONFIG = {
  maxAttempts: 50,
  attemptInterval: 200
};

const DEFAULT_QWEN_OAUTH_BASE_URL = "https://chat.qwen.ai";

const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

const QWEN_OAUTH_CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";

const QWEN_OAUTH_SCOPE = "openid profile email model.completion";

const QWEN_OAUTH_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export const QwenOAuth2Event = {
  AuthUri: "auth-uri",
  AuthProgress: "auth-progress",
  AuthCancel: "auth-cancel"
};

export const qwenOAuth2Events = new EventEmitter;

async function commonFetch(url, options = {}, useSystemProxy = false) {
  const defaultOptions = {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    }
  };
  const mergedOptions = {
    ...defaultOptions,
    ...options,
    headers: {
      ...defaultOptions.headers,
      ...options.headers
    }
  };
  if (!useSystemProxy && typeof mergedOptions.agent === "undefined") {
    logger.debug("[Qwen] System proxy disabled for fetch request");
  }
  const response = await fetch(url, mergedOptions);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
    error.status = response.status;
    error.data = errorData;
    throw error;
  }
  return await response.json();
}

function generateCodeVerifier() {
  return crypto.randomBytes(32).toString("base64url");
}

function generateCodeChallenge(codeVerifier) {
  const hash = crypto.createHash("sha256");
  hash.update(codeVerifier);
  return hash.digest("base64url");
}

function generatePKCEPair() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  return {
    code_verifier: codeVerifier,
    code_challenge: codeChallenge
  };
}

function objectToUrlEncoded(data) {
  return Object.keys(data).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`).join("&");
}

function isDeviceAuthorizationSuccess(response) {
  return "device_code" in response;
}

function isDeviceTokenSuccess(response) {
  return "access_token" in response && response.access_token !== null && response.access_token !== undefined && typeof response.access_token === "string" && response.access_token.length > 0;
}

function isDeviceTokenPending(response) {
  return "status" in response && response.status === "pending";
}

function isErrorResponse(response) {
  return "error" in response;
}

export const TokenError = {
  REFRESH_FAILED: "REFRESH_FAILED",
  NO_REFRESH_TOKEN: "NO_REFRESH_TOKEN",
  LOCK_TIMEOUT: "LOCK_TIMEOUT",
  FILE_ACCESS_ERROR: "FILE_ACCESS_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR"
};

export class TokenManagerError extends Error {
  constructor(type, message, originalError) {
    super(message);
    this.type = type;
    this.originalError = originalError;
    this.name = "TokenManagerError";
  }
}

export class CredentialsClearRequiredError extends Error {
  constructor(message, originalError) {
    super(message);
    this.name = "CredentialsClearRequiredError";
    this.originalError = originalError;
  }
}

export class QwenApiService {
  constructor(config) {
    this.config = config;
    this.isInitialized = false;
    this.sharedManager = SharedTokenManager.getInstance();
    this.currentAxiosInstance = null;
    this.tokenManagerOptions = {
      credentialFilePath: this._getQwenCachedCredentialPath()
    };
    this.useSystemProxy = config?.USE_SYSTEM_PROXY_QWEN ?? false;
    this.uuid = config.uuid;
    this.baseUrl = config.QWEN_BASE_URL || DEFAULT_QWEN_BASE_URL;
    const oauthBaseUrl = config.QWEN_OAUTH_BASE_URL || DEFAULT_QWEN_OAUTH_BASE_URL;
    this.oauthDeviceCodeEndpoint = `${oauthBaseUrl}/api/v1/oauth2/device/code`;
    this.oauthTokenEndpoint = `${oauthBaseUrl}/api/v1/oauth2/token`;
    logger.info(`[Qwen] System proxy ${this.useSystemProxy ? "enabled" : "disabled"}`);
    this.qwenClient = new QwenOAuth2Client(config, this.useSystemProxy);
  }
  async initialize() {
    if (this.isInitialized) return;
    logger.info("[Qwen] Initializing Qwen API Service...");
    await this.loadCredentials();
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
        Authorization: `Bearer `
      }
    };
    if (!this.useSystemProxy) {
      axiosConfig.proxy = false;
    }
    configureAxiosProxy(axiosConfig, this.config, "openai-qwen-oauth");
    this.currentAxiosInstance = axios.create(axiosConfig);
    this.isInitialized = true;
    logger.info("[Qwen] Initialization complete.");
  }
  _applySidecar(axiosConfig) {
    return configureTLSSidecar(axiosConfig, this.config, MODEL_PROVIDER.QWEN_API, this.baseUrl);
  }
  async loadCredentials() {
    try {
      const keyFile = this._getQwenCachedCredentialPath();
      const creds = await fs.readFile(keyFile, "utf-8");
      const credentials = JSON.parse(creds);
      this.qwenClient.setCredentials(credentials);
      logger.info("[Qwen Auth] Credentials loaded successfully from file.");
    } catch (error) {
      if (error.code === "ENOENT") {
        logger.debug("[Qwen Auth] No cached credentials found.");
      } else {
        logger.warn(`[Qwen Auth] Failed to load credentials from file: ${error.message}`);
      }
    }
  }
  async _initializeAuth(forceRefresh = false) {
    await this.loadCredentials();
    try {
      const credentials = await this.sharedManager.getValidCredentials(this.qwenClient, forceRefresh, this.tokenManagerOptions);
      this.qwenClient.setCredentials(credentials);
      if (forceRefresh || credentials && credentials.access_token) {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.QWEN_API, this.uuid);
        }
      }
    } catch (error) {
      logger.debug("Shared token manager failed, attempting device flow:", error);
      if (error instanceof TokenManagerError) {
        switch (error.type) {
         case TokenError.NO_REFRESH_TOKEN:
          logger.debug("No refresh token available, proceeding with device flow");
          break;

         case TokenError.REFRESH_FAILED:
          logger.debug("Token refresh failed, proceeding with device flow");
          break;

         case TokenError.NETWORK_ERROR:
          logger.warn("Network error during token refresh, trying device flow");
          break;

         default:
          logger.warn("Token manager error:", error.message);
        }
      }
      if (await this._loadCachedQwenCredentials(this.qwenClient)) {
        logger.info("[Qwen] Using cached OAuth credentials.");
        return;
      }
      const result = await this._authWithQwenDeviceFlow(this.qwenClient, this.config);
      if (!result.success) {
        if (result.reason === "timeout") {
          qwenOAuth2Events.emit(QwenOAuth2Event.AuthProgress, "timeout", "Authentication timed out. Please try again or select a different authentication method.");
        }
        switch (result.reason) {
         case "timeout":
          throw new Error("Qwen OAuth authentication timed out");

         case "cancelled":
          throw new Error("Qwen OAuth authentication was cancelled by user");

         case "rate_limit":
          throw new Error("Too many request for Qwen OAuth authentication, please try again later.");

         case "error":
         default:
          throw new Error("Qwen OAuth authentication failed");
        }
      } else {
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.QWEN_API, this.uuid);
        }
      }
    }
  }
  async initializeAuth(forceRefresh = false) {
    return this._initializeAuth(forceRefresh);
  }
  async _authWithQwenDeviceFlow(client, config) {
    try {
      const {authUrl: authUrl, authInfo: authInfo} = await handleQwenOAuth(config);
      qwenOAuth2Events.emit(QwenOAuth2Event.AuthUri, {
        verification_uri_complete: authUrl,
        user_code: authInfo.userCode,
        verification_uri: authInfo.verificationUri,
        device_code: authInfo.deviceCode,
        expires_in: authInfo.expiresIn,
        interval: authInfo.interval
      });
      const showFallbackMessage = () => {
        logger.info("\n=== Qwen OAuth Device Authorization ===");
        logger.info("Please visit the following URL in your browser to authorize:");
        logger.info(`\n${authUrl}\n`);
        logger.info("Waiting for authorization to complete...\n");
      };
      if (config) {
        try {
          const childProcess = await open(authUrl);
          if (childProcess) {
            childProcess.on("error", () => showFallbackMessage());
          }
        } catch (_err) {
          showFallbackMessage();
        }
      } else {
        showFallbackMessage();
      }
      qwenOAuth2Events.emit(QwenOAuth2Event.AuthProgress, "polling", "Waiting for authorization...");
      logger.debug("Waiting for authorization...\n");
      const credPath = this._getQwenCachedCredentialPath();
      const credentials = await new Promise((resolve, reject) => {
        const checkInterval = setInterval(async () => {
          try {
            const data = await fs.readFile(credPath, "utf8");
            const creds = JSON.parse(data);
            if (creds.access_token) {
              clearInterval(checkInterval);
              logger.info("[Qwen Auth] New token obtained successfully.");
              resolve(creds);
            }
          } catch (error) {}
        }, 1e3);
        setTimeout(() => {
          clearInterval(checkInterval);
          reject(new Error("[Qwen Auth] OAuth 授权超时"));
        }, 5 * 60 * 1e3);
      });
      client.setCredentials(credentials);
      qwenOAuth2Events.emit(QwenOAuth2Event.AuthProgress, "success", "Authentication successful! Access token obtained.");
      return {
        success: true
      };
    } catch (error) {
      logger.error("Device authorization flow failed:", error.message);
      qwenOAuth2Events.emit(QwenOAuth2Event.AuthProgress, "error", error.message);
      return {
        success: false,
        reason: "error"
      };
    }
  }
  _getQwenCachedCredentialPath() {
    if (this.config && this.config.QWEN_OAUTH_CREDS_FILE_PATH) {
      return path.resolve(this.config.QWEN_OAUTH_CREDS_FILE_PATH);
    }
    return path.join(os.homedir(), QWEN_DIR, QWEN_CREDENTIAL_FILENAME);
  }
  async _loadCachedQwenCredentials(client) {
    try {
      const keyFile = this._getQwenCachedCredentialPath();
      const creds = await fs.readFile(keyFile, "utf-8");
      const credentials = JSON.parse(creds);
      client.setCredentials(credentials);
      const hasToken = !!credentials?.access_token;
      const notExpired = !!credentials?.expiry_date && Date.now() < credentials.expiry_date - TOKEN_REFRESH_BUFFER_MS;
      return hasToken && notExpired;
    } catch (_) {
      return false;
    }
  }
  async _cacheQwenCredentials(credentials) {
    const filePath = this._getQwenCachedCredentialPath();
    try {
      await fs.mkdir(path.dirname(filePath), {
        recursive: true
      });
      const credString = JSON.stringify(credentials, null, 2);
      await fs.writeFile(filePath, credString);
      logger.info(`[Qwen Auth] Credentials cached to ${filePath}`);
    } catch (error) {
      logger.error(`[Qwen Auth] Failed to cache credentials to ${filePath}: ${error.message}`);
    }
  }
  getCurrentEndpoint(resourceUrl) {
    const baseEndpoint = resourceUrl || this.baseUrl;
    const suffix = "/v1";
    const normalizedUrl = baseEndpoint.startsWith("http") ? baseEndpoint : `https://${baseEndpoint}`;
    return normalizedUrl.endsWith(suffix) ? normalizedUrl : `${normalizedUrl}${suffix}`;
  }
  isAuthError(error) {
    if (!error) return false;
    const errorMessage = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const errorCode = error?.status || error?.code || error.response?.status;
    const code = String(errorCode);
    return code.startsWith("401") || code.startsWith("403") || errorMessage.includes("unauthorized") || errorMessage.includes("forbidden") || errorMessage.includes("invalid api key") || errorMessage.includes("invalid access token") || errorMessage.includes("token expired") || errorMessage.includes("authentication") || errorMessage.includes("access denied");
  }
  async getValidToken() {
    try {
      const credentials = await this.sharedManager.getValidCredentials(this.qwenClient, false, this.tokenManagerOptions);
      if (!credentials.access_token) throw new Error("No access token available");
      return {
        token: credentials.access_token,
        endpoint: this.getCurrentEndpoint(credentials.resource_url)
      };
    } catch (error) {
      if (this.isAuthError(error)) throw error;
      logger.warn("Failed to get token from shared manager:", error);
      throw new Error("Failed to obtain valid Qwen access token. Please re-authenticate.");
    }
  }
  processMessageContent(requestBody) {
    if (!requestBody || !requestBody.messages || !Array.isArray(requestBody.messages)) {
      return requestBody;
    }
    const processedMessages = requestBody.messages.map(message => {
      if (message.content && Array.isArray(message.content)) {
        const stringifiedContent = message.content.map(item => typeof item === "string" ? item : item.text);
        return {
          ...message,
          content: stringifiedContent.join("\n")
        };
      }
      return message;
    });
    return {
      ...requestBody,
      messages: processedMessages
    };
  }
  async callApiWithAuthAndRetry(endpoint, body, isStream = false, retryCount = 0) {
    const maxRetries = this.config && this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config && this.config.REQUEST_BASE_DELAY || 1e3;
    const version = "0.10.1";
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    logger.info(`[QwenApiService] User-Agent: ${userAgent}`);
    try {
      const {token: token, endpoint: qwenBaseUrl} = await this.getValidToken();
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
        baseURL: qwenBaseUrl,
        httpAgent: httpAgent,
        httpsAgent: httpsAgent,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "X-DashScope-CacheControl": "enable",
          "X-DashScope-UserAgent": userAgent,
          "X-DashScope-AuthType": "qwen-oauth"
        }
      };
      if (!this.useSystemProxy) {
        axiosConfig.proxy = false;
      }
      configureAxiosProxy(axiosConfig, this.config, "openai-qwen-oauth");
      this.currentAxiosInstance = axios.create(axiosConfig);
      const processedBody = body;
      if (processedBody.model && !QWEN_MODEL_LIST.some(model => model.id === processedBody.model)) {
        logger.warn(`[QwenApiService] Model '${processedBody.model}' not found. Using default model: '${QWEN_MODEL_LIST[0].id}'`);
        processedBody.model = QWEN_MODEL_LIST[0].id;
      }
      const defaultTools = [ {
        type: "function",
        function: {
          name: "ext"
        }
      } ];
      const mergedTools = processedBody.tools ? [ ...defaultTools, ...processedBody.tools ] : defaultTools;
      const requestBody = isStream ? {
        ...processedBody,
        stream: true,
        tools: mergedTools
      } : {
        ...processedBody,
        tools: mergedTools
      };
      const axiosRequestConfig = {
        method: "post",
        url: endpoint,
        data: requestBody,
        ...isStream ? {
          responseType: "stream"
        } : {}
      };
      this._applySidecar(axiosRequestConfig);
      const response = await this.currentAxiosInstance.request(axiosRequestConfig);
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data || error.message;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      if (this.isAuthError(error) && retryCount === 0) {
        logger.warn(`[QwenApiService] Auth error (${status}). Triggering background refresh via PoolManager...`);
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          logger.info(`[Qwen] Marking credential ${this.uuid} as needs refresh. Reason: Auth Error ${status}`);
          poolManager.markProviderNeedRefresh(MODEL_PROVIDER.QWEN_API, {
            uuid: this.uuid
          });
          error.credentialMarkedUnhealthy = true;
        }
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if ((status === 429 || status >= 500 && status < 600) && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[QwenApiService] Status ${status}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApiWithAuthAndRetry(endpoint, body, isStream, retryCount + 1);
      }
      if (isNetworkError && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        const errorIdentifier = errorCode || errorMessage.substring(0, 50);
        logger.info(`[QwenApiService] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApiWithAuthAndRetry(endpoint, body, isStream, retryCount + 1);
      }
      logger.error(`[QwenApiService] Error calling API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
      throw error;
    }
  }
  async generateContent(model, requestBody) {
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
        logger.info(`[Qwen] Token is near expiry, marking credential ${this.uuid} for refresh`);
        poolManager.markProviderNeedRefresh(MODEL_PROVIDER.QWEN_API, {
          uuid: this.uuid
        });
      }
    }
    return this.callApiWithAuthAndRetry("/chat/completions", requestBody, false);
  }
  async* generateContentStream(model, requestBody) {
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
        logger.info(`[Qwen] Token is near expiry, marking credential ${this.uuid} for refresh`);
        poolManager.markProviderNeedRefresh(MODEL_PROVIDER.QWEN_API, {
          uuid: this.uuid
        });
      }
    }
    const stream = await this.callApiWithAuthAndRetry("/chat/completions", requestBody, true);
    let buffer = "";
    for await (const chunk of stream) {
      buffer += chunk.toString();
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.substring(0, newlineIndex).trim();
        buffer = buffer.substring(newlineIndex + 1);
        if (line.startsWith("data: ")) {
          const jsonData = line.substring(6).trim();
          if (jsonData === "[DONE]") return;
          try {
            yield JSON.parse(jsonData);
          } catch (e) {
            logger.warn("[QwenApiService] Failed to parse stream chunk:", jsonData);
          }
        }
      }
    }
  }
  async listModels() {
    return {
      data: QWEN_MODEL_LIST
    };
  }
  isExpiryDateNear() {
    try {
      const credentials = this.qwenClient.getCredentials();
      if (!credentials || !credentials.expiry_date) {
        return false;
      }
      const nearMinutes = 20;
      const {message: message, isNearExpiry: isNearExpiry} = formatExpiryLog("Qwen", credentials.expiry_date, nearMinutes);
      logger.info(message);
      return isNearExpiry;
    } catch (error) {
      logger.error(`[Qwen] Error checking expiry date: ${error.message}`);
      return false;
    }
  }
}

class SharedTokenManager {
  static instance=null;
  constructor() {
    this.contexts = new Map;
    this.lockPaths = new Set;
    this.cleanupHandlersRegistered = false;
    this.cleanupFunction = null;
    this.sigintHandler = null;
    this.registerCleanupHandlers();
  }
  static getInstance() {
    if (!SharedTokenManager.instance) {
      SharedTokenManager.instance = new SharedTokenManager;
    }
    return SharedTokenManager.instance;
  }
  getContext(options = {}) {
    const credentialFilePath = this.resolveCredentialFilePath(options.credentialFilePath);
    const lockFilePath = this.resolveLockFilePath(credentialFilePath, options.lockFilePath);
    let context = this.contexts.get(credentialFilePath);
    if (!context) {
      context = {
        credentialFilePath: credentialFilePath,
        lockFilePath: lockFilePath,
        lockConfig: options.lockConfig || DEFAULT_LOCK_CONFIG,
        memoryCache: {
          credentials: null,
          fileModTime: 0,
          lastCheck: 0
        },
        refreshPromise: null
      };
      this.contexts.set(credentialFilePath, context);
      this.lockPaths.add(lockFilePath);
    } else if (options.lockConfig) {
      context.lockConfig = options.lockConfig;
    }
    return context;
  }
  resolveCredentialFilePath(customPath) {
    if (customPath) {
      return path.resolve(customPath);
    }
    return path.join(os.homedir(), QWEN_DIR, QWEN_CREDENTIAL_FILENAME);
  }
  resolveLockFilePath(credentialFilePath, customLockPath) {
    if (customLockPath) {
      return path.resolve(customLockPath);
    }
    return `${credentialFilePath}.lock`;
  }
  registerCleanupHandlers() {
    if (this.cleanupHandlersRegistered) return;
    this.cleanupFunction = () => {
      for (const lockPath of this.lockPaths) {
        try {
          unlinkSync(lockPath);
        } catch (_error) {}
      }
    };
    this.sigintHandler = () => {
      this.cleanupFunction();
      process.exit(0);
    };
    process.on("exit", this.cleanupFunction);
    process.on("SIGINT", this.sigintHandler);
    this.cleanupHandlersRegistered = true;
  }
  async getValidCredentials(qwenClient, forceRefresh = false, options = {}) {
    const context = this.getContext(options);
    try {
      await this.checkAndReloadIfNeeded(context);
      if (!forceRefresh && context.memoryCache.credentials && this.isTokenValid(context.memoryCache.credentials)) {
        return context.memoryCache.credentials;
      }
      if (context.refreshPromise) {
        return context.refreshPromise;
      }
      qwenClient.setCredentials(context.memoryCache.credentials);
      context.refreshPromise = this.performTokenRefresh(context, qwenClient, forceRefresh);
      const credentials = await context.refreshPromise;
      context.refreshPromise = null;
      return credentials;
    } catch (error) {
      context.refreshPromise = null;
      if (error instanceof TokenManagerError) throw error;
      throw new TokenManagerError(TokenError.REFRESH_FAILED, `Failed to get valid credentials: ${error.message}`, error);
    }
  }
  async checkAndReloadIfNeeded(context) {
    const now = Date.now();
    if (now - context.memoryCache.lastCheck < CACHE_CHECK_INTERVAL_MS) return;
    context.memoryCache.lastCheck = now;
    try {
      const stats = await fs.stat(context.credentialFilePath);
      if (stats.mtimeMs > context.memoryCache.fileModTime) {
        await this.reloadCredentialsFromFile(context);
        context.memoryCache.fileModTime = stats.mtimeMs;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        context.memoryCache.credentials = null;
        context.memoryCache.fileModTime = 0;
        throw new TokenManagerError(TokenError.FILE_ACCESS_ERROR, `Failed to access credentials file: ${error.message}`, error);
      }
      context.memoryCache.credentials = null;
      context.memoryCache.fileModTime = 0;
    }
  }
  async reloadCredentialsFromFile(context) {
    try {
      const content = await fs.readFile(context.credentialFilePath, "utf-8");
      context.memoryCache.credentials = JSON.parse(content);
    } catch (_error) {
      context.memoryCache.credentials = null;
    }
  }
  async performTokenRefresh(context, qwenClient, forceRefresh = false) {
    const currentCredentials = qwenClient.getCredentials() || context.memoryCache.credentials;
    if (!currentCredentials || !currentCredentials.refresh_token) {
      throw new TokenManagerError(TokenError.NO_REFRESH_TOKEN, "No refresh token available");
    }
    try {
      await this.acquireLock(context);
      try {
        await this.checkAndReloadIfNeeded(context);
        if (!forceRefresh && context.memoryCache.credentials && this.isTokenValid(context.memoryCache.credentials)) {
          qwenClient.setCredentials(context.memoryCache.credentials);
          return context.memoryCache.credentials;
        }
        const response = await qwenClient.refreshAccessToken();
        if (!response || isErrorResponse(response)) {
          throw new TokenManagerError(TokenError.REFRESH_FAILED, `Token refresh failed: ${response?.error}`);
        }
        if (!response.access_token) {
          throw new TokenManagerError(TokenError.REFRESH_FAILED, "No access token in refresh response");
        }
        const newCredentials = {
          access_token: response.access_token,
          token_type: response.token_type,
          refresh_token: response.refresh_token || currentCredentials.refresh_token,
          resource_url: response.resource_url,
          expiry_date: Date.now() + response.expires_in * 1e3
        };
        context.memoryCache.credentials = newCredentials;
        qwenClient.setCredentials(newCredentials);
        await this.saveCredentialsToFile(context, newCredentials);
        logger.info("[Qwen Auth] Token refresh response: ok");
        return newCredentials;
      } finally {
        await this.releaseLock(context);
      }
    } catch (error) {
      if (error instanceof TokenManagerError) throw error;
      if (error instanceof CredentialsClearRequiredError) {
        try {
          await fs.unlink(context.credentialFilePath);
          logger.info("[Qwen Auth] Credentials cleared due to refresh token expiry");
        } catch (_) {}
        throw error;
      }
      if (error && (error.status === 400 || /expired|invalid/i.test(error.message || ""))) {
        try {
          await fs.unlink(context.credentialFilePath);
        } catch (_) {}
      }
      throw new TokenManagerError(TokenError.REFRESH_FAILED, `Unexpected error during token refresh: ${error.message}`, error);
    }
  }
  async saveCredentialsToFile(context, credentials) {
    try {
      await fs.mkdir(path.dirname(context.credentialFilePath), {
        recursive: true,
        mode: 448
      });
      await fs.writeFile(context.credentialFilePath, JSON.stringify(credentials, null, 2), {
        mode: 384
      });
      const stats = await fs.stat(context.credentialFilePath);
      context.memoryCache.fileModTime = stats.mtimeMs;
    } catch (error) {
      logger.error(`[Qwen Auth] Failed to save credentials to ${context.credentialFilePath}: ${error.message}`);
    }
  }
  isTokenValid(credentials) {
    return credentials?.expiry_date && Date.now() < credentials.expiry_date - TOKEN_REFRESH_BUFFER_MS;
  }
  async acquireLock(context) {
    const {maxAttempts: maxAttempts, attemptInterval: attemptInterval} = context.lockConfig || DEFAULT_LOCK_CONFIG;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        await fs.writeFile(context.lockFilePath, randomUUID(), {
          flag: "wx"
        });
        return;
      } catch (error) {
        if (error.code === "EEXIST") {
          try {
            const stats = await fs.stat(context.lockFilePath);
            if (Date.now() - stats.mtimeMs > LOCK_TIMEOUT_MS) {
              await fs.unlink(context.lockFilePath);
              continue;
            }
          } catch (_statError) {}
          await new Promise(resolve => setTimeout(resolve, attemptInterval));
        } else {
          throw new TokenManagerError(TokenError.FILE_ACCESS_ERROR, `Failed to create lock file: ${error.message}`, error);
        }
      }
    }
    throw new TokenManagerError(TokenError.LOCK_TIMEOUT, "Lock acquisition timeout");
  }
  async releaseLock(context) {
    try {
      await fs.unlink(context.lockFilePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.warn(`Failed to release lock: ${error.message}`);
      }
    }
  }
}

class QwenOAuth2Client {
  credentials={};
  constructor(config, useSystemProxy = false) {
    this.config = config;
    this.useSystemProxy = useSystemProxy;
    const oauthBaseUrl = config.QWEN_OAUTH_BASE_URL || DEFAULT_QWEN_OAUTH_BASE_URL;
    this.oauthDeviceCodeEndpoint = `${oauthBaseUrl}/api/v1/oauth2/device/code`;
    this.oauthTokenEndpoint = `${oauthBaseUrl}/api/v1/oauth2/token`;
  }
  setCredentials(credentials) {
    this.credentials = credentials;
  }
  getCredentials() {
    return this.credentials;
  }
  async refreshAccessToken() {
    if (!this.credentials.refresh_token) throw new Error("No refresh token");
    const bodyData = {
      grant_type: "refresh_token",
      refresh_token: this.credentials.refresh_token,
      client_id: QWEN_OAUTH_CLIENT_ID
    };
    try {
      const endpoint = this.oauthTokenEndpoint;
      const response = await commonFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: objectToUrlEncoded(bodyData)
      }, this.useSystemProxy);
      return response;
    } catch (error) {
      const errorData = error.data || {};
      if (error.status === 400) {
        throw new CredentialsClearRequiredError("刷新令牌已过期或无效。请使用 '/auth' 重新认证。", {
          status: error.status,
          response: errorData
        });
      }
      throw new Error(`Token refresh failed: ${error.status || "Unknown"} - ${errorData.error_description || error.message || "No details"}`);
    }
  }
  async requestDeviceAuthorization(options) {
    const bodyData = {
      client_id: QWEN_OAUTH_CLIENT_ID,
      scope: options.scope,
      code_challenge: options.code_challenge,
      code_challenge_method: options.code_challenge_method
    };
    try {
      const endpoint = this.oauthDeviceCodeEndpoint;
      const response = await commonFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: objectToUrlEncoded(bodyData)
      }, this.useSystemProxy);
      return response;
    } catch (error) {
      throw new Error(`Device authorization failed: ${error.status || error.message}`);
    }
  }
  async pollDeviceToken(options) {
    const bodyData = {
      grant_type: QWEN_OAUTH_GRANT_TYPE,
      client_id: QWEN_OAUTH_CLIENT_ID,
      device_code: options.device_code,
      code_verifier: options.code_verifier
    };
    try {
      const endpoint = this.oauthTokenEndpoint;
      const response = await commonFetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: objectToUrlEncoded(bodyData)
      }, this.useSystemProxy);
      return response;
    } catch (error) {
      const errorData = error.data || {};
      const status = error.status;
      if (status === 400 && errorData.error === "authorization_pending") {
        return {
          status: "pending"
        };
      }
      if (status === 429 && errorData.error === "slow_down") {
        return {
          status: "pending",
          slowDown: true
        };
      }
      const err = new Error(`Device token poll failed: ${errorData.error || "Unknown error"} - ${errorData.error_description || "No details provided"}`);
      err.status = status;
      throw err;
    }
  }
}