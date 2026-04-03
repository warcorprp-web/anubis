import { OAuth2Client } from "google-auth-library";

import logger from "../../utils/logger.js";

import * as http from "http";

import * as https from "https";

import * as crypto from "crypto";

import { promises as fs } from "fs";

import * as path from "path";

import * as os from "os";

import * as readline from "readline";

import { v4 as uuidv4 } from "uuid";

import open from "open";

import { configureTLSSidecar } from "../../utils/proxy-utils.js";

import { formatExpiryTime, isRetryableNetworkError, formatExpiryLog } from "../../utils/common.js";

import { getProviderModels } from "../provider-models.js";

import { handleGeminiAntigravityOAuth } from "../../auth/oauth-handlers.js";

import { getProxyConfigForProvider, getGoogleAuthProxyConfig } from "../../utils/proxy-utils.js";

import { cleanJsonSchemaProperties } from "../../converters/utils.js";

import { getProviderPoolManager } from "../../services/service-manager.js";

import { MODEL_PROVIDER } from "../../utils/common.js";

const CREDENTIALS_DIR = ".antigravity";

const CREDENTIALS_FILE = "oauth_creds.json";

const ANTIGRAVITY_BASE_URL_DAILY = "https://daily-cloudcode-pa.googleapis.com";

const ANTIGRAVITY_SANDBOX_BASE_URL_DAILY = "https://daily-cloudcode-pa.sandbox.googleapis.com";

const ANTIGRAVITY_BASE_URL_PROD = "https://autopush-cloudcode-pa.sandbox.googleapis.com";

const ANTIGRAVITY_API_VERSION = "v1internal";

const OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

const OAUTH_CLIENT_SECRET = "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";

const DEFAULT_USER_AGENT = "antigravity/1.104.0 darwin/arm64";

const REFRESH_SKEW = 3e3;

const ANTIGRAVITY_SYSTEM_PROMPT = `You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**`;

const DEFAULT_THINKING_MIN = 1024;

const DEFAULT_THINKING_MAX = 1e5;

const ANTIGRAVITY_MODELS = getProviderModels(MODEL_PROVIDER.ANTIGRAVITY);

function isClaude(modelName) {
  return modelName && modelName.toLowerCase().includes("claude");
}

function isImageModel(modelName) {
  return modelName && modelName.toLowerCase().includes("image");
}

function modelSupportsThinking(modelName) {
  if (!modelName) return false;
  const name = modelName.toLowerCase();
  return name.startsWith("gemini-3") || name.startsWith("gemini-2.5-") || name.includes("-thinking");
}

function generateRequestID() {
  return "agent-" + uuidv4();
}

function generateImageGenRequestID() {
  return `image_gen/${Date.now()}/${uuidv4()}/12`;
}

function generateSessionID() {
  const n = Math.floor(Math.random() * 9e3);
  return "-" + n.toString();
}

function generateStableSessionID(payload) {
  try {
    const contents = payload?.request?.contents;
    if (Array.isArray(contents)) {
      for (const content of contents) {
        if (content && content.role === "user" && Array.isArray(content.parts)) {
          const text = content.parts?.[0]?.text;
          if (text) {
            const hash = crypto.createHash("sha256").update(text).digest();
            const n = hash.readBigUInt64BE(0) & BigInt("0x7FFFFFFFFFFFFFFF");
            return "-" + n.toString();
          }
        }
      }
    }
  } catch (e) {}
  return generateSessionID();
}

function generateProjectID() {
  const adjectives = [ "useful", "bright", "swift", "calm", "bold" ];
  const nouns = [ "fuze", "wave", "spark", "flow", "core" ];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomPart = uuidv4().toLowerCase().substring(0, 5);
  return `${adj}-${noun}-${randomPart}`;
}

function normalizeThinkingBudget(modelName, budget) {
  if (budget === -1) return -1;
  const min = DEFAULT_THINKING_MIN;
  const max = DEFAULT_THINKING_MAX;
  if (budget < min) return min;
  if (budget > max) return max;
  return budget;
}

function normalizeAntigravityThinking(modelName, payload, isClaudeModel) {
  if (!modelSupportsThinking(modelName)) {
    if (payload?.request?.generationConfig?.thinkingConfig) {
      delete payload.request.generationConfig.thinkingConfig;
    }
    return payload;
  }
  const thinkingConfig = payload?.request?.generationConfig?.thinkingConfig;
  if (!thinkingConfig) return payload;
  const thinkingLevel = thinkingConfig.thinkingLevel;
  const budget = thinkingConfig.thinkingBudget;
  const thinkingRequested = thinkingLevel !== undefined || budget !== undefined && budget !== 0;
  if (thinkingRequested && thinkingConfig.includeThoughts === undefined) {
    thinkingConfig.includeThoughts = true;
  }
  if (budget === undefined) return payload;
  let normalizedBudget = normalizeThinkingBudget(modelName, budget);
  if (isClaudeModel) {
    const maxTokens = payload?.request?.generationConfig?.maxOutputTokens;
    if (maxTokens && maxTokens > 0 && normalizedBudget >= maxTokens) {
      normalizedBudget = maxTokens - 1;
    }
    const minBudget = DEFAULT_THINKING_MIN;
    if (normalizedBudget >= 0 && normalizedBudget < minBudget) {
      delete payload.request.generationConfig.thinkingConfig;
      return payload;
    }
  }
  payload.request.generationConfig.thinkingConfig.thinkingBudget = normalizedBudget;
  return payload;
}

function geminiToAntigravity(modelName, payload, projectId) {
  let template = JSON.parse(JSON.stringify(payload));
  const isClaudeModel = isClaude(modelName);
  const isImgModel = isImageModel(modelName);
  template.model = modelName;
  template.userAgent = "antigravity";
  template.requestType = isImgModel ? "image_gen" : "agent";
  template.project = projectId || generateProjectID();
  if (isImgModel) {
    template.requestId = generateImageGenRequestID();
  } else {
    template.requestId = generateRequestID();
    if (!template.request) {
      template.request = {};
    }
    template.request.sessionId = generateStableSessionID(template);
  }
  if (template.request.safetySettings) {
    delete template.request.safetySettings;
  }
  if (template.request.toolConfig) {
    if (!template.request.toolConfig.functionCallingConfig) {
      template.request.toolConfig.functionCallingConfig = {};
    }
    if (isClaudeModel) {
      template.request.toolConfig.functionCallingConfig.mode = "VALIDATED";
    }
  }
  if (isClaudeModel) {
    if (template.request.tools) {
      delete template.request.tools;
    }
    if (template.request.toolConfig) {
      delete template.request.toolConfig;
    }
  }
  if (template.request.generationConfig && template.request.generationConfig.maxOutputTokens) {
    delete template.request.generationConfig.maxOutputTokens;
  }
  if (!modelName.startsWith("gemini-3-")) {
    if (template.request.generationConfig && template.request.generationConfig.thinkingConfig && template.request.generationConfig.thinkingConfig.thinkingLevel) {
      delete template.request.generationConfig.thinkingConfig.thinkingLevel;
      template.request.generationConfig.thinkingConfig.thinkingBudget = -1;
    }
  }
  if (template.request.tools && Array.isArray(template.request.tools)) {
    template.request.tools.forEach(tool => {
      if (tool.functionDeclarations && Array.isArray(tool.functionDeclarations)) {
        tool.functionDeclarations.forEach(funcDecl => {
          if (isClaudeModel && funcDecl.parametersJsonSchema) {
            funcDecl.parameters = cleanJsonSchemaProperties(funcDecl.parametersJsonSchema);
            delete funcDecl.parameters.$schema;
            delete funcDecl.parametersJsonSchema;
          } else if (funcDecl.parameters) {
            funcDecl.parameters = cleanJsonSchemaProperties(funcDecl.parameters);
          }
        });
      }
    });
  }
  if (isImageModel(modelName)) {
    if (!template.request.generationConfig) {
      template.request.generationConfig = {};
    }
    if (!template.request.generationConfig.imageConfig) {
      template.request.generationConfig.imageConfig = {};
    }
    template.request.generationConfig.imageConfig.imageSize = "4K";
    if (!template.request.generationConfig.thinkingConfig) {
      template.request.generationConfig.thinkingConfig = {};
    }
    template.request.generationConfig.thinkingConfig.includeThoughts = false;
  }
  template = normalizeAntigravityThinking(modelName, template, isClaudeModel);
  return template;
}

function filterSSEUsageMetadata(line) {
  if (!line || typeof line !== "string") return line;
  if (!line.startsWith("data: ")) return line;
  try {
    const jsonStr = line.slice(6);
    const data = JSON.parse(jsonStr);
    const hasFinishReason = data?.response?.candidates?.[0]?.finishReason || data?.candidates?.[0]?.finishReason;
    if (!hasFinishReason) {
      if (data.response) {
        delete data.response.usageMetadata;
      }
      if (data.usageMetadata) {
        delete data.usageMetadata;
      }
      return "data: " + JSON.stringify(data);
    }
  } catch (e) {}
  return line;
}

function convertStreamToNonStream(stream) {
  const lines = stream.toString().split("\n");
  let responseTemplate = "";
  let traceId = "";
  let finishReason = "";
  let modelVersion = "";
  let responseId = "";
  let role = "";
  let usageRaw = null;
  const parts = [];
  let pendingKind = "";
  let pendingText = "";
  let pendingThoughtSig = "";
  const flushPending = () => {
    if (!pendingKind) return;
    const text = pendingText;
    if (pendingKind === "text") {
      if (text.trim()) {
        parts.push({
          text: text
        });
      }
    } else if (pendingKind === "thought") {
      if (text.trim() || pendingThoughtSig) {
        const part = {
          thought: true,
          text: text
        };
        if (pendingThoughtSig) {
          part.thoughtSignature = pendingThoughtSig;
        }
        parts.push(part);
      }
    }
    pendingKind = "";
    pendingText = "";
    pendingThoughtSig = "";
  };
  const normalizePart = part => {
    const m = {
      ...part
    };
    const sig = part.thoughtSignature || part.thought_signature;
    if (sig) {
      m.thoughtSignature = sig;
      delete m.thought_signature;
    }
    if (m.inline_data) {
      m.inlineData = m.inline_data;
      delete m.inline_data;
    }
    return m;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      continue;
    }
    let responseNode = data.response;
    if (!responseNode) {
      if (data.candidates) {
        responseNode = data;
      } else {
        continue;
      }
    }
    responseTemplate = JSON.stringify(responseNode);
    if (data.traceId) {
      traceId = data.traceId;
    }
    if (responseNode.candidates?.[0]?.content?.role) {
      role = responseNode.candidates[0].content.role;
    }
    if (responseNode.candidates?.[0]?.finishReason) {
      finishReason = responseNode.candidates[0].finishReason;
    }
    if (responseNode.modelVersion) {
      modelVersion = responseNode.modelVersion;
    }
    if (responseNode.responseId) {
      responseId = responseNode.responseId;
    }
    if (responseNode.usageMetadata) {
      usageRaw = responseNode.usageMetadata;
    } else if (data.usageMetadata) {
      usageRaw = data.usageMetadata;
    }
    const partsArray = responseNode.candidates?.[0]?.content?.parts;
    if (Array.isArray(partsArray)) {
      for (const part of partsArray) {
        const hasFunctionCall = part.functionCall !== undefined;
        const hasInlineData = part.inlineData !== undefined || part.inline_data !== undefined;
        const sig = part.thoughtSignature || part.thought_signature || "";
        const text = part.text || "";
        const thought = part.thought || false;
        if (hasFunctionCall || hasInlineData) {
          flushPending();
          parts.push(normalizePart(part));
          continue;
        }
        if (thought || part.text !== undefined) {
          const kind = thought ? "thought" : "text";
          if (pendingKind && pendingKind !== kind) {
            flushPending();
          }
          pendingKind = kind;
          pendingText += text;
          if (kind === "thought" && sig) {
            pendingThoughtSig = sig;
          }
          continue;
        }
        flushPending();
        parts.push(normalizePart(part));
      }
    }
  }
  flushPending();
  if (!responseTemplate) {
    responseTemplate = '{"candidates":[{"content":{"role":"model","parts":[]}}]}';
  }
  let result = JSON.parse(responseTemplate);
  if (!result.candidates) {
    result.candidates = [ {
      content: {
        role: "model",
        parts: []
      }
    } ];
  }
  if (!result.candidates[0]) {
    result.candidates[0] = {
      content: {
        role: "model",
        parts: []
      }
    };
  }
  if (!result.candidates[0].content) {
    result.candidates[0].content = {
      role: "model",
      parts: []
    };
  }
  result.candidates[0].content.parts = parts;
  if (role) {
    result.candidates[0].content.role = role;
  }
  if (finishReason) {
    result.candidates[0].finishReason = finishReason;
  }
  if (modelVersion) {
    result.modelVersion = modelVersion;
  }
  if (responseId) {
    result.responseId = responseId;
  }
  if (usageRaw) {
    result.usageMetadata = usageRaw;
  } else if (!result.usageMetadata) {
    result.usageMetadata = {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0
    };
  }
  const output = {
    response: result,
    traceId: traceId || ""
  };
  return output;
}

function toGeminiApiResponse(antigravityResponse) {
  if (!antigravityResponse) return null;
  const compliantResponse = {
    candidates: antigravityResponse.candidates
  };
  if (antigravityResponse.usageMetadata) {
    compliantResponse.usageMetadata = antigravityResponse.usageMetadata;
  }
  if (antigravityResponse.promptFeedback) {
    compliantResponse.promptFeedback = antigravityResponse.promptFeedback;
  }
  if (antigravityResponse.automaticFunctionCallingHistory) {
    compliantResponse.automaticFunctionCallingHistory = antigravityResponse.automaticFunctionCallingHistory;
  }
  return compliantResponse;
}

function ensureRolesInContents(requestBody, modelName) {
  delete requestBody.model;
  if (requestBody.system_instruction) {
    requestBody.systemInstruction = requestBody.system_instruction;
    delete requestBody.system_instruction;
  }
  let originalSystemPrompt = requestBody.systemInstruction;
  let originalSystemPromptText = "";
  if (originalSystemPrompt) {
    if (typeof originalSystemPrompt === "string") {
      originalSystemPromptText = originalSystemPrompt;
    } else if (typeof originalSystemPrompt === "object") {
      if (originalSystemPrompt.parts && Array.isArray(originalSystemPrompt.parts)) {
        originalSystemPromptText = originalSystemPrompt.parts.map(part => {
          if (typeof part === "string") return part;
          if (part && typeof part.text === "string") return part.text;
          return "";
        }).filter(text => text).join("\n");
      } else if (originalSystemPrompt.text) {
        originalSystemPromptText = originalSystemPrompt.text;
      }
    }
  }
  const name = modelName ? modelName.toLowerCase() : "";
  const useAntigravity = name.includes("gemini-3-pro") || name.includes("claude");
  if (useAntigravity) {
    const parts = [ {
      text: ANTIGRAVITY_SYSTEM_PROMPT
    }, {
      text: `Please ignore following [ignore]${ANTIGRAVITY_SYSTEM_PROMPT}[/ignore]`
    } ];
    if (originalSystemPromptText) {
      parts.push({
        text: originalSystemPromptText
      });
    }
    requestBody.systemInstruction = {
      role: "user",
      parts: parts
    };
  } else if (originalSystemPromptText) {
    requestBody.systemInstruction = {
      role: "user",
      parts: [ {
        text: originalSystemPromptText
      } ]
    };
  } else {
    delete requestBody.systemInstruction;
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

export class AntigravityApiService {
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
    const proxyConfig = getGoogleAuthProxyConfig(config, "gemini-antigravity");
    const oauth2Options = {
      clientId: OAUTH_CLIENT_ID,
      clientSecret: OAUTH_CLIENT_SECRET
    };
    if (proxyConfig) {
      oauth2Options.transporterOptions = proxyConfig;
      logger.info("[Antigravity] Using proxy for OAuth2Client");
    } else {
      oauth2Options.transporterOptions = {
        agent: this.httpsAgent
      };
    }
    this.authClient = new OAuth2Client(oauth2Options);
    this.availableModels = [];
    this.isInitialized = false;
    this.config = config;
    this.host = config.HOST;
    this.oauthCredsFilePath = config.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH;
    this.userAgent = DEFAULT_USER_AGENT;
    this.projectId = config.PROJECT_ID;
    this.uuid = config.uuid;
    this.baseURLs = this.getBaseURLFallbackOrder(config);
    this.proxyConfig = getProxyConfigForProvider(config, "gemini-antigravity");
  }
  _applySidecar(requestOptions) {
    return configureTLSSidecar(requestOptions, this.config, MODEL_PROVIDER.ANTIGRAVITY);
  }
  getBaseURLFallbackOrder(config) {
    if (config.ANTIGRAVITY_BASE_URL) {
      return [ config.ANTIGRAVITY_BASE_URL.replace(/\/$/, "") ];
    }
    return [ ANTIGRAVITY_SANDBOX_BASE_URL_DAILY, ANTIGRAVITY_BASE_URL_DAILY, ANTIGRAVITY_BASE_URL_PROD ];
  }
  async initialize() {
    if (this.isInitialized) return;
    logger.info("[Antigravity] Initializing Antigravity API Service...");
    await this.loadCredentials();
    if (!this.projectId) {
      this.projectId = await this.discoverProjectAndModels();
    } else {
      logger.info(`[Antigravity] Using provided Project ID: ${this.projectId}`);
      await this.fetchAvailableModels();
    }
    this.isInitialized = true;
    logger.info(`[Antigravity] Initialization complete. Project ID: ${this.projectId}`);
  }
  async loadCredentials() {
    const credPath = this.oauthCredsFilePath || path.join(/*turbopackIgnore: true*/ os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
    try {
      const data = await fs.readFile(credPath, "utf8");
      const credentials = JSON.parse(data);
      this.authClient.setCredentials(credentials);
      logger.info("[Antigravity Auth] Credentials loaded successfully from file.");
    } catch (error) {
      if (error.code === "ENOENT") {
        logger.debug(`[Antigravity Auth] Credentials file not found: ${credPath}`);
      } else {
        logger.warn(`[Antigravity Auth] Failed to load credentials from file: ${error.message}`);
      }
    }
  }
  async initializeAuth(forceRefresh = false) {
    const credPath = this.oauthCredsFilePath || path.join(/*turbopackIgnore: true*/ os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
    await this.loadCredentials();
    const needsRefresh = forceRefresh || this.isTokenExpiringSoon();
    if (this.authClient.credentials.access_token && !needsRefresh) {
      return;
    }
    if (needsRefresh || !this.authClient.credentials.access_token) {
      try {
        if (this.authClient.credentials.refresh_token) {
          logger.info("[Antigravity Auth] Token expiring soon or force refresh requested. Refreshing token...");
          const {credentials: newCredentials} = await this.authClient.refreshAccessToken();
          this.authClient.setCredentials(newCredentials);
          await this._saveCredentialsToFile(credPath, newCredentials);
          logger.info(`[Antigravity Auth] Token refreshed and saved to ${credPath} successfully.`);
          const poolManager = getProviderPoolManager();
          if (poolManager && this.uuid) {
            poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.ANTIGRAVITY, this.uuid);
          }
        } else {
          logger.info(`[Antigravity Auth] No access token or refresh token. Starting new authentication flow...`);
          const newTokens = await this.getNewToken(credPath);
          this.authClient.setCredentials(newTokens);
          logger.info("[Antigravity Auth] New token obtained and loaded into memory.");
          const poolManager = getProviderPoolManager();
          if (poolManager && this.uuid) {
            poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.ANTIGRAVITY, this.uuid);
          }
        }
      } catch (error) {
        logger.error("[Antigravity Auth] Failed to initialize authentication:", error);
        throw new Error(`Failed to load OAuth credentials.`);
      }
    }
  }
  async getNewToken(credPath) {
    const {authUrl: authUrl, authInfo: authInfo} = await handleGeminiAntigravityOAuth(this.config);
    logger.info("\n[Antigravity Auth] 正在自动打开浏览器进行授权...");
    logger.info("[Antigravity Auth] 授权链接:", authUrl, "\n");
    const showFallbackMessage = () => {
      logger.info("[Antigravity Auth] 无法自动打开浏览器，请手动复制上面的链接到浏览器中打开");
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
            logger.info("[Antigravity Auth] New token obtained successfully.");
            resolve(credentials);
          }
        } catch (error) {}
      }, 1e3);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("[Antigravity Auth] OAuth 授权超时"));
      }, 5 * 60 * 1e3);
    });
  }
  isTokenExpiringSoon() {
    if (!this.authClient.credentials.expiry_date) {
      return false;
    }
    const currentTime = Date.now();
    const expiryTime = this.authClient.credentials.expiry_date;
    const refreshSkewMs = REFRESH_SKEW * 1e3;
    return expiryTime <= currentTime + refreshSkewMs;
  }
  async _saveCredentialsToFile(filePath, credentials) {
    try {
      await fs.writeFile(filePath, JSON.stringify(credentials, null, 2));
      logger.info(`[Antigravity Auth] Credentials saved to ${filePath}`);
    } catch (error) {
      logger.error(`[Antigravity Auth] Failed to save credentials to ${filePath}: ${error.message}`);
      throw error;
    }
  }
  async discoverProjectAndModels() {
    if (this.projectId) {
      logger.info(`[Antigravity] Using pre-configured Project ID: ${this.projectId}`);
      return this.projectId;
    }
    logger.info("[Antigravity] Discovering Project ID...");
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
      const loadResponse = await this.callApi("loadCodeAssist", loadRequest);
      if (loadResponse.cloudaicompanionProject) {
        logger.info(`[Antigravity] Discovered existing Project ID: ${loadResponse.cloudaicompanionProject}`);
        await this.fetchAvailableModels();
        return loadResponse.cloudaicompanionProject;
      }
      const defaultTier = loadResponse.allowedTiers?.find(tier => tier.isDefault);
      const tierId = defaultTier?.id || "free-tier";
      const onboardRequest = {
        tierId: tierId,
        cloudaicompanionProject: initialProjectId,
        metadata: clientMetadata
      };
      let lroResponse = await this.callApi("onboardUser", onboardRequest);
      const MAX_RETRIES = 30;
      let retryCount = 0;
      while (!lroResponse.done && retryCount < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, 2e3));
        lroResponse = await this.callApi("onboardUser", onboardRequest);
        retryCount++;
      }
      if (!lroResponse.done) {
        throw new Error("Onboarding timeout: Operation did not complete within expected time.");
      }
      const discoveredProjectId = lroResponse.response?.cloudaicompanionProject?.id || initialProjectId;
      logger.info(`[Antigravity] Onboarded and discovered Project ID: ${discoveredProjectId}`);
      await this.fetchAvailableModels();
      return discoveredProjectId;
    } catch (error) {
      logger.error("[Antigravity] Failed to discover Project ID:", error.response?.data || error.message);
      logger.info("[Antigravity] Falling back to generated Project ID as last resort...");
      const fallbackProjectId = generateProjectID();
      logger.info(`[Antigravity] Generated fallback Project ID: ${fallbackProjectId}`);
      await this.fetchAvailableModels();
      return fallbackProjectId;
    }
  }
  async fetchAvailableModels() {
    logger.info("[Antigravity] Fetching available models...");
    for (const baseURL of this.baseURLs) {
      try {
        const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;
        const requestOptions = {
          url: modelsURL,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": this.userAgent
          },
          responseType: "json",
          body: JSON.stringify({})
        };
        const res = await this.authClient.request(requestOptions);
        if (res.data && res.data.models) {
          const models = Object.keys(res.data.models);
          this.availableModels = models.filter(alias => alias !== undefined && alias !== "" && alias !== null).filter(alias => ANTIGRAVITY_MODELS.includes(alias) || alias.startsWith("claude-")).map(alias => alias.startsWith("claude-") ? `gemini-${alias}` : alias);
          logger.info(`[Antigravity] Available models: [${this.availableModels.join(", ")}]`);
          return;
        }
      } catch (error) {
        logger.error(`[Antigravity] Failed to fetch models from ${baseURL}:`, error.message);
      }
    }
    logger.warn("[Antigravity] Failed to fetch models from all endpoints. Using default models.");
    this.availableModels = ANTIGRAVITY_MODELS;
  }
  async listModels() {
    if (!this.isInitialized) await this.initialize();
    const now = Math.floor(Date.now() / 1e3);
    const formattedModels = this.availableModels.map(modelId => {
      const displayName = modelId.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
      const modelInfo = {
        name: `models/${modelId}`,
        version: "1.0.0",
        displayName: displayName,
        description: `Antigravity model: ${modelId}`,
        inputTokenLimit: 1024e3,
        outputTokenLimit: 65535,
        supportedGenerationMethods: [ "generateContent", "streamGenerateContent" ],
        object: "model",
        created: now,
        ownedBy: "antigravity",
        type: "antigravity"
      };
      if (modelId.endsWith("-thinking") || modelId.includes("-thinking-")) {
        modelInfo.thinking = {
          min: 1024,
          max: 1e5,
          zeroAllowed: false,
          dynamicAllowed: true
        };
      }
      return modelInfo;
    });
    return {
      models: formattedModels
    };
  }
  async callApi(method, body, isRetry = false, retryCount = 0, baseURLIndex = 0) {
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    if (baseURLIndex >= this.baseURLs.length) {
      throw new Error("All Antigravity base URLs failed");
    }
    const baseURL = this.baseURLs[baseURLIndex];
    try {
      const requestOptions = {
        url: `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.userAgent
        },
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
      logger.error(`[Antigravity API] Error calling (Status: ${status}, Code: ${errorCode}):`, error.message);
      if ((status === 400 || status === 401) && !isRetry) {
        logger.info("[Antigravity API] Received 401/400. Triggering background refresh via PoolManager...");
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          logger.info(`[Antigravity] Marking credential ${this.uuid} as needs refresh. Reason: 401/400 Unauthorized`);
          poolManager.markProviderNeedRefresh(MODEL_PROVIDER.ANTIGRAVITY, {
            uuid: this.uuid
          });
          error.credentialMarkedUnhealthy = true;
        }
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 429) {
        if (baseURLIndex + 1 < this.baseURLs.length) {
          logger.info(`[Antigravity API] Rate limited on ${baseURL}. Trying next base URL...`);
          return this.callApi(method, body, isRetry, retryCount, baseURLIndex + 1);
        } else if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          logger.info(`[Antigravity API] Rate limited. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.callApi(method, body, isRetry, retryCount + 1, 0);
        }
      }
      if (isNetworkError) {
        if (baseURLIndex + 1 < this.baseURLs.length) {
          const errorIdentifier = errorCode || errorMessage.substring(0, 50);
          logger.info(`[Antigravity API] Network error (${errorIdentifier}) on ${baseURL}. Trying next base URL...`);
          return this.callApi(method, body, isRetry, retryCount, baseURLIndex + 1);
        } else if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          const errorIdentifier = errorCode || errorMessage.substring(0, 50);
          logger.info(`[Antigravity API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return this.callApi(method, body, isRetry, retryCount + 1, 0);
        }
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Antigravity API] Server error ${status}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(method, body, isRetry, retryCount + 1, baseURLIndex);
      }
      throw error;
    }
  }
  async* streamApi(method, body, isRetry = false, retryCount = 0, baseURLIndex = 0) {
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    if (baseURLIndex >= this.baseURLs.length) {
      throw new Error("All Antigravity base URLs failed");
    }
    const baseURL = this.baseURLs[baseURLIndex];
    try {
      const requestOptions = {
        url: `${baseURL}/${ANTIGRAVITY_API_VERSION}:${method}`,
        method: "POST",
        params: {
          alt: "sse"
        },
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "User-Agent": this.userAgent
        },
        responseType: "stream",
        body: JSON.stringify(body)
      };
      this._applySidecar(requestOptions);
      const res = await this.authClient.request(requestOptions);
      if (res.status !== 200) {
        let errorBody = "";
        for await (const chunk of res.data) {
          errorBody += chunk.toString();
        }
        throw new Error(`Upstream API Error (Status ${res.status}): ${errorBody}`);
      }
      yield* this.parseSSEStream(res.data);
    } catch (error) {
      const status = error.response?.status;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      logger.error(`[Antigravity API] Error during stream (Status: ${status}, Code: ${errorCode}):`, error.message);
      if ((status === 400 || status === 401) && !isRetry) {
        logger.info("[Antigravity API] Received 401/400 during stream. Triggering background refresh via PoolManager...");
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          logger.info(`[Antigravity] Marking credential ${this.uuid} as needs refresh. Reason: 401/400 Unauthorized in stream`);
          poolManager.markProviderNeedRefresh(MODEL_PROVIDER.ANTIGRAVITY, {
            uuid: this.uuid
          });
          error.credentialMarkedUnhealthy = true;
        }
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 429) {
        if (baseURLIndex + 1 < this.baseURLs.length) {
          logger.info(`[Antigravity API] Rate limited on ${baseURL}. Trying next base URL...`);
          yield* this.streamApi(method, body, isRetry, retryCount, baseURLIndex + 1);
          return;
        } else if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          logger.info(`[Antigravity API] Rate limited during stream. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          yield* this.streamApi(method, body, isRetry, retryCount + 1, 0);
          return;
        }
      }
      if (isNetworkError) {
        if (baseURLIndex + 1 < this.baseURLs.length) {
          const errorIdentifier = errorCode || errorMessage.substring(0, 50);
          logger.info(`[Antigravity API] Network error (${errorIdentifier}) on ${baseURL} during stream. Trying next base URL...`);
          yield* this.streamApi(method, body, isRetry, retryCount, baseURLIndex + 1);
          return;
        } else if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          const errorIdentifier = errorCode || errorMessage.substring(0, 50);
          logger.info(`[Antigravity API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          yield* this.streamApi(method, body, isRetry, retryCount + 1, 0);
          return;
        }
      }
      if (status >= 500 && status < 600 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        logger.info(`[Antigravity API] Server error ${status} during stream. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApi(method, body, isRetry, retryCount + 1, baseURLIndex);
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
    for await (let line of rl) {
      if (line.startsWith("data: ")) {
        line = filterSSEUsageMetadata(line);
        buffer.push(line.slice(6));
      } else if (line === "" && buffer.length > 0) {
        try {
          yield JSON.parse(buffer.join("\n"));
        } catch (e) {
          logger.error("[Antigravity Stream] Failed to parse JSON chunk:", buffer.join("\n"));
        }
        buffer = [];
      }
    }
    if (buffer.length > 0) {
      try {
        yield JSON.parse(buffer.join("\n"));
      } catch (e) {
        logger.error("[Antigravity Stream] Failed to parse final JSON chunk:", buffer.join("\n"));
      }
    }
  }
  async generateContent(model, requestBody) {
    logger.info(`[Antigravity Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);
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
        logger.info(`[Antigravity] Token is near expiry, marking credential ${this.uuid} for refresh`);
        poolManager.markProviderNeedRefresh(MODEL_PROVIDER.ANTIGRAVITY, {
          uuid: this.uuid
        });
      }
    }
    let selectedModel = model;
    if (!this.availableModels.includes(model)) {
      logger.warn(`[Antigravity] Model '${model}' not found. Using default model: 'gemini-3-flash'`);
      selectedModel = "gemini-3-flash";
    }
    const actualModelName = selectedModel.startsWith("gemini-claude-") ? selectedModel.replace("gemini-claude-", "claude-") : selectedModel;
    logger.info(`[Antigravity] Selected model: ${actualModelName}`);
    const processedRequestBody = ensureRolesInContents(JSON.parse(JSON.stringify(requestBody)), actualModelName);
    const isClaudeModel = isClaude(actualModelName);
    const payload = geminiToAntigravity(actualModelName, {
      request: processedRequestBody
    }, this.projectId);
    payload.model = actualModelName;
    if (isClaudeModel) {
      return await this.executeClaudeNonStream(payload);
    }
    const response = await this.callApi("generateContent", payload);
    return toGeminiApiResponse(response.response);
  }
  async executeClaudeNonStream(payload) {
    const chunks = [];
    try {
      const stream = this.streamApi("streamGenerateContent", payload);
      for await (const chunk of stream) {
        if (chunk) {
          chunks.push(JSON.stringify(chunk));
        }
      }
      const streamData = chunks.join("\n");
      const nonStreamResponse = convertStreamToNonStream(streamData);
      return toGeminiApiResponse(nonStreamResponse.response);
    } catch (error) {
      logger.error("[Antigravity] Claude non-stream execution error:", error.message);
      throw error;
    }
  }
  async* generateContentStream(model, requestBody) {
    logger.info(`[Antigravity Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`);
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
        logger.info(`[Antigravity] Token is near expiry, marking credential ${this.uuid} for refresh`);
        poolManager.markProviderNeedRefresh(MODEL_PROVIDER.ANTIGRAVITY, {
          uuid: this.uuid
        });
      }
    }
    let selectedModel = model;
    if (!this.availableModels.includes(model)) {
      logger.warn(`[Antigravity] Model '${model}' not found. Using default model: 'gemini-3-flash'`);
      selectedModel = "gemini-3-flash";
    }
    const actualModelName = selectedModel.startsWith("gemini-claude-") ? selectedModel.replace("gemini-claude-", "claude-") : selectedModel;
    logger.info(`[Antigravity] Selected model: ${actualModelName}`);
    const processedRequestBody = ensureRolesInContents(JSON.parse(JSON.stringify(requestBody)), actualModelName);
    const payload = geminiToAntigravity(actualModelName, {
      request: processedRequestBody
    }, this.projectId);
    payload.model = actualModelName;
    const stream = this.streamApi("streamGenerateContent", payload);
    for await (const chunk of stream) {
      yield toGeminiApiResponse(chunk.response);
    }
  }
  isExpiryDateNear() {
    try {
      const nearMinutes = 20;
      const {message: message, isNearExpiry: isNearExpiry} = formatExpiryLog("Antigravity", this.authClient.credentials.expiry_date, nearMinutes);
      logger.info(message);
      return isNearExpiry;
    } catch (error) {
      logger.error(`[Antigravity] Error checking expiry date: ${error.message}`);
      return false;
    }
  }
  async getUsageLimits() {
    if (!this.isInitialized) await this.initialize();
    try {
      const modelsWithQuotas = await this.getModelsWithQuotas();
      return modelsWithQuotas;
    } catch (error) {
      logger.error("[Antigravity] Failed to get usage limits:", error.message);
      throw error;
    }
  }
  async getModelsWithQuotas() {
    try {
      const result = {
        lastUpdated: Date.now(),
        models: {}
      };
      for (const baseURL of this.baseURLs) {
        try {
          const modelsURL = `${baseURL}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`;
          const requestOptions = {
            url: modelsURL,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": this.userAgent
            },
            responseType: "json",
            body: JSON.stringify({
              project: this.projectId
            })
          };
          this._applySidecar(requestOptions);
          const res = await this.authClient.request(requestOptions);
          if (res.data) {
            if (res.data.models) {
              const modelsData = res.data.models;
              for (const [modelId, modelData] of Object.entries(modelsData)) {
                if (!modelId || !ANTIGRAVITY_MODELS.includes(modelId) && !modelId.startsWith("claude-")) {
                  continue;
                }
                const aliasName = modelId.startsWith("claude-") ? `gemini-${modelId}` : modelId;
                const modelInfo = {
                  remaining: 0,
                  resetTime: null,
                  resetTimeRaw: null
                };
                if (modelData.quotaInfo) {
                  modelInfo.remaining = modelData.quotaInfo.remainingFraction !== undefined ? modelData.quotaInfo.remainingFraction : modelData.quotaInfo.remaining || 0;
                  modelInfo.resetTime = modelData.quotaInfo.resetTime || null;
                  modelInfo.resetTimeRaw = modelData.quotaInfo.resetTime;
                }
                result.models[aliasName] = modelInfo;
              }
            }
            const sortedModels = {};
            Object.keys(result.models).sort().forEach(key => {
              sortedModels[key] = result.models[key];
            });
            result.models = sortedModels;
            logger.info(`[Antigravity] Successfully fetched quotas for ${Object.keys(result.models).length} models`);
            break;
          }
        } catch (error) {
          logger.error(`[Antigravity] Failed to fetch models with quotas from ${baseURL}:`, error.message);
        }
      }
      return result;
    } catch (error) {
      logger.error("[Antigravity] Failed to get models with quotas:", error.message);
      throw error;
    }
  }
}