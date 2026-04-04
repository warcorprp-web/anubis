import { OAuth2Client } from "google-auth-library";

import logger from "../../utils/logger.js";

import * as http from "http";

import * as https from "https";

import { promises as fs } from "fs";

import * as path from "path";

import * as os from "os";

import * as readline from "readline";

import open from "open";

import { configureTLSSidecar } from "../../utils/proxy-utils.js";

import { API_ACTIONS, formatExpiryTime, isRetryableNetworkError, formatExpiryLog } from "../../utils/common.js";

import { getProviderModels } from "../provider-models.js";

import { handleGeminiCliOAuth } from "../../auth/oauth-handlers.js";

import { getProxyConfigForProvider, getGoogleAuthProxyConfig } from "../../utils/proxy-utils.js";

import { getProviderPoolManager } from "../../services/service-manager.js";

import { MODEL_PROVIDER } from "../../utils/common.js";

const AUTH_REDIRECT_PORT = 8085;

const CREDENTIALS_DIR = ".gemini";

const CREDENTIALS_FILE = "oauth_creds.json";

const DEFAULT_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

const DEFAULT_CODE_ASSIST_API_VERSION = "v1internal";

const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";

const OAUTH_CLIENT_SECRET = "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";

const GEMINI_MODELS = getProviderModels(MODEL_PROVIDER.GEMINI_CLI);

const ANTI_TRUNCATION_MODELS = GEMINI_MODELS.map(model => `anti-${model}`);

const GEMINI_CLI_VERSION = "0.31.0";

const GEMINI_CLI_API_CLIENT_HEADER = "google-genai-sdk/1.41.0 gl-node/v22.19.0";

function applyGeminiCLIHeaders(headers, model) {
  const platform = os.platform();
  let arch = os.arch();
  if (arch === "ia32") arch = "x86";
  const modelName = model || "unknown";
  if (model !== "load-code-assist" && model !== "onboard-user") {
    headers["User-Agent"] = `GeminiCLI/${GEMINI_CLI_VERSION}/${modelName} (${platform}; ${arch})`;
  }
  headers["X-Goog-Api-Client"] = GEMINI_CLI_API_CLIENT_HEADER;
}

function parseRetryDelay(errorBody) {
  try {
    const data = typeof errorBody === "string" ? JSON.parse(errorBody) : errorBody;
    const details = data?.error?.details;
    if (Array.isArray(details)) {
      for (const detail of details) {
        if (detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo") {
          const retryDelay = detail.retryDelay;
          if (retryDelay) {
            const match = retryDelay.match(/^([\d.]+)s$/);
            if (match) return parseFloat(match[1]) * 1e3;
          }
        }
      }
      for (const detail of details) {
        if (detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo") {
          const quotaResetDelay = detail.metadata?.quotaResetDelay;
          if (quotaResetDelay) {
            const match = quotaResetDelay.match(/^([\d.]+)(ms|s)$/);
            if (match) {
              let ms = parseFloat(match[1]);
              if (match[2] === "s") ms *= 1e3;
              return ms;
            }
          }
        }
      }
    }
    const message = data?.error?.message;
    if (message) {
      const match = message.match(/after\s+(\d+)s\.?/);
      if (match) return parseInt(match[1]) * 1e3;
    }
  } catch (e) {}
  return null;
}

function is_anti_truncation_model(model) {
  return ANTI_TRUNCATION_MODELS.some(antiModel => model.includes(antiModel));
}

function extract_model_from_anti_model(model) {
  if (model.startsWith("anti-")) {
    const originalModel = model.substring(5);
    if (GEMINI_MODELS.includes(originalModel)) {
      return originalModel;
    }
  }
  return model;
}

function modelSupportsThinking(modelName) {
  if (!modelName) return false;
  const name = String(modelName).toLowerCase();
  return name.startsWith("gemini-3") || name.startsWith("gemini-2.5-") || name.includes("-thinking");
}

function normalizeGeminiThinkingRequest(modelName, requestBody) {
  if (!modelSupportsThinking(modelName)) return requestBody;
  const thinkingConfig = requestBody?.generationConfig?.thinkingConfig;
  if (!thinkingConfig) return requestBody;
  const thinkingLevel = thinkingConfig.thinkingLevel;
  const budget = thinkingConfig.thinkingBudget;
  const thinkingRequested = thinkingLevel !== undefined || budget !== undefined && budget !== 0;
  if (thinkingRequested && thinkingConfig.includeThoughts === undefined) {
    thinkingConfig.includeThoughts = true;
  }
  return requestBody;
}

function toGeminiApiResponse(codeAssistResponse) {
  if (!codeAssistResponse) return null;
  const compliantResponse = {
    candidates: codeAssistResponse.candidates
  };
  if (codeAssistResponse.usageMetadata) compliantResponse.usageMetadata = codeAssistResponse.usageMetadata;
  if (codeAssistResponse.promptFeedback) compliantResponse.promptFeedback = codeAssistResponse.promptFeedback;
  if (codeAssistResponse.automaticFunctionCallingHistory) compliantResponse.automaticFunctionCallingHistory = codeAssistResponse.automaticFunctionCallingHistory;
  return compliantResponse;
}

function ensureRolesInContents(requestBody) {
  delete requestBody.model;
  if (requestBody.system_instruction) {
    requestBody.systemInstruction = requestBody.system_instruction;
    delete requestBody.system_instruction;
  }
  if (requestBody.systemInstruction && !requestBody.systemInstruction.role) {
    requestBody.systemInstruction.role = "user";
  }
  if (requestBody.contents && Array.isArray(requestBody.contents)) {
    requestBody.contents.forEach(content => {
      if (!content.role) {
        content.role = "user";
      }
    });
  }
  return requestBody;
}

async function* apply_anti_truncation_to_stream(service, model, requestBody) {
  let currentRequest = {
    ...requestBody
  };
  let allGeneratedText = "";
  while (true) {
    const apiRequest = {
      model: model,
      project: service.projectId,
      request: currentRequest
    };
    const stream = service.streamApi(API_ACTIONS.STREAM_GENERATE_CONTENT, apiRequest, false, 0, model);
    let lastChunk = null;
    let hasContent = false;
    for await (const chunk of stream) {
      const response = toGeminiApiResponse(chunk.response);
      if (response && response.candidates && response.candidates[0]) {
        yield response;
        lastChunk = response;
        hasContent = true;
      }
    }
    if (lastChunk && lastChunk.candidates && lastChunk.candidates[0] && lastChunk.candidates[0].finishReason === "MAX_TOKENS") {
      if (lastChunk.candidates[0].content && Array.isArray(lastChunk.candidates[0].content.parts)) {
        const generatedParts = lastChunk.candidates[0].content.parts.filter(part => part?.text).map(part => part.text);
        if (generatedParts.length > 0) {
          const currentGeneratedText = generatedParts.join("");
          allGeneratedText += currentGeneratedText;
          const newContents = [ ...requestBody.contents ];
          newContents.push({
            role: "model",
            parts: [ {
              text: currentGeneratedText
            } ]
          });
          newContents.push({
            role: "user",
            parts: [ {
              text: "Please continue from where you left off."
            } ]
          });
          currentRequest = {
            ...requestBody,
            contents: newContents
          };
          continue;
        }
      }
    }
    break;
  }
}

export class GeminiApiService {
  constructor(config) {
    this.httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: 12e4
    });
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: 12e4
    });
    this.availableModels = [];
    this.isInitialized = false;
    this.config = config;
    this.host = config.HOST;
    this.oauthCredsBase64 = config.GEMINI_OAUTH_CREDS_BASE64;
    this.oauthCredsFilePath = config.GEMINI_OAUTH_CREDS_FILE_PATH;
    this.projectId = config.PROJECT_ID;
    this.codeAssistEndpoint = config.GEMINI_BASE_URL || DEFAULT_CODE_ASSIST_ENDPOINT;
    this.apiVersion = DEFAULT_CODE_ASSIST_API_VERSION;
  }
  _createAuthClient() {
    const proxyConfig = getGoogleAuthProxyConfig(this.config, "gemini-cli-oauth");
    const oauth2Options = {
      clientId: OAUTH_CLIENT_ID,
      clientSecret: OAUTH_CLIENT_SECRET
    };
    if (proxyConfig) {
      oauth2Options.transporterOptions = proxyConfig;
      logger.info("[Gemini] Using proxy for OAuth2Client");
    } else {
      oauth2Options.transporterOptions = {
        agent: this.httpsAgent
      };
    }
    return new OAuth2Client(oauth2Options);
  }
  get authClient() {
    if (!this._authClient) {
      this._authClient = this._createAuthClient();
    }
    return this._authClient;
  }
  async initialize() {
    if (this.isInitialized) return;
    logger.info("[Gemini] Initializing Gemini API Service...");
    await this.loadCredentials();
    if (!this.projectId) {
      this.projectId = await this.discoverProjectAndModels();
    } else {
      logger.info(`[Gemini] Using provided Project ID: ${this.projectId}`);
      this.availableModels = GEMINI_MODELS;
      logger.info(`[Gemini] Using fixed models: [${this.availableModels.join(", ")}]`);
    }
    if (this.projectId === "default") {
      throw new Error("Error: 'default' is not a valid project ID. Please provide a valid Google Cloud Project ID using the --project-id argument.");
    }
    this.isInitialized = true;
    logger.info(`[Gemini] Initialization complete. Project ID: ${this.projectId}`);
  }
  _applySidecar(requestOptions) {
    return configureTLSSidecar(requestOptions, this.config, MODEL_PROVIDER.GEMINI_CLI);
  }
  async loadCredentials() {
    if (this.oauthCredsBase64) {
      try {
        const decoded = Buffer.from(this.oauthCredsBase64, "base64").toString("utf8");
        const credentials = JSON.parse(decoded);
        this.authClient.setCredentials(credentials);
        logger.info("[Gemini Auth] Credentials loaded successfully from base64 string.");
        return;
      } catch (error) {
        logger.error("[Gemini Auth] Failed to parse base64 OAuth credentials:", error);
      }
    }
    const credPath = this.oauthCredsFilePath || path.join(/*turbopackIgnore: true*/ os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
    try {
      const data = await fs.readFile(credPath, "utf8");
      const credentials = JSON.parse(data);
      this.authClient.setCredentials(credentials);
      logger.info("[Gemini Auth] Credentials loaded successfully from file.");
    } catch (error) {
      if (error.code === "ENOENT") {
        logger.debug(`[Gemini Auth] Credentials file not found: ${credPath}`);
      } else {
        logger.warn(`[Gemini Auth] Failed to load credentials from file: ${error.message}`);
      }
    }
  }
  async initializeAuth(forceRefresh = false) {
    await this.loadCredentials();
    const needsRefresh = forceRefresh || this.isTokenExpiringSoon();
    if (this.authClient.credentials.access_token && !needsRefresh) {
      return;
    }
    if (needsRefresh || !this.authClient.credentials.access_token) {
      const credPath = this.oauthCredsFilePath || path.join(/*turbopackIgnore: true*/ os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
      try {
        if (this.authClient.credentials.refresh_token) {
          logger.info("[Gemini Auth] Token expiring soon or force refresh requested. Refreshing token...");
          const {credentials: newCredentials} = await this.authClient.refreshAccessToken();
          this.authClient.setCredentials(newCredentials);
          if (!this.oauthCredsBase64) {
            await this._saveCredentialsToFile(credPath, newCredentials);
            logger.info("[Gemini Auth] Token refreshed and saved successfully.");
          } else {
            logger.info("[Gemini Auth] Token refreshed successfully (Base64 source).");
          }
          const poolManager = getProviderPoolManager();
          if (poolManager && this.uuid) {
            poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.GEMINI_CLI, this.uuid);
          }
        } else {
          logger.info(`[Gemini Auth] No access token or refresh token. Starting new authentication flow...`);
          const newTokens = await this.getNewToken(credPath);
          this.authClient.setCredentials(newTokens);
          logger.info("[Gemini Auth] New token obtained and loaded into memory.");
          const poolManager = getProviderPoolManager();
          if (poolManager && this.uuid) {
            poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.GEMINI_CLI, this.uuid);
          }
        }
      } catch (error) {
        logger.error("[Gemini Auth] Failed to initialize authentication:", error);
        throw new Error(`Failed to load OAuth credentials.`);
      }
    }
  }
  async getNewToken(credPath) {
    const {authUrl: authUrl, authInfo: authInfo} = await handleGeminiCliOAuth(this.config);
    logger.info("\n[Gemini Auth] 正在自动打开浏览器进行授权...");
    logger.info("[Gemini Auth] 授权链接:", authUrl, "\n");
    const showFallbackMessage = () => {
      logger.info("[Gemini Auth] 无法自动打开浏览器，请手动复制上面的链接到浏览器中打开");
    };
    if (this.config) {
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
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        try {
          const data = await fs.readFile(credPath, "utf8");
          const credentials = JSON.parse(data);
          if (credentials.access_token) {
            clearInterval(checkInterval);
            logger.info("[Gemini Auth] New token obtained successfully.");
            resolve(credentials);
          }
        } catch (error) {}
      }, 1e3);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("[Gemini Auth] OAuth 授权超时"));
      }, 5 * 60 * 1e3);
    });
  }
  async discoverProjectAndModels() {
    if (this.projectId) {
      logger.info(`[Gemini] Using pre-configured Project ID: ${this.projectId}`);
      return this.projectId;
    }
    logger.info("[Gemini] Discovering Project ID...");
    this.availableModels = GEMINI_MODELS;
    logger.info(`[Gemini] Using fixed models: [${this.availableModels.join(", ")}]`);
    try {
      const initialProjectId = "";
      const clientMetadata = {
        ideType: "IDE_UNSPECIFIED",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
        duetProject: initialProjectId
      };
      const loadRequest = {
        cloudaicompanionProject: initialProjectId,
        metadata: clientMetadata
      };
      const loadResponse = await this.callApi("loadCodeAssist", loadRequest, false, 0, "load-code-assist");
      if (loadResponse.cloudaicompanionProject) {
        return loadResponse.cloudaicompanionProject;
      }
      const defaultTier = loadResponse.allowedTiers?.find(tier => tier.isDefault);
      const tierId = defaultTier?.id || "free-tier";
      const onboardRequest = {
        tierId: tierId,
        cloudaicompanionProject: initialProjectId,
        metadata: clientMetadata
      };
      let lroResponse = await this.callApi("onboardUser", onboardRequest, false, 0, "onboard-user");
      const MAX_RETRIES = 30;
      let retryCount = 0;
      while (!lroResponse.done && retryCount < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 2e3));
        lroResponse = await this.callApi("onboardUser", onboardRequest, false, 0, "onboard-user");
        retryCount++;
      }
      if (!lroResponse.done) {
        throw new Error("Onboarding timeout: Operation did not complete within expected time.");
      }
      const discoveredProjectId = lroResponse.response?.cloudaicompanionProject?.id || initialProjectId;
      return discoveredProjectId;
    } catch (error) {
      logger.error("[Gemini] Failed to discover Project ID:", error.response?.data || error.message);
      throw new Error("Could not discover a valid Google Cloud Project ID.");
    }
  }
  async listModels() {
    if (!this.isInitialized) await this.initialize();
    const formattedModels = this.availableModels.map(modelId => {
      const displayName = modelId.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
      return {
        name: `models/${modelId}`,
        version: "1.0.0",
        displayName: displayName,
        description: `A generative model for text and chat generation. ID: ${modelId}`,
        inputTokenLimit: 1024e3,
        outputTokenLimit: 65535,
        supportedGenerationMethods: [ "generateContent", "streamGenerateContent" ]
      };
    });
    return {
      models: formattedModels
    };
  }
  async callApi(method, body, isRetry = false, retryCount = 0, model = "unknown") {
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    try {
      const headers = {
        "Content-Type": "application/json"
      };
      applyGeminiCLIHeaders(headers, model);
      const requestOptions = {
        url: `${this.codeAssistEndpoint}/${this.apiVersion}:${method}`,
        method: "POST",
        headers: headers,
        responseType: "json",
        body: JSON.stringify(body)
      };
      this._applySidecar(requestOptions);
      const res = await this.authClient.request(requestOptions);
      return res.data;
    } catch (error) {
      const status = error.response?.status;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      logger.error(`[Gemini API] Error calling (Status: ${status}, Code: ${errorCode}):`, errorMessage);
      if ((status === 400 || status === 401) && !isRetry) {
        logger.info("[Gemini API] Received 401/400. Triggering background refresh via PoolManager...");
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          logger.info(`[Gemini] Marking credential ${this.uuid} as needs refresh. Reason: 401/400 Unauthorized`);
          poolManager.markProviderNeedRefresh(MODEL_PROVIDER.GEMINI_CLI, {
            uuid: this.uuid
          });
          error.credentialMarkedUnhealthy = true;
        }
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 429 && retryCount < maxRetries) {
        const delay = parseRetryDelay(error.response?.data) || baseDelay * Math.pow(2, retryCount);
        logger.info(`[Gemini API] Received 429 (Too Many Requests). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(method, body, isRetry, retryCount + 1, model);
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Gemini API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(method, body, isRetry, retryCount + 1, model);
      }
      if (isNetworkError && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        const errorIdentifier = errorCode || errorMessage.substring(0, 50);
        logger.info(`[Gemini API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(method, body, isRetry, retryCount + 1, model);
      }
      throw error;
    }
  }
  async* streamApi(method, body, isRetry = false, retryCount = 0, model = "unknown") {
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    try {
      const headers = {
        "Content-Type": "application/json"
      };
      applyGeminiCLIHeaders(headers, model);
      const requestOptions = {
        url: `${this.codeAssistEndpoint}/${this.apiVersion}:${method}`,
        method: "POST",
        params: {
          alt: "sse"
        },
        headers: headers,
        responseType: "stream",
        body: JSON.stringify(body)
      };
      this._applySidecar(requestOptions);
      const res = await this.authClient.request(requestOptions);
      if (res.status !== 200) {
        let errorBody = "";
        for await (const chunk of res.data) errorBody += chunk.toString();
        throw new Error(`Upstream API Error (Status ${res.status}): ${errorBody}`);
      }
      yield* this.parseSSEStream(res.data);
    } catch (error) {
      const status = error.response?.status;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      logger.error(`[Gemini API] Error during stream (Status: ${status}, Code: ${errorCode}):`, errorMessage);
      if ((status === 400 || status === 401) && !isRetry) {
        logger.info("[Gemini API] Received 401/400 during stream. Triggering background refresh via PoolManager...");
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          logger.info(`[Gemini] Marking credential ${this.uuid} as needs refresh. Reason: 401/400 Unauthorized in stream`);
          poolManager.markProviderNeedRefresh(MODEL_PROVIDER.GEMINI_CLI, {
            uuid: this.uuid
          });
          error.credentialMarkedUnhealthy = true;
        }
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 429 && retryCount < maxRetries) {
        const delay = parseRetryDelay(error.response?.data) || baseDelay * Math.pow(2, retryCount);
        logger.info(`[Gemini API] Received 429 (Too Many Requests) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(method, body, isRetry, retryCount + 1, model);
        return;
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Gemini API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(method, body, isRetry, retryCount + 1, model);
        return;
      }
      if (isNetworkError && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        const errorIdentifier = errorCode || errorMessage.substring(0, 50);
        logger.info(`[Gemini API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(method, body, isRetry, retryCount + 1, model);
        return;
      }
      throw error;
    }
  }
  async* parseSSEStream(stream) {
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    let buffer = [];
    for await (const line of rl) {
      if (line.startsWith("data: ")) buffer.push(line.slice(6)); else if (line === "" && buffer.length > 0) {
        try {
          yield JSON.parse(buffer.join("\n"));
        } catch (e) {
          logger.error("[Stream] Failed to parse JSON chunk:", buffer.join("\n"));
        }
        buffer = [];
      }
    }
    if (buffer.length > 0) {
      try {
        yield JSON.parse(buffer.join("\n"));
      } catch (e) {
        logger.error("[Stream] Failed to parse final JSON chunk:", buffer.join("\n"));
      }
    }
  }
  async generateContent(model, requestBody) {
    logger.info(`[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);
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
        logger.info(`[Gemini] Token is near expiry, marking credential ${this.uuid} for refresh`);
        poolManager.markProviderNeedRefresh(MODEL_PROVIDER.GEMINI_CLI, {
          uuid: this.uuid
        });
      }
    }
    let baseModel = model;
    if (!GEMINI_MODELS.includes(model)) {
      logger.warn(`[Gemini] Model '${model}' not found. Using default model: '${GEMINI_MODELS[0]}'`);
      baseModel = GEMINI_MODELS[0];
    }
    const processedRequestBody = normalizeGeminiThinkingRequest(baseModel, ensureRolesInContents({
      ...requestBody
    }));
    const apiRequest = {
      model: baseModel,
      project: this.projectId,
      request: processedRequestBody
    };
    const response = await this.callApi(API_ACTIONS.GENERATE_CONTENT, apiRequest, false, 0, baseModel);
    return toGeminiApiResponse(response.response);
  }
  async* generateContentStream(model, requestBody) {
    logger.info(`[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);
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
        logger.info(`[Gemini] Token is near expiry, marking credential ${this.uuid} for refresh`);
        poolManager.markProviderNeedRefresh(MODEL_PROVIDER.GEMINI_CLI, {
          uuid: this.uuid
        });
      }
    }
    if (is_anti_truncation_model(model)) {
      const actualModel = extract_model_from_anti_model(model);
      const processedRequestBody = normalizeGeminiThinkingRequest(actualModel, ensureRolesInContents({
        ...requestBody
      }));
      yield* apply_anti_truncation_to_stream(this, actualModel, processedRequestBody);
      return;
    }
    let baseModel = model;
    if (!GEMINI_MODELS.includes(model)) {
      logger.warn(`[Gemini] Model '${model}' not found. Using default model: '${GEMINI_MODELS[0]}'`);
      baseModel = GEMINI_MODELS[0];
    }
    const processedRequestBody = normalizeGeminiThinkingRequest(baseModel, ensureRolesInContents({
      ...requestBody
    }));
    const apiRequest = {
      model: baseModel,
      project: this.projectId,
      request: processedRequestBody
    };
    const stream = this.streamApi(API_ACTIONS.STREAM_GENERATE_CONTENT, apiRequest, false, 0, baseModel);
    for await (const chunk of stream) {
      yield toGeminiApiResponse(chunk.response);
    }
  }
  isExpiryDateNear() {
    try {
      const nearMinutes = 20;
      const {message: message, isNearExpiry: isNearExpiry} = formatExpiryLog("Gemini", this.authClient.credentials.expiry_date, nearMinutes);
      logger.info(message);
      return isNearExpiry;
    } catch (error) {
      logger.error(`[Gemini] Error checking expiry date: ${error.message}`);
      return false;
    }
  }
  isTokenExpiringSoon() {
    if (!this.authClient.credentials.expiry_date) {
      return false;
    }
    const currentTime = Date.now();
    const expiryTime = this.authClient.credentials.expiry_date;
    const REFRESH_SKEW = 3e3;
    const refreshSkewMs = REFRESH_SKEW * 1e3;
    return expiryTime <= currentTime + refreshSkewMs;
  }
  async _saveCredentialsToFile(filePath, credentials) {
    try {
      await fs.writeFile(filePath, JSON.stringify(credentials, null, 2));
      logger.info(`[Gemini Auth] Credentials saved to ${filePath}`);
    } catch (error) {
      logger.error(`[Gemini Auth] Failed to save credentials to ${filePath}: ${error.message}`);
      throw error;
    }
  }
  async getUsageLimits() {
    if (!this.isInitialized) await this.initialize();
    try {
      const modelsWithQuotas = await this.getModelsWithQuotas();
      return modelsWithQuotas;
    } catch (error) {
      logger.error("[Gemini] Failed to get usage limits:", error.message);
      throw error;
    }
  }
  async getModelsWithQuotas() {
    try {
      const result = {
        lastUpdated: Date.now(),
        models: {}
      };
      try {
        const quotaURL = `${this.codeAssistEndpoint}/${this.apiVersion}:retrieveUserQuota`;
        const requestBody = {
          project: `${this.projectId}`
        };
        const requestOptions = {
          url: quotaURL,
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          responseType: "json",
          body: JSON.stringify(requestBody)
        };
        this._applySidecar(requestOptions);
        const res = await this.authClient.request(requestOptions);
        if (res.data && res.data.buckets) {
          const buckets = res.data.buckets;
          for (const bucket of buckets) {
            const modelId = bucket.modelId;
            if (!GEMINI_MODELS.includes(modelId)) continue;
            const modelInfo = {
              remaining: bucket.remainingFraction || 0,
              resetTime: bucket.resetTime || null,
              resetTimeRaw: bucket.resetTime
            };
            result.models[modelId] = modelInfo;
          }
          const sortedModels = {};
          Object.keys(result.models).sort().forEach(key => {
            sortedModels[key] = result.models[key];
          });
          result.models = sortedModels;
          logger.info(`[Gemini] Successfully fetched quotas for ${Object.keys(result.models).length} models`);
        }
      } catch (fetchError) {
        logger.error(`[Gemini] Failed to fetch user quota:`, fetchError.message);
        for (const modelId of GEMINI_MODELS) {
          result.models[modelId] = {
            remaining: 0,
            resetTime: null,
            resetTimeRaw: null
          };
        }
      }
      return result;
    } catch (error) {
      logger.error("[Gemini] Failed to get models with quotas:", error.message);
      throw error;
    }
  }
}