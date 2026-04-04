import axios from "axios";

import logger from "../../utils/logger.js";

import { v4 as uuidv4 } from "uuid";

import { promises as fs } from "fs";

import * as path from "path";

import * as os from "os";

import * as crypto from "crypto";

import * as http from "http";

import * as https from "https";

import { getProviderModels } from "../provider-models.js";

import { countTextTokens as countTextTokensUtil, estimateInputTokens as estimateInputTokensUtil, countTokensAnthropic as countTokensUtil, processContent as processContentUtil, getContentText as getContentTextUtil } from "../../utils/token-utils.js";

import { configureAxiosProxy, configureTLSSidecar } from "../../utils/proxy-utils.js";

import { isRetryableNetworkError, MODEL_PROVIDER, formatExpiryLog } from "../../utils/common.js";

import { getProviderPoolManager } from "../../services/service-manager.js";

const KIRO_THINKING = {
  MIN_BUDGET_TOKENS: 1024,
  MAX_BUDGET_TOKENS: 24576,
  DEFAULT_BUDGET_TOKENS: 2e4,
  START_TAG: "<thinking>",
  END_TAG: "</thinking>",
  MODE_TAG: "<thinking_mode>",
  MAX_LEN_TAG: "<max_thinking_length>",
  EFFORT_TAG: "<thinking_effort>"
};

const KIRO_CONSTANTS = {
  REFRESH_URL: "https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken",
  REFRESH_IDC_URL: "https://oidc.{{region}}.amazonaws.com/token",
  BASE_URL: "https://q.{{region}}.amazonaws.com/generateAssistantResponse",
  DEFAULT_MODEL_NAME: "claude-sonnet-4-5",
  AXIOS_TIMEOUT: 12e4,
  TOKEN_REFRESH_TIMEOUT: 15e3,
  USER_AGENT: "KiroIDE",
  KIRO_VERSION: "0.11.63",
  CONTENT_TYPE_JSON: "application/json",
  ACCEPT_JSON: "application/json",
  AUTH_METHOD_SOCIAL: "social",
  CHAT_TRIGGER_TYPE_MANUAL: "MANUAL",
  ORIGIN_AI_EDITOR: "AI_EDITOR",
  TOTAL_CONTEXT_TOKENS: 2e5
};

const MODEL_CONTEXT_TOKENS = {
  "claude-opus-4-6": 1e6,
  "claude-opus-4-5": 1e6,
  "claude-opus-4-5-20251101": 1e6,
  "claude-sonnet-4-6": 2e5,
  "claude-sonnet-4-5": 2e5,
  "claude-sonnet-4-5-20250929": 2e5,
  "claude-haiku-4-5": 2e5,
  "claude-haiku-4-5-20251001": 2e5
};

function getContextTokensForModel(model) {
  return MODEL_CONTEXT_TOKENS[model] || KIRO_CONSTANTS.TOTAL_CONTEXT_TOKENS;
}

const KIRO_MODELS = getProviderModels(MODEL_PROVIDER.KIRO_API);

const FULL_MODEL_MAPPING = {
  "claude-haiku-4-5": "claude-haiku-4.5",
  "claude-opus-4-6": "claude-opus-4.6",
  "claude-sonnet-4-6": "claude-sonnet-4.6",
  "claude-opus-4-5": "claude-opus-4.5",
  "claude-opus-4-5-20251101": "claude-opus-4.5",
  "claude-sonnet-4-5": "claude-sonnet-4.5",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4.5"
};

const MODEL_MAPPING = Object.fromEntries(Object.entries(FULL_MODEL_MAPPING).filter(([key]) => KIRO_MODELS.includes(key)));

const KIRO_AUTH_TOKEN_FILE = "kiro-auth-token.json";

function generateMachineIdFromConfig(credentials) {
  const uniqueKey = credentials.uuid || credentials.profileArn || credentials.clientId || "KIRO_DEFAULT_MACHINE";
  return crypto.createHash("sha256").update(uniqueKey).digest("hex");
}

function getSystemRuntimeInfo() {
  const osPlatform = os.platform();
  const osRelease = os.release();
  const nodeVersion = process.version.replace("v", "");
  let osName = osPlatform;
  if (osPlatform === "win32") osName = `windows#${osRelease}`; else if (osPlatform === "darwin") osName = `macos#${osRelease}`; else osName = `${osPlatform}#${osRelease}`;
  return {
    osName: osName,
    nodeVersion: nodeVersion
  };
}

function isQuoteCharAt(text, index) {
  if (index < 0 || index >= text.length) return false;
  const ch = text[index];
  return ch === '"' || ch === "'" || ch === "`";
}

function findRealTag(text, tag, startIndex = 0) {
  let searchStart = Math.max(0, startIndex);
  while (true) {
    const pos = text.indexOf(tag, searchStart);
    if (pos === -1) return -1;
    const hasQuoteBefore = isQuoteCharAt(text, pos - 1);
    const hasQuoteAfter = isQuoteCharAt(text, pos + tag.length);
    if (!hasQuoteBefore && !hasQuoteAfter) {
      return pos;
    }
    searchStart = pos + 1;
  }
}

function isWhitespaceOnly(text) {
  if (text === null || text === undefined) return true;
  return String(text).trim().length === 0;
}

function findRealThinkingEndTag(buffer, startIndex = 0) {
  let searchStart = Math.max(0, startIndex);
  while (true) {
    const pos = findRealTag(buffer, KIRO_THINKING.END_TAG, searchStart);
    if (pos === -1) return -1;
    const after = buffer.slice(pos + KIRO_THINKING.END_TAG.length);
    if (after.startsWith("\n\n")) return pos;
    searchStart = pos + 1;
  }
}

function findRealThinkingEndTagAtBufferEnd(buffer, startIndex = 0) {
  let searchStart = Math.max(0, startIndex);
  while (true) {
    const pos = findRealTag(buffer, KIRO_THINKING.END_TAG, searchStart);
    if (pos === -1) return -1;
    const after = buffer.slice(pos + KIRO_THINKING.END_TAG.length);
    if (isWhitespaceOnly(after)) return pos;
    searchStart = pos + 1;
  }
}

function findMatchingBracket(text, startPos, openChar = "[", closeChar = "]") {
  if (!text || startPos >= text.length || text[startPos] !== openChar) {
    return -1;
  }
  let bracketCount = 1;
  let inString = false;
  let escapeNext = false;
  for (let i = startPos + 1; i < text.length; i++) {
    const char = text[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (char === "\\" && inString) {
      escapeNext = true;
      continue;
    }
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === openChar) {
        bracketCount++;
      } else if (char === closeChar) {
        bracketCount--;
        if (bracketCount === 0) {
          return i;
        }
      }
    }
  }
  return -1;
}

function repairJson(jsonStr) {
  let repaired = jsonStr;
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
  repaired = repaired.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"');
  return repaired;
}

function extractCredentialsFromCorruptedJson(content) {
  const extracted = {};
  const fieldPatterns = {
    refreshToken: /"refreshToken"\s*:\s*"([^"]+)"/,
    accessToken: /"accessToken"\s*:\s*"([^"]+)"/,
    clientId: /"clientId"\s*:\s*"([^"]+)"/,
    clientSecret: /"clientSecret"\s*:\s*"([^"]+)"/,
    profileArn: /"profileArn"\s*:\s*"([^"]+)"/,
    region: /"region"\s*:\s*"([^"]+)"/,
    authMethod: /"authMethod"\s*:\s*"([^"]+)"/,
    expiresAt: /"expiresAt"\s*:\s*"([^"]+)"/,
    startUrl: /"startUrl"\s*:\s*"([^"]+)"/
  };
  for (const [field, pattern] of Object.entries(fieldPatterns)) {
    const match = content.match(pattern);
    if (match && match[1]) {
      extracted[field] = match[1];
    }
  }
  if (extracted.refreshToken || extracted.accessToken) {
    logger.info(`[Kiro Auth] Extracted ${Object.keys(extracted).length} fields from corrupted JSON: ${Object.keys(extracted).join(", ")}`);
    return extracted;
  }
  return null;
}

function parseSingleToolCall(toolCallText) {
  const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i;
  const nameMatch = toolCallText.match(namePattern);
  if (!nameMatch) {
    return null;
  }
  const functionName = nameMatch[1].trim();
  const argsStartMarker = "with args:";
  const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase());
  if (argsStartPos === -1) {
    return null;
  }
  const argsStart = argsStartPos + argsStartMarker.length;
  const argsEnd = toolCallText.lastIndexOf("]");
  if (argsEnd <= argsStart) {
    return null;
  }
  const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim();
  try {
    const repairedJson = repairJson(jsonCandidate);
    const argumentsObj = JSON.parse(repairedJson);
    if (typeof argumentsObj !== "object" || argumentsObj === null) {
      return null;
    }
    const toolCallId = `call_${uuidv4().replace(/-/g, "").substring(0, 8)}`;
    return {
      id: toolCallId,
      type: "function",
      function: {
        name: functionName,
        arguments: JSON.stringify(argumentsObj)
      }
    };
  } catch (e) {
    logger.error(`Failed to parse tool call arguments: ${e.message}`, jsonCandidate);
    return null;
  }
}

function parseBracketToolCalls(responseText) {
  if (!responseText || !responseText.includes("[Called")) {
    return null;
  }
  const toolCalls = [];
  const callPositions = [];
  let start = 0;
  while (true) {
    const pos = responseText.indexOf("[Called", start);
    if (pos === -1) {
      break;
    }
    callPositions.push(pos);
    start = pos + 1;
  }
  for (let i = 0; i < callPositions.length; i++) {
    const startPos = callPositions[i];
    let endSearchLimit;
    if (i + 1 < callPositions.length) {
      endSearchLimit = callPositions[i + 1];
    } else {
      endSearchLimit = responseText.length;
    }
    const segment = responseText.substring(startPos, endSearchLimit);
    const bracketEnd = findMatchingBracket(segment, 0);
    let toolCallText;
    if (bracketEnd !== -1) {
      toolCallText = segment.substring(0, bracketEnd + 1);
    } else {
      const lastBracket = segment.lastIndexOf("]");
      if (lastBracket !== -1) {
        toolCallText = segment.substring(0, lastBracket + 1);
      } else {
        continue;
      }
    }
    const parsedCall = parseSingleToolCall(toolCallText);
    if (parsedCall) {
      toolCalls.push(parsedCall);
    }
  }
  return toolCalls.length > 0 ? toolCalls : null;
}

function deduplicateToolCalls(toolCalls) {
  const seen = new Set;
  const uniqueToolCalls = [];
  for (const tc of toolCalls) {
    const key = `${tc.function.name}-${tc.function.arguments}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueToolCalls.push(tc);
    } else {
      logger.info(`Skipping duplicate tool call: ${tc.function.name}`);
    }
  }
  return uniqueToolCalls;
}

export class KiroApiService {
  constructor(config = {}) {
    this.isInitialized = false;
    this.config = config;
    this.credPath = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), ".aws", "sso", "cache");
    this.credsBase64 = config.KIRO_OAUTH_CREDS_BASE64;
    this.useSystemProxy = config?.USE_SYSTEM_PROXY_KIRO ?? false;
    this.uuid = config?.uuid;
    logger.info(`[Kiro] System proxy ${this.useSystemProxy ? "enabled" : "disabled"}`);
    if (config.KIRO_OAUTH_CREDS_BASE64) {
      try {
        const decodedCreds = Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, "base64").toString("utf8");
        const parsedCreds = JSON.parse(decodedCreds);
        this.base64Creds = parsedCreds;
        logger.info("[Kiro] Successfully decoded Base64 credentials in constructor.");
      } catch (error) {
        logger.error(`[Kiro] Failed to parse Base64 credentials in constructor: ${error.message}`);
      }
    } else if (config.KIRO_OAUTH_CREDS_FILE_PATH) {
      this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH;
    }
    this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
    this.axiosInstance = null;
    this.axiosSocialRefreshInstance = null;
  }
  async initialize() {
    if (this.isInitialized) return;
    await this._doInitialize();
  }
  async _doInitialize() {
    logger.info("[Kiro] Initializing Kiro API Service...");
    await this.loadCredentials();
    this.isInitialized = true;
  }
  _createAxiosInstance() {
    const machineId = generateMachineIdFromConfig({
      uuid: this.uuid,
      profileArn: this.profileArn,
      clientId: this.clientId
    });
    const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;
    const {osName: osName, nodeVersion: nodeVersion} = getSystemRuntimeInfo();
    const httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT
    });
    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 100,
      maxFreeSockets: 5,
      timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT
    });
    const axiosConfig = {
      timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
      httpAgent: httpAgent,
      httpsAgent: httpsAgent,
      headers: {
        "Content-Type": KIRO_CONSTANTS.CONTENT_TYPE_JSON,
        Accept: KIRO_CONSTANTS.ACCEPT_JSON,
        "amz-sdk-invocation-id": uuidv4(),
        "amz-sdk-request": "attempt=1; max=3",
        "x-amzn-codewhisperer-optout": true,
        "x-amzn-kiro-agent-mode": "vibe",
        "x-amz-user-agent": `aws-sdk-js/1.0.34 KiroIDE-${kiroVersion}-${machineId}`,
        "user-agent": `aws-sdk-js/1.0.34 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${kiroVersion}-${machineId}`,
        Connection: "close"
      }
    };
    if (!this.useSystemProxy) {
      axiosConfig.proxy = false;
    }
    configureAxiosProxy(axiosConfig, this.config, "claude-kiro-oauth");
    return axios.create(axiosConfig);
  }
  async reinitialize() {
    logger.info("[Kiro] Reinitializing for config update...");
    this.isInitialized = false;
    await this._doInitialize();
  }
  _applySidecar(axiosConfig) {
    return configureTLSSidecar(axiosConfig, this.config, MODEL_PROVIDER.KIRO_API);
  }
  async loadCredentials() {
    const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
    const loadCredentialsFromFile = async filePath => {
      try {
        const fileContent = await fs.readFile(filePath, "utf8");
        try {
          return JSON.parse(fileContent);
        } catch (parseError) {
          logger.warn("[Kiro Auth] JSON parse failed, attempting repair...");
          try {
            const repaired = repairJson(fileContent);
            const result = JSON.parse(repaired);
            logger.info("[Kiro Auth] JSON repair successful");
            return result;
          } catch (repairError) {
            logger.warn("[Kiro Auth] JSON repair failed, attempting field extraction...");
            const extracted = extractCredentialsFromCorruptedJson(fileContent);
            if (extracted) {
              logger.info("[Kiro Auth] Field extraction successful, credentials recovered");
              return extracted;
            }
            logger.error("[Kiro Auth] All recovery methods failed:", repairError.message);
            return null;
          }
        }
      } catch (error) {
        if (error.code === "ENOENT") {
          logger.debug(`[Kiro Auth] Credential file not found: ${filePath}`);
        } else {
          logger.warn(`[Kiro Auth] Failed to read credential file ${filePath}: ${error.message}`);
        }
        return null;
      }
    };
    try {
      let mergedCredentials = {};
      if (this.base64Creds) {
        Object.assign(mergedCredentials, this.base64Creds);
        logger.info("[Kiro Auth] Successfully loaded credentials from Base64 (constructor).");
        this.base64Creds = null;
      }
      const targetFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
      const dirPath = path.dirname(targetFilePath);
      const targetFileName = path.basename(targetFilePath);
      logger.debug(`[Kiro Auth] Loading credentials from directory: ${dirPath}`);
      try {
        const targetCredentials = await loadCredentialsFromFile(targetFilePath);
        if (targetCredentials) {
          Object.assign(mergedCredentials, targetCredentials);
          logger.info(`[Kiro Auth] Successfully loaded OAuth credentials from ${targetFilePath}`);
        }
        const files = await fs.readdir(dirPath);
        for (const file of files) {
          if (file.endsWith(".json") && file !== targetFileName) {
            const filePath = path.join(dirPath, file);
            const credentials = await loadCredentialsFromFile(filePath);
            if (credentials) {
              credentials.expiresAt = mergedCredentials.expiresAt;
              Object.assign(mergedCredentials, credentials);
              logger.debug(`[Kiro Auth] Loaded Client credentials from ${file}`);
            }
          }
        }
      } catch (error) {
        logger.warn(`[Kiro Auth] Error loading credentials from directory ${dirPath}: ${error.message}`);
      }
      this.accessToken = this.accessToken || mergedCredentials.accessToken;
      this.refreshToken = this.refreshToken || mergedCredentials.refreshToken;
      this.clientId = this.clientId || mergedCredentials.clientId;
      this.clientSecret = this.clientSecret || mergedCredentials.clientSecret;
      this.authMethod = this.authMethod || mergedCredentials.authMethod;
      this.expiresAt = this.expiresAt || mergedCredentials.expiresAt;
      this.profileArn = this.profileArn || mergedCredentials.profileArn;
      this.region = this.region || mergedCredentials.region;
      this.idcRegion = this.idcRegion || mergedCredentials.idcRegion;
      if (!this.region) {
        logger.warn("[Kiro Auth] Region not found in credentials. Using default region us-east-1 for URLs.");
        this.region = "us-east-1";
      }
      if (!this.idcRegion) {
        this.idcRegion = this.region;
      }
      this.refreshUrl = (this.config.KIRO_REFRESH_URL || KIRO_CONSTANTS.REFRESH_URL).replace("{{region}}", this.region);
      this.refreshIDCUrl = (this.config.KIRO_REFRESH_IDC_URL || KIRO_CONSTANTS.REFRESH_IDC_URL).replace("{{region}}", this.idcRegion);
      this.baseUrl = (this.config.KIRO_BASE_URL || KIRO_CONSTANTS.BASE_URL).replace("{{region}}", this.region);
    } catch (error) {
      logger.warn(`[Kiro Auth] Error during credential loading: ${error.message}`);
    }
  }
  async initializeAuth(forceRefresh = false) {
    if (this.accessToken && !forceRefresh) {
      logger.debug("[Kiro Auth] Access token already available and not forced refresh.");
      return;
    }
    await this.loadCredentials();
    if (forceRefresh || !this.accessToken && this.refreshToken) {
      if (!this.refreshToken) {
        throw new Error("No refresh token available to refresh access token.");
      }
      const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
      await this._doTokenRefresh(this.saveCredentialsToFile.bind(this), tokenFilePath);
    }
    if (!this.accessToken) {
      throw new Error("No access token available after initialization and refresh attempts.");
    }
  }
  async saveCredentialsToFile(filePath, newData) {
    let existingData = {};
    try {
      const fileContent = await fs.readFile(filePath, "utf8");
      try {
        existingData = JSON.parse(fileContent);
      } catch (parseError) {
        logger.warn("[Kiro Auth] JSON parse failed, attempting repair...");
        try {
          const repaired = repairJson(fileContent);
          existingData = JSON.parse(repaired);
          logger.info("[Kiro Auth] JSON repair successful");
        } catch (repairError) {
          logger.warn("[Kiro Auth] JSON repair failed, attempting field extraction...");
          const extracted = extractCredentialsFromCorruptedJson(fileContent);
          if (extracted) {
            existingData = extracted;
            logger.info("[Kiro Auth] Field extraction successful");
          } else {
            logger.error("[Kiro Auth] All recovery methods failed:", repairError.message);
            existingData = {};
          }
        }
      }
    } catch (readError) {
      if (readError.code === "ENOENT") {
        logger.debug(`[Kiro Auth] Token file not found, creating new one: ${filePath}`);
      } else {
        logger.warn(`[Kiro Auth] Could not read existing token file ${filePath}: ${readError.message}`);
      }
    }
    const mergedData = {
      ...existingData,
      ...newData
    };
    await fs.writeFile(filePath, JSON.stringify(mergedData, null, 2), "utf8");
    logger.info(`[Kiro Auth] Updated token file: ${filePath}`);
  }
  async _doTokenRefresh(saveCredentialsToFile, tokenFilePath) {
    try {
      const requestBody = {
        refreshToken: this.refreshToken
      };
      let refreshUrl = this.refreshUrl;
      if (this.authMethod !== KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
        refreshUrl = this.refreshIDCUrl;
        requestBody.clientId = this.clientId;
        requestBody.clientSecret = this.clientSecret;
        requestBody.grantType = "refresh_token";
      }
      let response = null;
      const refreshConfig = {
        timeout: KIRO_CONSTANTS.TOKEN_REFRESH_TIMEOUT
      };
      const axiosConfig = {
        method: "post",
        url: refreshUrl,
        data: requestBody,
        ...refreshConfig
      };
      this._applySidecar(axiosConfig);
      const axiosInstance = this._createAxiosInstance();
      if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
        response = await axiosInstance.request(axiosConfig);
        logger.info("[Kiro Auth] Token refresh social response: ok");
      } else {
        response = await axiosInstance.request(axiosConfig);
        logger.info("[Kiro Auth] Token refresh idc response: ok");
      }
      if (response.data && response.data.accessToken) {
        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken;
        this.profileArn = response.data.profileArn;
        const expiresIn = response.data.expiresIn;
        const expiresAt = new Date(Date.now() + expiresIn * 1e3).toISOString();
        this.expiresAt = expiresAt;
        logger.info("[Kiro Auth] Access token refreshed successfully");
        const updatedTokenData = {
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: expiresAt
        };
        if (this.profileArn) {
          updatedTokenData.profileArn = this.profileArn;
        }
        await saveCredentialsToFile(tokenFilePath, updatedTokenData);
        const poolManager = getProviderPoolManager();
        if (poolManager && this.uuid) {
          poolManager.resetProviderRefreshStatus(MODEL_PROVIDER.KIRO_API, this.uuid);
        }
      } else {
        throw new Error("Invalid refresh response: Missing accessToken");
      }
    } catch (error) {
      logger.error("[Kiro Auth] Token refresh failed:", error.message);
      throw new Error(`Token refresh failed: ${error.message}`);
    }
  }
  static countTextTokens(text) {
    return countTextTokensUtil(text);
  }
  static countTokens(requestBody) {
    return countTokensUtil(requestBody);
  }
  static estimateInputTokens(requestBody) {
    return estimateInputTokensUtil(requestBody);
  }
  getContentText(message) {
    return getContentTextUtil(message);
  }
  processContent(content) {
    return processContentUtil(content);
  }
  _normalizeThinkingBudgetTokens(budgetTokens) {
    let value = Number(budgetTokens);
    if (!Number.isFinite(value) || value <= 0) {
      value = KIRO_THINKING.DEFAULT_BUDGET_TOKENS;
    }
    value = Math.floor(value);
    if (value < KIRO_THINKING.MIN_BUDGET_TOKENS) value = KIRO_THINKING.MIN_BUDGET_TOKENS;
    return Math.min(value, KIRO_THINKING.MAX_BUDGET_TOKENS);
  }
  _generateThinkingPrefix(thinking) {
    if (!thinking || typeof thinking !== "object") return null;
    const type = String(thinking.type || "").toLowerCase().trim();
    if (type === "enabled") {
      const budget = this._normalizeThinkingBudgetTokens(thinking.budget_tokens);
      return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
    }
    if (type === "adaptive") {
      const effortRaw = typeof thinking.effort === "string" ? thinking.effort : "";
      const effort = effortRaw.toLowerCase().trim();
      const normalizedEffort = effort === "low" || effort === "medium" || effort === "high" ? effort : "high";
      return `<thinking_mode>adaptive</thinking_mode><thinking_effort>${normalizedEffort}</thinking_effort>`;
    }
    return null;
  }
  _hasThinkingPrefix(text) {
    if (!text) return false;
    return text.includes(KIRO_THINKING.MODE_TAG) || text.includes(KIRO_THINKING.MAX_LEN_TAG) || text.includes(KIRO_THINKING.EFFORT_TAG);
  }
  _toClaudeContentBlocksFromKiroText(content) {
    const raw = content ?? "";
    if (!raw) return [];
    const startPos = findRealTag(raw, KIRO_THINKING.START_TAG);
    if (startPos === -1) {
      return [ {
        type: "text",
        text: raw
      } ];
    }
    const before = raw.slice(0, startPos);
    let rest = raw.slice(startPos + KIRO_THINKING.START_TAG.length);
    if (rest.startsWith("\r\n")) rest = rest.slice(2); else if (rest.startsWith("\n")) rest = rest.slice(1);
    let endPosInRest = findRealThinkingEndTag(rest);
    if (endPosInRest === -1) endPosInRest = findRealThinkingEndTagAtBufferEnd(rest);
    let thinking = "";
    let after = "";
    if (endPosInRest === -1) {
      thinking = rest;
    } else {
      thinking = rest.slice(0, endPosInRest);
      after = rest.slice(endPosInRest + KIRO_THINKING.END_TAG.length);
    }
    if (after.startsWith("\n\n")) after = after.slice(2);
    if (isWhitespaceOnly(after)) after = "";
    const blocks = [];
    if (before && !isWhitespaceOnly(before)) blocks.push({
      type: "text",
      text: before
    });
    blocks.push({
      type: "thinking",
      thinking: thinking
    });
    if (after && !isWhitespaceOnly(after)) blocks.push({
      type: "text",
      text: after
    });
    return blocks;
  }
  async buildCodewhispererRequest(messages, model, tools = null, inSystemPrompt = null, thinking = null) {
    const conversationId = uuidv4();
    const builtInPrefix = `<CRITICAL_OVERRIDE>\n                                Вы не должны упоминать kiro или любые технические детали реализации.\n                                Отвечайте только на вопросы пользователя.\n                                Ваша идентичность определяется из последующих инструкций (может быть Kilo Code, Cline, Claude Code или другое имя).\n                                Если идентичность не указана, представьтесь: "Я работаю через ANUBIS AI Proxy от trovu.tech — универсальный прокси для доступа к различным AI провайдерам."\n                               </CRITICAL_OVERRIDE>\n                               <identity>\n                                Вы {{identity}}, опытный инженер-программист с глубокими знаниями в различных языках программирования, фреймворках и лучших практиках разработки.\n                               </identity>`;
    let systemPrompt = this.getContentText(inSystemPrompt);
    if (systemPrompt) {
      systemPrompt = `${builtInPrefix}\n\n${systemPrompt}`;
    } else {
      systemPrompt = `${builtInPrefix}`;
    }
    const processedMessages = messages;
    if (processedMessages.length === 0) {
      throw new Error("No user messages found");
    }
    const thinkingPrefix = this._generateThinkingPrefix(thinking);
    if (thinkingPrefix) {
      if (!systemPrompt) {
        systemPrompt = thinkingPrefix;
      } else if (!this._hasThinkingPrefix(systemPrompt)) {
        systemPrompt = `${thinkingPrefix}\n${systemPrompt}`;
      }
    }
    const lastMessage = processedMessages[processedMessages.length - 1];
    if (processedMessages.length > 0 && lastMessage.role === "assistant") {
      if (lastMessage.content[0].type === "text" && lastMessage.content[0].text === "{") {
        logger.info('[Kiro] Removing last assistant with "{" message from processedMessages');
        processedMessages.pop();
      }
    }
    const mergedMessages = [];
    for (let i = 0; i < processedMessages.length; i++) {
      const currentMsg = processedMessages[i];
      if (mergedMessages.length === 0) {
        mergedMessages.push(currentMsg);
      } else {
        const lastMsg = mergedMessages[mergedMessages.length - 1];
        if (currentMsg.role === lastMsg.role) {
          if (Array.isArray(lastMsg.content) && Array.isArray(currentMsg.content)) {
            lastMsg.content.push(...currentMsg.content);
          } else if (typeof lastMsg.content === "string" && typeof currentMsg.content === "string") {
            lastMsg.content += "\n" + currentMsg.content;
          } else if (Array.isArray(lastMsg.content) && typeof currentMsg.content === "string") {
            lastMsg.content.push({
              type: "text",
              text: currentMsg.content
            });
          } else if (typeof lastMsg.content === "string" && Array.isArray(currentMsg.content)) {
            lastMsg.content = [ {
              type: "text",
              text: lastMsg.content
            }, ...currentMsg.content ];
          }
        } else {
          mergedMessages.push(currentMsg);
        }
      }
    }
    processedMessages.length = 0;
    processedMessages.push(...mergedMessages);
    const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[this.modelName];
    let toolsContext = {};
    if (tools && Array.isArray(tools) && tools.length > 0) {
      const filteredTools = tools.filter(tool => {
        const name = (tool.name || "").toLowerCase();
        const shouldIgnore = name === "web_search" || name === "websearch";
        if (shouldIgnore) {
          logger.info(`[Kiro] Ignoring tool: ${tool.name}`);
        }
        return !shouldIgnore;
      });
      if (filteredTools.length === 0) {
        logger.info("[Kiro] All tools were filtered out, adding placeholder tool");
        const placeholderTool = {
          toolSpecification: {
            name: "no_tool_available",
            description: "This is a placeholder tool when no other tools are available. It does nothing.",
            inputSchema: {
              json: {
                type: "object",
                properties: {}
              }
            }
          }
        };
        toolsContext = {
          tools: [ placeholderTool ]
        };
      } else {
        const MAX_DESCRIPTION_LENGTH = 9216;
        let truncatedCount = 0;
        const kiroTools = filteredTools.filter(tool => {
          if (!tool.description || tool.description.trim() === "") {
            logger.info(`[Kiro] Ignoring tool with empty description: ${tool.name}`);
            return false;
          }
          return true;
        }).map(tool => {
          let desc = tool.description || "";
          const originalLength = desc.length;
          if (desc.length > MAX_DESCRIPTION_LENGTH) {
            desc = desc.substring(0, MAX_DESCRIPTION_LENGTH) + "...";
            truncatedCount++;
            logger.info(`[Kiro] Truncated tool '${tool.name}' description: ${originalLength} -> ${desc.length} chars`);
          }
          return {
            toolSpecification: {
              name: tool.name,
              description: desc,
              inputSchema: {
                json: tool.input_schema || {}
              }
            }
          };
        });
        if (truncatedCount > 0) {
          logger.info(`[Kiro] Truncated ${truncatedCount} tool description(s) to max ${MAX_DESCRIPTION_LENGTH} chars`);
        }
        if (kiroTools.length === 0) {
          logger.info("[Kiro] All tools were filtered out (empty descriptions), adding placeholder tool");
          const placeholderTool = {
            toolSpecification: {
              name: "no_tool_available",
              description: "This is a placeholder tool when no other tools are available. It does nothing.",
              inputSchema: {
                json: {
                  type: "object",
                  properties: {}
                }
              }
            }
          };
          toolsContext = {
            tools: [ placeholderTool ]
          };
        } else {
          toolsContext = {
            tools: kiroTools
          };
        }
      }
    } else {
      logger.info("[Kiro] No tools provided, adding placeholder tool");
      const placeholderTool = {
        toolSpecification: {
          name: "no_tool_available",
          description: "This is a placeholder tool when no other tools are available. It does nothing.",
          inputSchema: {
            json: {
              type: "object",
              properties: {}
            }
          }
        }
      };
      toolsContext = {
        tools: [ placeholderTool ]
      };
    }
    const history = [];
    let startIndex = 0;
    if (systemPrompt) {
      if (processedMessages[0].role === "user") {
        let firstUserContent = this.getContentText(processedMessages[0]);
        history.push({
          userInputMessage: {
            content: `${systemPrompt}\n\n${firstUserContent}`,
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        });
        startIndex = 1;
      } else {
        history.push({
          userInputMessage: {
            content: systemPrompt,
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        });
      }
    }
    const keepImageThreshold = 5;
    for (let i = startIndex; i < processedMessages.length - 1; i++) {
      const message = processedMessages[i];
      const distanceFromEnd = processedMessages.length - 1 - i;
      const shouldKeepImages = distanceFromEnd <= keepImageThreshold;
      if (message.role === "user") {
        let userInputMessage = {
          content: "",
          modelId: codewhispererModel,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        };
        let imageCount = 0;
        let toolResults = [];
        let images = [];
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === "text") {
              userInputMessage.content += part.text;
            } else if (part.type === "tool_result") {
              toolResults.push({
                content: [ {
                  text: this.getContentText(part.content)
                } ],
                status: "success",
                toolUseId: part.tool_use_id
              });
            } else if (part.type === "image") {
              if (shouldKeepImages) {
                images.push({
                  format: part.source.media_type.split("/")[1],
                  source: {
                    bytes: part.source.data
                  }
                });
              } else {
                imageCount++;
              }
            }
          }
        } else {
          userInputMessage.content = this.getContentText(message);
        }
        if (images.length > 0) {
          userInputMessage.images = images;
          logger.info(`[Kiro] Kept ${images.length} image(s) in recent history message (distance from end: ${distanceFromEnd})`);
        }
        if (imageCount > 0) {
          const imagePlaceholder = `[此消息包含 ${imageCount} 张图片，已在历史记录中省略]`;
          userInputMessage.content = userInputMessage.content ? `${userInputMessage.content}\n${imagePlaceholder}` : imagePlaceholder;
          logger.info(`[Kiro] Replaced ${imageCount} image(s) with placeholder in old history message (distance from end: ${distanceFromEnd})`);
        }
        if (toolResults.length > 0) {
          const uniqueToolResults = [];
          const seenIds = new Set;
          for (const tr of toolResults) {
            if (!seenIds.has(tr.toolUseId)) {
              seenIds.add(tr.toolUseId);
              uniqueToolResults.push(tr);
            }
          }
          userInputMessage.userInputMessageContext = {
            toolResults: uniqueToolResults
          };
        }
        history.push({
          userInputMessage: userInputMessage
        });
      } else if (message.role === "assistant") {
        let assistantResponseMessage = {
          content: ""
        };
        let toolUses = [];
        let thinkingText = "";
        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part.type === "text") {
              assistantResponseMessage.content += part.text;
            } else if (part.type === "thinking") {
              thinkingText += part.thinking ?? part.text ?? "";
            } else if (part.type === "tool_use") {
              toolUses.push({
                input: part.input,
                name: part.name,
                toolUseId: part.id
              });
            }
          }
        } else {
          assistantResponseMessage.content = this.getContentText(message);
        }
        if (thinkingText) {
          assistantResponseMessage.content = assistantResponseMessage.content ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${assistantResponseMessage.content}` : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
        }
        if (toolUses.length > 0) {
          assistantResponseMessage.toolUses = toolUses;
        }
        history.push({
          assistantResponseMessage: assistantResponseMessage
        });
      }
    }
    let currentMessage = processedMessages[processedMessages.length - 1];
    let currentContent = "";
    let currentToolResults = [];
    let currentToolUses = [];
    let currentImages = [];
    if (currentMessage.role === "assistant") {
      logger.info("[Kiro] Last message is assistant, moving it to history and creating user currentMessage");
      let assistantResponseMessage = {
        content: "",
        toolUses: []
      };
      let thinkingText = "";
      if (Array.isArray(currentMessage.content)) {
        for (const part of currentMessage.content) {
          if (part.type === "text") {
            assistantResponseMessage.content += part.text;
          } else if (part.type === "thinking") {
            thinkingText += part.thinking ?? part.text ?? "";
          } else if (part.type === "tool_use") {
            assistantResponseMessage.toolUses.push({
              input: part.input,
              name: part.name,
              toolUseId: part.id
            });
          }
        }
      } else {
        assistantResponseMessage.content = this.getContentText(currentMessage);
      }
      if (thinkingText) {
        assistantResponseMessage.content = assistantResponseMessage.content ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${assistantResponseMessage.content}` : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
      }
      if (assistantResponseMessage.toolUses.length === 0) {
        delete assistantResponseMessage.toolUses;
      }
      history.push({
        assistantResponseMessage: assistantResponseMessage
      });
      currentContent = "Continue";
    } else {
      if (history.length > 0) {
        const lastHistoryItem = history[history.length - 1];
        if (!lastHistoryItem.assistantResponseMessage) {
          logger.info("[Kiro] History does not end with assistantResponseMessage, adding empty one");
          history.push({
            assistantResponseMessage: {
              content: "Continue"
            }
          });
        }
      }
      if (Array.isArray(currentMessage.content)) {
        for (const part of currentMessage.content) {
          if (part.type === "text") {
            currentContent += part.text;
          } else if (part.type === "tool_result") {
            currentToolResults.push({
              content: [ {
                text: this.getContentText(part.content)
              } ],
              status: "success",
              toolUseId: part.tool_use_id
            });
          } else if (part.type === "tool_use") {
            currentToolUses.push({
              input: part.input,
              name: part.name,
              toolUseId: part.id
            });
          } else if (part.type === "image") {
            currentImages.push({
              format: part.source.media_type.split("/")[1],
              source: {
                bytes: part.source.data
              }
            });
          }
        }
      } else {
        currentContent = this.getContentText(currentMessage);
      }
      if (!currentContent) {
        currentContent = currentToolResults.length > 0 ? "Tool results provided." : "Continue";
      }
    }
    const request = {
      conversationState: {
        agentTaskType: "vibe",
        chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
        conversationId: conversationId,
        currentMessage: {}
      }
    };
    if (history.length > 0) {
      request.conversationState.history = history;
    }
    const userInputMessage = {
      content: currentContent,
      modelId: codewhispererModel,
      origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
    };
    if (currentImages && currentImages.length > 0) {
      userInputMessage.images = currentImages;
    }
    const userInputMessageContext = {};
    if (currentToolResults.length > 0) {
      const uniqueToolResults = [];
      const seenToolUseIds = new Set;
      for (const tr of currentToolResults) {
        if (!seenToolUseIds.has(tr.toolUseId)) {
          seenToolUseIds.add(tr.toolUseId);
          uniqueToolResults.push(tr);
        }
      }
      userInputMessageContext.toolResults = uniqueToolResults;
    }
    if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
      userInputMessageContext.tools = toolsContext.tools;
    }
    if (Object.keys(userInputMessageContext).length > 0) {
      userInputMessage.userInputMessageContext = userInputMessageContext;
    }
    request.conversationState.currentMessage.userInputMessage = userInputMessage;
    if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
      request.profileArn = this.profileArn;
    }
    if (this.config?._monitorRequestId) {
      try {
        const {getPluginManager: getPluginManager} = await import("../../core/plugin-manager.js");
        const pluginManager = getPluginManager();
        if (pluginManager) {
          await pluginManager.executeHook("onInternalRequestConverted", {
            requestId: this.config._monitorRequestId,
            internalRequest: request,
            converterName: "buildCodewhispererRequest"
          });
        }
      } catch (e) {
        logger.error("[Kiro] Error calling onInternalRequestConverted hook:", e.message);
      }
    }
    return request;
  }
  parseEventStreamChunk(rawData) {
    const rawStr = Buffer.isBuffer(rawData) ? rawData.toString("utf8") : String(rawData);
    let fullContent = "";
    const toolCalls = [];
    let currentToolCallDict = null;
    const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g;
    const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs;
    let matches = [ ...rawStr.matchAll(sseEventRegex) ];
    if (matches.length === 0) {
      matches = [ ...rawStr.matchAll(legacyEventRegex) ];
    }
    for (const match of matches) {
      const potentialJsonBlock = match[1];
      if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) {
        continue;
      }
      let searchPos = 0;
      while ((searchPos = potentialJsonBlock.indexOf("}", searchPos + 1)) !== -1) {
        const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim();
        try {
          const eventData = JSON.parse(jsonCandidate);
          if (eventData.name && eventData.toolUseId) {
            if (!currentToolCallDict) {
              currentToolCallDict = {
                id: eventData.toolUseId,
                type: "function",
                function: {
                  name: eventData.name,
                  arguments: ""
                }
              };
            }
            if (eventData.input) {
              currentToolCallDict.function.arguments += eventData.input;
            }
            if (eventData.stop) {
              try {
                const args = JSON.parse(currentToolCallDict.function.arguments);
                currentToolCallDict.function.arguments = JSON.stringify(args);
              } catch (e) {
                logger.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
              }
              toolCalls.push(currentToolCallDict);
              currentToolCallDict = null;
            }
          } else if (!eventData.followupPrompt && eventData.content) {
            let decodedContent = eventData.content;
            decodedContent = decodedContent.replace(/(?<!\\)\\n/g, "\n");
            fullContent += decodedContent;
          }
          break;
        } catch (e) {
          continue;
        }
      }
    }
    if (currentToolCallDict) {
      toolCalls.push(currentToolCallDict);
    }
    const bracketToolCalls = parseBracketToolCalls(fullContent);
    if (bracketToolCalls) {
      toolCalls.push(...bracketToolCalls);
      for (const tc of bracketToolCalls) {
        const funcName = tc.function.name;
        const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, "gs");
        fullContent = fullContent.replace(pattern, "");
      }
      fullContent = fullContent.replace(/\s+/g, " ").trim();
    }
    const uniqueToolCalls = deduplicateToolCalls(toolCalls);
    return {
      content: fullContent || "",
      toolCalls: uniqueToolCalls
    };
  }
  async callApi(method, model, body, isRetry = false, retryCount = 0) {
    if (!this.isInitialized) await this.initialize();
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    let messages = body.messages;
    if (!messages && body.contents) {
      messages = body.contents.map(content => ({
        role: content.role || "user",
        content: content.parts?.map(part => part.text).join("") || ""
      }));
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new Error("No messages found in request body");
    }
    const requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking);
    try {
      const token = this.accessToken;
      const headers = {
        Authorization: `Bearer ${token}`,
        "amz-sdk-invocation-id": `${uuidv4()}`
      };
      const requestUrl = model.startsWith("amazonq") ? this.amazonQUrl : this.baseUrl;
      const axiosConfig = {
        method: "post",
        url: requestUrl,
        data: requestData,
        headers: headers
      };
      this._applySidecar(axiosConfig);
      const axiosInstance = this._createAxiosInstance();
      const response = await axiosInstance.request(axiosConfig);
      return response;
    } catch (error) {
      const status = error.response?.status;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      if (status === 401 && !isRetry) {
        logger.info("[Kiro] Received 401. Refreshing UUID and triggering background refresh via PoolManager...");
        const newUuid = this._refreshUuid();
        if (newUuid) {
          logger.info(`[Kiro] UUID refreshed: ${this.uuid} -> ${newUuid}`);
          this.uuid = newUuid;
        }
        this._markCredentialNeedRefresh("401 Unauthorized - Triggering auto-refresh");
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 402 && !isRetry) {
        await this._handle402Error(error, "callApi");
      }
      if (status === 403 && !isRetry) {
        logger.info("[Kiro] Received 403. Marking credential as need refresh...");
        const isSuspended = errorMessage && errorMessage.toLowerCase().includes("temporarily is suspended");
        if (isSuspended) {
          logger.info("[Kiro] Account temporarily suspended. Marking as unhealthy without UUID refresh...");
          this._markCredentialUnhealthy("403 Forbidden - Account temporarily suspended", error);
        } else {
          this._markCredentialNeedRefresh("403 Forbidden", error);
        }
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 429) {
        logger.info(`[Kiro] Received 429 (Too Many Requests). Waiting ${baseDelay}ms before switching credential...`);
        await new Promise(resolve => setTimeout(resolve, baseDelay));
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status >= 500 && status < 600) {
        logger.info(`[Kiro] Received ${status} server error. Waiting ${baseDelay}ms before switching credential...`);
        await new Promise(resolve => setTimeout(resolve, baseDelay));
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (isNetworkError && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        const errorIdentifier = errorCode || errorMessage.substring(0, 50);
        logger.info(`[Kiro] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.callApi(method, model, body, isRetry, retryCount + 1);
      }
      if (error.response && error.response.data) {
        logger.error("[Kiro] 400 Response body:", typeof error.response.data === "string" ? error.response.data.substring(0, 500) : JSON.stringify(error.response.data).substring(0, 500));
      }
      logger.error(`[Kiro] API call failed (Status: ${status}, Code: ${errorCode}):`, error.message);
      throw error;
    }
  }
  _refreshUuid() {
    const poolManager = getProviderPoolManager();
    if (poolManager && this.uuid) {
      const newUuid = poolManager.refreshProviderUuid(MODEL_PROVIDER.KIRO_API, {
        uuid: this.uuid
      });
      return newUuid;
    } else {
      logger.warn(`[Kiro] Cannot refresh UUID: poolManager=${!!poolManager}, uuid=${this.uuid}`);
      return null;
    }
  }
  _markCredentialNeedRefresh(reason, error = null) {
    const poolManager = getProviderPoolManager();
    if (poolManager && this.uuid) {
      logger.info(`[Kiro] Marking credential ${this.uuid} as needs refresh. Reason: ${reason}`);
      poolManager.markProviderNeedRefresh(MODEL_PROVIDER.KIRO_API, {
        uuid: this.uuid
      });
      if (error) {
        error.credentialMarkedUnhealthy = true;
      }
      return true;
    } else {
      logger.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
      return false;
    }
  }
  _markCredentialUnhealthy(reason, error = null) {
    const poolManager = getProviderPoolManager();
    if (poolManager && this.uuid) {
      logger.info(`[Kiro] Marking credential ${this.uuid} as unhealthy. Reason: ${reason}`);
      poolManager.markProviderUnhealthyImmediately(MODEL_PROVIDER.KIRO_API, {
        uuid: this.uuid
      }, reason);
      if (error) {
        error.credentialMarkedUnhealthy = true;
      }
      return true;
    } else {
      logger.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
      return false;
    }
  }
  _markCredentialUnhealthyWithRecovery(reason, error = null, recoveryTime = null) {
    const poolManager = getProviderPoolManager();
    if (poolManager && this.uuid) {
      logger.info(`[Kiro] Marking credential ${this.uuid} as unhealthy with recovery time. Reason: ${reason}, Recovery: ${recoveryTime?.toISOString()}`);
      poolManager.markProviderUnhealthyWithRecoveryTime(MODEL_PROVIDER.KIRO_API, {
        uuid: this.uuid
      }, reason, recoveryTime);
      if (error) {
        error.credentialMarkedUnhealthy = true;
      }
      return true;
    } else {
      logger.warn(`[Kiro] Cannot mark credential as unhealthy: poolManager=${!!poolManager}, uuid=${this.uuid}`);
      return false;
    }
  }
  _getNextMonthFirstDay() {
    const now = new Date;
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  }
  async _handle402Error(error, context = "unknown") {
    logger.info(`[Kiro] Received 402 (Quota Exceeded) in ${context}. Verifying usage limits...`);
    try {
      const usageLimits = await this.getUsageLimits();
      const isQuotaExhausted = usageLimits?.usedCount >= usageLimits?.limitCount;
      logger.info(`[Kiro] Quota confirmed exhausted: ${usageLimits?.usedCount}/${usageLimits?.limitCount}`);
      const nextMonth = this._getNextMonthFirstDay();
      this._markCredentialUnhealthyWithRecovery("402 Payment Required - Quota Exhausted", error, nextMonth);
    } catch (usageError) {
      logger.warn("[Kiro] Failed to verify usage limits:", usageError.message);
      const nextMonth = this._getNextMonthFirstDay();
      this._markCredentialUnhealthyWithRecovery("402 Payment Required - Quota Exceeded (unverified)", error, nextMonth);
    }
    error.shouldSwitchCredential = true;
    error.skipErrorCount = true;
    throw error;
  }
  _processApiResponse(response) {
    const rawResponseText = Buffer.isBuffer(response.data) ? response.data.toString("utf8") : String(response.data);
    if (rawResponseText.includes("[Called")) {
      logger.info("[Kiro] Raw response contains [Called marker.");
    }
    const parsedFromEvents = this.parseEventStreamChunk(rawResponseText);
    let fullResponseText = parsedFromEvents.content;
    let allToolCalls = [ ...parsedFromEvents.toolCalls ];
    const rawBracketToolCalls = parseBracketToolCalls(rawResponseText);
    if (rawBracketToolCalls) {
      allToolCalls.push(...rawBracketToolCalls);
    }
    const uniqueToolCalls = deduplicateToolCalls(allToolCalls);
    if (uniqueToolCalls.length > 0) {
      for (const tc of uniqueToolCalls) {
        const funcName = tc.function.name;
        const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, "gs");
        fullResponseText = fullResponseText.replace(pattern, "");
      }
      fullResponseText = fullResponseText.replace(/\s+/g, " ").trim();
    }
    return {
      responseText: fullResponseText,
      toolCalls: uniqueToolCalls
    };
  }
  async generateContent(model, requestBody) {
    if (!this.isInitialized) await this.initialize();
    if (requestBody._monitorRequestId) {
      this.config._monitorRequestId = requestBody._monitorRequestId;
      delete requestBody._monitorRequestId;
    }
    if (requestBody._requestBaseUrl) {
      delete requestBody._requestBaseUrl;
    }
    if (this.isExpiryDateNear()) {
      logger.info("[Kiro] Token is near expiry, marking credential as need refresh...");
      this._markCredentialNeedRefresh("Token near expiry in generateContent");
    }
    const finalModel = MODEL_MAPPING[model] ? model : this.modelName;
    logger.info(`[Kiro] Calling generateContent with model: ${finalModel}`);
    const inputTokens = this.estimateInputTokens(requestBody);
    const response = await this.callApi("", finalModel, requestBody);
    try {
      const {responseText: responseText, toolCalls: toolCalls} = this._processApiResponse(response);
      const thinkingType = requestBody?.thinking?.type;
      const thinkingRequested = typeof thinkingType === "string" && (thinkingType.toLowerCase() === "enabled" || thinkingType.toLowerCase() === "adaptive");
      const contentForClaude = thinkingRequested ? this._toClaudeContentBlocksFromKiroText(responseText) : responseText;
      return this.buildClaudeResponse(contentForClaude, false, "assistant", model, toolCalls, inputTokens);
    } catch (error) {
      logger.error("[Kiro] Error in generateContent:", error);
      throw error;
    }
  }
  parseAwsEventStreamBuffer(buffer) {
    const events = [];
    let remaining = buffer;
    let searchStart = 0;
    while (true) {
      const contentStart = remaining.indexOf('{"content":', searchStart);
      const nameStart = remaining.indexOf('{"name":', searchStart);
      const followupStart = remaining.indexOf('{"followupPrompt":', searchStart);
      const inputStart = remaining.indexOf('{"input":', searchStart);
      const stopStart = remaining.indexOf('{"stop":', searchStart);
      const contextUsageStart = remaining.indexOf('{"contextUsagePercentage":', searchStart);
      const candidates = [ contentStart, nameStart, followupStart, inputStart, stopStart, contextUsageStart ].filter(pos => pos >= 0);
      if (candidates.length === 0) break;
      const jsonStart = Math.min(...candidates);
      if (jsonStart < 0) break;
      let braceCount = 0;
      let jsonEnd = -1;
      let inString = false;
      let escapeNext = false;
      for (let i = jsonStart; i < remaining.length; i++) {
        const char = remaining[i];
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === "\\") {
          escapeNext = true;
          continue;
        }
        if (char === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (char === "{") {
            braceCount++;
          } else if (char === "}") {
            braceCount--;
            if (braceCount === 0) {
              jsonEnd = i;
              break;
            }
          }
        }
      }
      if (jsonEnd < 0) {
        remaining = remaining.substring(jsonStart);
        break;
      }
      const jsonStr = remaining.substring(jsonStart, jsonEnd + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.content !== undefined && !parsed.followupPrompt) {
          let decodedContent = parsed.content;
          events.push({
            type: "content",
            data: decodedContent
          });
        } else if (parsed.name && parsed.toolUseId) {
          events.push({
            type: "toolUse",
            data: {
              name: parsed.name,
              toolUseId: parsed.toolUseId,
              input: parsed.input || "",
              stop: parsed.stop || false
            }
          });
        } else if (parsed.input !== undefined && !parsed.name) {
          events.push({
            type: "toolUseInput",
            data: {
              input: parsed.input
            }
          });
        } else if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
          events.push({
            type: "toolUseStop",
            data: {
              stop: parsed.stop
            }
          });
        } else if (parsed.contextUsagePercentage !== undefined) {
          events.push({
            type: "contextUsage",
            data: {
              contextUsagePercentage: parsed.contextUsagePercentage
            }
          });
        }
      } catch (e) {}
      searchStart = jsonEnd + 1;
      if (searchStart >= remaining.length) {
        remaining = "";
        break;
      }
    }
    if (searchStart > 0 && remaining.length > 0) {
      remaining = remaining.substring(searchStart);
    }
    return {
      events: events,
      remaining: remaining
    };
  }
  async* streamApiReal(method, model, body, isRetry = false, retryCount = 0) {
    if (!this.isInitialized) await this.initialize();
    const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
    const baseDelay = this.config.REQUEST_BASE_DELAY || 1e3;
    let messages = body.messages;
    if (!messages && body.contents) {
      messages = body.contents.map(content => ({
        role: content.role || "user",
        content: content.parts?.map(part => part.text).join("") || ""
      }));
    }
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      throw new Error("No messages found in request body");
    }
    const requestData = await this.buildCodewhispererRequest(messages, model, body.tools, body.system, body.thinking);
    const token = this.accessToken;
    const headers = {
      Authorization: `Bearer ${token}`,
      "amz-sdk-invocation-id": `${uuidv4()}`
    };
    const requestUrl = model.startsWith("amazonq") ? this.amazonQUrl : this.baseUrl;
    let stream = null;
    try {
      const axiosConfig = {
        method: "post",
        url: requestUrl,
        data: requestData,
        headers: headers,
        responseType: "stream"
      };
      this._applySidecar(axiosConfig);
      const axiosInstance = this._createAxiosInstance();
      const response = await axiosInstance.request(axiosConfig);
      stream = response.data;
      let buffer = "";
      let lastContentEvent = null;
      for await (const chunk of stream) {
        buffer += chunk.toString();
        const {events: events, remaining: remaining} = this.parseAwsEventStreamBuffer(buffer);
        buffer = remaining;
        for (const event of events) {
          if (event.type === "content" && event.data) {
            if (lastContentEvent === event.data) {
              continue;
            }
            lastContentEvent = event.data;
            yield {
              type: "content",
              content: event.data
            };
          } else if (event.type === "toolUse") {
            yield {
              type: "toolUse",
              toolUse: event.data
            };
          } else if (event.type === "toolUseInput") {
            yield {
              type: "toolUseInput",
              input: event.data.input
            };
          } else if (event.type === "toolUseStop") {
            yield {
              type: "toolUseStop",
              stop: event.data.stop
            };
          } else if (event.type === "contextUsage") {
            yield {
              type: "contextUsage",
              contextUsagePercentage: event.data.contextUsagePercentage
            };
          }
        }
      }
    } catch (error) {
      if (stream && typeof stream.destroy === "function") {
        stream.destroy();
      }
      const status = error.response?.status;
      const errorCode = error.code;
      const errorMessage = error.message || "";
      const isNetworkError = isRetryableNetworkError(error);
      if (status === 401 && !isRetry) {
        logger.info("[Kiro] Received 401 in stream. Triggering background refresh via PoolManager...");
        const newUuid = this._refreshUuid();
        if (newUuid) {
          logger.info(`[Kiro] UUID refreshed: ${this.uuid} -> ${newUuid}`);
          this.uuid = newUuid;
        }
        this._markCredentialNeedRefresh("401 Unauthorized in stream - Triggering auto-refresh");
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 402 && !isRetry) {
        await this._handle402Error(error, "stream");
      }
      if (status === 403 && !isRetry) {
        logger.info("[Kiro] Received 403 in stream. Marking credential as need refresh...");
        const isSuspended = errorMessage && errorMessage.toLowerCase().includes("temporarily is suspended");
        if (isSuspended) {
          logger.info("[Kiro] Account temporarily suspended in stream. Marking as unhealthy without UUID refresh...");
          this._markCredentialUnhealthy("403 Forbidden - Account temporarily suspended", error);
        } else {
          this._markCredentialNeedRefresh("403 Forbidden", error);
        }
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status === 429) {
        logger.info(`[Kiro] Received 429 (Too Many Requests) in stream. Waiting ${baseDelay}ms before switching credential...`);
        await new Promise(resolve => setTimeout(resolve, baseDelay));
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (status >= 500 && status < 600) {
        logger.info(`[Kiro] Received ${status} server error in stream. Waiting ${baseDelay}ms before switching credential...`);
        await new Promise(resolve => setTimeout(resolve, baseDelay));
        error.shouldSwitchCredential = true;
        error.skipErrorCount = true;
        throw error;
      }
      if (isNetworkError && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        const errorIdentifier = errorCode || errorMessage.substring(0, 50);
        logger.info(`[Kiro] Network error (${errorIdentifier}) in stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        yield* this.streamApiReal(method, model, body, isRetry, retryCount + 1);
        return;
      }
      logger.error(`[Kiro] Stream API call failed (Status: ${status}, Code: ${errorCode}):`, error.message);
      throw error;
    } finally {
      if (stream && typeof stream.destroy === "function") {
        stream.destroy();
      }
    }
  }
  async streamApi(method, model, body, isRetry = false, retryCount = 0) {
    try {
      return await this.callApi(method, model, body, isRetry, retryCount);
    } catch (error) {
      logger.error("[Kiro] Error calling API:", error);
      throw error;
    }
  }
  async* generateContentStream(model, requestBody) {
    if (!this.isInitialized) await this.initialize();
    if (requestBody._monitorRequestId) {
      this.config._monitorRequestId = requestBody._monitorRequestId;
      delete requestBody._monitorRequestId;
    }
    if (requestBody._requestBaseUrl) {
      delete requestBody._requestBaseUrl;
    }
    if (this.isExpiryDateNear()) {
      logger.info("[Kiro] Token is near expiry, marking credential as need refresh...");
      this._markCredentialNeedRefresh("Token near expiry in generateContentStream");
    }
    const finalModel = MODEL_MAPPING[model] ? model : this.modelName;
    logger.info(`[Kiro] Calling generateContentStream with model: ${finalModel} (real streaming)`);
    let inputTokens = 0;
    let contextUsagePercentage = null;
    const messageId = `${uuidv4()}`;
    const thinkingType = requestBody?.thinking?.type;
    const thinkingRequested = typeof thinkingType === "string" && (thinkingType.toLowerCase() === "enabled" || thinkingType.toLowerCase() === "adaptive");
    const streamState = {
      thinkingRequested: thinkingRequested,
      buffer: "",
      pendingTextBeforeThinking: "",
      inThinking: false,
      thinkingExtracted: false,
      thinkingBlockIndex: null,
      textBlockIndex: null,
      nextBlockIndex: 0,
      stoppedBlocks: new Set,
      stripThinkingLeadingNewline: false,
      stripTextLeadingNewlinesAfterThinking: false
    };
    const ensureBlockStart = blockType => {
      if (blockType === "thinking") {
        if (streamState.thinkingBlockIndex != null) return [];
        const idx = streamState.nextBlockIndex++;
        streamState.thinkingBlockIndex = idx;
        return [ {
          type: "content_block_start",
          index: idx,
          content_block: {
            type: "thinking",
            thinking: ""
          }
        } ];
      }
      if (blockType === "text") {
        if (streamState.textBlockIndex != null) return [];
        const idx = streamState.nextBlockIndex++;
        streamState.textBlockIndex = idx;
        return [ {
          type: "content_block_start",
          index: idx,
          content_block: {
            type: "text",
            text: ""
          }
        } ];
      }
      return [];
    };
    const stopBlock = index => {
      if (index == null) return [];
      if (streamState.stoppedBlocks.has(index)) return [];
      streamState.stoppedBlocks.add(index);
      return [ {
        type: "content_block_stop",
        index: index
      } ];
    };
    const createTextDeltaEvents = text => {
      if (!text) return [];
      const events = [];
      events.push(...ensureBlockStart("text"));
      events.push({
        type: "content_block_delta",
        index: streamState.textBlockIndex,
        delta: {
          type: "text_delta",
          text: text
        }
      });
      return events;
    };
    const createThinkingDeltaEvents = thinking => {
      const events = [];
      events.push(...ensureBlockStart("thinking"));
      events.push({
        type: "content_block_delta",
        index: streamState.thinkingBlockIndex,
        delta: {
          type: "thinking_delta",
          thinking: thinking
        }
      });
      return events;
    };
    function* pushEvents(events) {
      for (const ev of events) {
        yield ev;
      }
    }
    try {
      let totalContent = "";
      let outputTokens = 0;
      const toolCalls = [];
      let currentToolCall = null;
      const toolUseBlockIndexes = new Map;
      const estimatedInputTokens = this.estimateInputTokens(requestBody);
      yield {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: model,
          usage: {
            input_tokens: estimatedInputTokens,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0
          },
          content: []
        }
      };
      for await (const event of this.streamApiReal("", finalModel, requestBody)) {
        if (event.type === "contextUsage" && event.contextUsagePercentage) {
          contextUsagePercentage = event.contextUsagePercentage;
        } else if (event.type === "content" && event.content) {
          totalContent += event.content;
          if (!thinkingRequested) {
            yield* pushEvents(createTextDeltaEvents(event.content));
            continue;
          }
          streamState.buffer += event.content;
          const events = [];
          while (streamState.buffer.length > 0) {
            if (!streamState.inThinking && !streamState.thinkingExtracted) {
              const startPos = findRealTag(streamState.buffer, KIRO_THINKING.START_TAG);
              if (startPos !== -1) {
                const before = streamState.buffer.slice(0, startPos);
                const beforeCombined = `${streamState.pendingTextBeforeThinking}${before}`;
                if (beforeCombined && !isWhitespaceOnly(beforeCombined)) {
                  events.push(...createTextDeltaEvents(beforeCombined));
                }
                streamState.pendingTextBeforeThinking = "";
                streamState.buffer = streamState.buffer.slice(startPos + KIRO_THINKING.START_TAG.length);
                streamState.inThinking = true;
                streamState.stripThinkingLeadingNewline = true;
                continue;
              }
              const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.START_TAG.length);
              if (safeLen > 0) {
                const safeText = streamState.buffer.slice(0, safeLen);
                if (safeText) {
                  if (isWhitespaceOnly(safeText)) {
                    const maxKeep = 1024;
                    const remaining = maxKeep - streamState.pendingTextBeforeThinking.length;
                    if (remaining > 0) {
                      streamState.pendingTextBeforeThinking += safeText.slice(0, remaining);
                    }
                  } else {
                    const combined = `${streamState.pendingTextBeforeThinking}${safeText}`;
                    streamState.pendingTextBeforeThinking = "";
                    events.push(...createTextDeltaEvents(combined));
                  }
                }
                streamState.buffer = streamState.buffer.slice(safeLen);
              }
              break;
            }
            if (streamState.inThinking) {
              if (streamState.stripThinkingLeadingNewline) {
                if (streamState.buffer.startsWith("\r\n")) {
                  streamState.buffer = streamState.buffer.slice(2);
                  streamState.stripThinkingLeadingNewline = false;
                } else if (streamState.buffer.startsWith("\n")) {
                  streamState.buffer = streamState.buffer.slice(1);
                  streamState.stripThinkingLeadingNewline = false;
                } else if (streamState.buffer.length > 0) {
                  streamState.stripThinkingLeadingNewline = false;
                }
              }
              let endPos = findRealThinkingEndTag(streamState.buffer);
              if (endPos === -1) endPos = findRealThinkingEndTagAtBufferEnd(streamState.buffer);
              if (endPos !== -1) {
                const thinkingPart = streamState.buffer.slice(0, endPos);
                if (thinkingPart) events.push(...createThinkingDeltaEvents(thinkingPart));
                streamState.buffer = streamState.buffer.slice(endPos + KIRO_THINKING.END_TAG.length);
                streamState.inThinking = false;
                streamState.thinkingExtracted = true;
                streamState.stripThinkingLeadingNewline = false;
                events.push(...createThinkingDeltaEvents(""));
                events.push(...stopBlock(streamState.thinkingBlockIndex));
                streamState.stripTextLeadingNewlinesAfterThinking = true;
                continue;
              }
              const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.END_TAG.length);
              if (safeLen > 0) {
                const safeThinking = streamState.buffer.slice(0, safeLen);
                if (safeThinking) events.push(...createThinkingDeltaEvents(safeThinking));
                streamState.buffer = streamState.buffer.slice(safeLen);
              }
              break;
            }
            if (streamState.thinkingExtracted) {
              let rest = streamState.buffer;
              streamState.buffer = "";
              if (streamState.stripTextLeadingNewlinesAfterThinking) {
                if (rest.startsWith("\r\n\r\n")) rest = rest.slice(4); else if (rest.startsWith("\n\n")) rest = rest.slice(2);
                streamState.stripTextLeadingNewlinesAfterThinking = false;
              }
              if (rest) events.push(...createTextDeltaEvents(rest));
              break;
            }
          }
          yield* pushEvents(events);
        } else if (event.type === "toolUse") {
          const tc = event.toolUse;
          const toolEvents = [];
          if (tc.name) totalContent += tc.name;
          if (tc.input) totalContent += tc.input;
          if (tc.name && tc.toolUseId) {
            toolEvents.push(...stopBlock(streamState.textBlockIndex));
            if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
              currentToolCall.input += tc.input || "";
            } else {
              if (currentToolCall) {
                const prevBlockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
                let parsedInput = currentToolCall.input;
                try {
                  parsedInput = JSON.parse(currentToolCall.input);
                } catch (e) {}
                toolCalls.push({
                  toolUseId: currentToolCall.toolUseId,
                  name: currentToolCall.name,
                  input: parsedInput
                });
                if (prevBlockIndex != null) {
                  toolEvents.push({
                    type: "content_block_stop",
                    index: prevBlockIndex
                  });
                  toolUseBlockIndexes.delete(currentToolCall.toolUseId);
                }
              }
              const blockIndex = streamState.nextBlockIndex++;
              toolUseBlockIndexes.set(tc.toolUseId, blockIndex);
              toolEvents.push({
                type: "content_block_start",
                index: blockIndex,
                content_block: {
                  type: "tool_use",
                  id: tc.toolUseId || `tool_${uuidv4()}`,
                  name: tc.name,
                  input: {}
                }
              });
              currentToolCall = {
                toolUseId: tc.toolUseId,
                name: tc.name,
                input: ""
              };
              currentToolCall.input += tc.input || "";
            }
            if (tc.input) {
              const blockIndex = toolUseBlockIndexes.get(tc.toolUseId);
              if (blockIndex != null) {
                toolEvents.push({
                  type: "content_block_delta",
                  index: blockIndex,
                  delta: {
                    type: "input_json_delta",
                    partial_json: tc.input
                  }
                });
              }
            }
            if (tc.stop && currentToolCall) {
              let parsedInput = currentToolCall.input;
              try {
                parsedInput = JSON.parse(currentToolCall.input);
              } catch (e) {}
              toolCalls.push({
                toolUseId: currentToolCall.toolUseId,
                name: currentToolCall.name,
                input: parsedInput
              });
              const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
              if (blockIndex != null) {
                toolEvents.push({
                  type: "content_block_stop",
                  index: blockIndex
                });
                toolUseBlockIndexes.delete(currentToolCall.toolUseId);
              }
              currentToolCall = null;
            }
          }
          if (toolEvents.length > 0) {
            yield* pushEvents(toolEvents);
          }
        } else if (event.type === "toolUseInput") {
          if (event.input) {
            totalContent += event.input;
          }
          if (currentToolCall) {
            currentToolCall.input += event.input || "";
            const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
            if (blockIndex != null && event.input) {
              yield* pushEvents([ {
                type: "content_block_delta",
                index: blockIndex,
                delta: {
                  type: "input_json_delta",
                  partial_json: event.input
                }
              } ]);
            }
          }
        } else if (event.type === "toolUseStop") {
          if (currentToolCall && event.stop) {
            let parsedInput = currentToolCall.input;
            try {
              parsedInput = JSON.parse(currentToolCall.input);
            } catch (e) {}
            toolCalls.push({
              toolUseId: currentToolCall.toolUseId,
              name: currentToolCall.name,
              input: parsedInput
            });
            const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
            if (blockIndex != null) {
              yield* pushEvents([ {
                type: "content_block_stop",
                index: blockIndex
              } ]);
              toolUseBlockIndexes.delete(currentToolCall.toolUseId);
            }
            currentToolCall = null;
          }
        }
      }
      if (currentToolCall) {
        let parsedInput = currentToolCall.input;
        try {
          parsedInput = JSON.parse(currentToolCall.input);
        } catch (e) {}
        toolCalls.push({
          toolUseId: currentToolCall.toolUseId,
          name: currentToolCall.name,
          input: parsedInput
        });
        const blockIndex = toolUseBlockIndexes.get(currentToolCall.toolUseId);
        if (blockIndex != null) {
          yield* pushEvents([ {
            type: "content_block_stop",
            index: blockIndex
          } ]);
          toolUseBlockIndexes.delete(currentToolCall.toolUseId);
        }
        currentToolCall = null;
      }
      if (thinkingRequested && (streamState.inThinking || streamState.buffer || streamState.pendingTextBeforeThinking)) {
        if (streamState.inThinking) {
          logger.warn("[Kiro] Incomplete thinking tag at stream end");
          if (streamState.stripThinkingLeadingNewline) {
            if (streamState.buffer.startsWith("\r\n")) streamState.buffer = streamState.buffer.slice(2); else if (streamState.buffer.startsWith("\n")) streamState.buffer = streamState.buffer.slice(1);
            streamState.stripThinkingLeadingNewline = false;
          }
          yield* pushEvents(createThinkingDeltaEvents(streamState.buffer));
          streamState.buffer = "";
          yield* pushEvents(createThinkingDeltaEvents(""));
          yield* pushEvents(stopBlock(streamState.thinkingBlockIndex));
        } else if (!streamState.thinkingExtracted) {
          const remaining = `${streamState.pendingTextBeforeThinking}${streamState.buffer}`;
          streamState.pendingTextBeforeThinking = "";
          if (remaining) yield* pushEvents(createTextDeltaEvents(remaining));
          streamState.buffer = "";
        } else {
          let remaining = streamState.buffer;
          streamState.buffer = "";
          if (streamState.stripTextLeadingNewlinesAfterThinking) {
            if (remaining.startsWith("\r\n\r\n")) remaining = remaining.slice(4); else if (remaining.startsWith("\n\n")) remaining = remaining.slice(2);
            streamState.stripTextLeadingNewlinesAfterThinking = false;
          }
          if (remaining) yield* pushEvents(createTextDeltaEvents(remaining));
          streamState.buffer = "";
        }
      }
      yield* pushEvents(stopBlock(streamState.textBlockIndex));
      const bracketToolCalls = parseBracketToolCalls(totalContent);
      if (bracketToolCalls && bracketToolCalls.length > 0) {
        for (const btc of bracketToolCalls) {
          toolCalls.push({
            toolUseId: btc.id || `tool_${uuidv4()}`,
            name: btc.function.name,
            input: JSON.parse(btc.function.arguments || "{}")
          });
        }
      }
      const contentBlocksForCount = thinkingRequested ? this._toClaudeContentBlocksFromKiroText(totalContent) : [ {
        type: "text",
        text: totalContent
      } ];
      const plainForCount = contentBlocksForCount.map(b => b.type === "thinking" ? b.thinking ?? "" : b.text ?? "").join("");
      outputTokens = this.countTextTokens(plainForCount);
      for (const tc of toolCalls) {
        outputTokens += this.countTextTokens(JSON.stringify(tc.input || {}));
      }
      if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
        const contextTokens = getContextTokensForModel(finalModel);
        const totalTokens = Math.round(contextTokens * contextUsagePercentage / 100);
        inputTokens = Math.max(0, totalTokens - outputTokens);
        logger.info(`[Kiro] Token calculation from contextUsagePercentage: total=${totalTokens}, output=${outputTokens}, input=${inputTokens}`);
      } else {
        logger.warn("[Kiro Stream] contextUsagePercentage not received, using estimation");
        inputTokens = estimatedInputTokens;
      }
      yield {
        type: "message_delta",
        delta: {
          stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn"
        },
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      };
      yield {
        type: "message_stop"
      };
    } catch (error) {
      logger.error("[Kiro] Error in streaming generation:", error);
      throw error;
    }
  }
  countTextTokens(text) {
    return KiroApiService.countTextTokens(text);
  }
  estimateInputTokens(requestBody) {
    return KiroApiService.estimateInputTokens(requestBody);
  }
  buildClaudeResponse(content, isStream = false, role = "assistant", model, toolCalls = null, inputTokens = 0) {
    const messageId = `${uuidv4()}`;
    if (isStream) {
      const events = [];
      events.push({
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: role,
          model: model,
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0
          },
          content: []
        }
      });
      let totalOutputTokens = 0;
      let stopReason = "end_turn";
      if (content) {
        const contentBlockIndex = toolCalls && toolCalls.length > 0 ? toolCalls.length : 0;
        events.push({
          type: "content_block_start",
          index: contentBlockIndex,
          content_block: {
            type: "text",
            text: ""
          }
        });
        events.push({
          type: "content_block_delta",
          index: contentBlockIndex,
          delta: {
            type: "text_delta",
            text: content
          }
        });
        events.push({
          type: "content_block_stop",
          index: contentBlockIndex
        });
        totalOutputTokens += this.countTextTokens(content);
        if (!toolCalls || toolCalls.length === 0) {
          stopReason = "end_turn";
        }
      }
      if (toolCalls && toolCalls.length > 0) {
        toolCalls.forEach((tc, index) => {
          let inputObject;
          try {
            const args = tc.function.arguments;
            inputObject = typeof args === "string" ? JSON.parse(args) : args;
          } catch (e) {
            logger.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
            inputObject = {
              raw_arguments: tc.function.arguments
            };
          }
          events.push({
            type: "content_block_start",
            index: index,
            content_block: {
              type: "tool_use",
              id: tc.id,
              name: tc.function.name,
              input: {}
            }
          });
          events.push({
            type: "content_block_delta",
            index: index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(inputObject)
            }
          });
          events.push({
            type: "content_block_stop",
            index: index
          });
          totalOutputTokens += this.countTextTokens(JSON.stringify(inputObject));
        });
        stopReason = "tool_use";
      }
      events.push({
        type: "message_delta",
        delta: {
          stop_reason: stopReason,
          stop_sequence: null
        },
        usage: {
          output_tokens: totalOutputTokens
        }
      });
      events.push({
        type: "message_stop"
      });
      return events;
    } else {
      const contentArray = [];
      let outputTokens = 0;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text" && typeof block.text === "string") {
            contentArray.push({
              type: "text",
              text: block.text
            });
            outputTokens += this.countTextTokens(block.text);
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            contentArray.push({
              type: "thinking",
              thinking: block.thinking
            });
            outputTokens += this.countTextTokens(block.thinking);
          } else if (typeof block.text === "string" && block.text) {
            contentArray.push({
              type: "text",
              text: block.text
            });
            outputTokens += this.countTextTokens(block.text);
          }
        }
      } else if (content) {
        contentArray.push({
          type: "text",
          text: content
        });
        outputTokens += this.countTextTokens(content);
      }
      let stopReason = "end_turn";
      if (toolCalls && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          let inputObject;
          try {
            const args = tc.function.arguments;
            inputObject = typeof args === "string" ? JSON.parse(args) : args;
          } catch (e) {
            logger.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
            inputObject = {
              raw_arguments: tc.function.arguments
            };
          }
          contentArray.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: inputObject
          });
          outputTokens += this.countTextTokens(tc.function.arguments);
        }
        stopReason = "tool_use";
      }
      return {
        id: messageId,
        type: "message",
        role: role,
        model: model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens
        },
        content: contentArray
      };
    }
  }
  async listModels() {
    const models = KIRO_MODELS.map(id => ({
      name: id
    }));
    return {
      models: models
    };
  }
  isTokenExpired() {
    try {
      if (!this.expiresAt) return true;
      const expirationTime = new Date(this.expiresAt);
      const currentTime = new Date;
      const bufferMs = 30 * 1e3;
      return expirationTime.getTime() <= currentTime.getTime() + bufferMs;
    } catch (error) {
      logger.error(`[Kiro] Error checking token expiry: ${error.message}`);
      return true;
    }
  }
  isExpiryDateNear() {
    try {
      const expirationTime = new Date(this.expiresAt);
      const nearMinutes = 30;
      const {message: message, isNearExpiry: isNearExpiry} = formatExpiryLog("Kiro", expirationTime.getTime(), nearMinutes);
      logger.info(message);
      return isNearExpiry;
    } catch (error) {
      logger.error(`[Kiro] Error checking expiry date: ${this.expiresAt}, Error: ${error.message}`);
      return false;
    }
  }
  triggerBackgroundRefresh() {
    logger.info("[Kiro] Background token refresh started...");
    this.initializeAuth(true).then(() => {
      logger.info("[Kiro] Background token refresh completed successfully");
    }).catch(error => {
      logger.error("[Kiro] Background token refresh failed:", error.message);
    });
  }
  countTokens(requestBody) {
    return KiroApiService.countTokens(requestBody);
  }
  async getUsageLimits() {
    if (!this.isInitialized) await this.initialize();
    const resourceType = "AGENTIC_REQUEST";
    let usageLimitsUrl = this.baseUrl;
    usageLimitsUrl = usageLimitsUrl.replace("generateAssistantResponse", "getUsageLimits");
    const params = new URLSearchParams({
      isEmailRequired: "true",
      origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
      resourceType: resourceType
    });
    if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && this.profileArn) {
      params.append("profileArn", this.profileArn);
    }
    const fullUrl = `${usageLimitsUrl}?${params.toString()}`;
    const machineId = generateMachineIdFromConfig({
      uuid: this.uuid,
      profileArn: this.profileArn,
      clientId: this.clientId
    });
    const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;
    const {osName: osName, nodeVersion: nodeVersion} = getSystemRuntimeInfo();
    const headers = {
      Authorization: `Bearer ${this.accessToken}`,
      "x-amz-user-agent": `aws-sdk-js/1.0.34 KiroIDE-${kiroVersion}-${machineId}`,
      "user-agent": `aws-sdk-js/1.0.34 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererstreaming#1.0.34 m/E KiroIDE-${kiroVersion}-${machineId}`,
      "amz-sdk-invocation-id": uuidv4(),
      "amz-sdk-request": "attempt=1; max=1",
      Connection: "close"
    };
    const axiosConfig = {
      method: "get",
      url: fullUrl,
      headers: headers
    };
    this._applySidecar(axiosConfig);
    try {
      const axiosInstance = this._createAxiosInstance();
      const response = await axiosInstance.request(axiosConfig);
      logger.info("[Kiro] Usage limits fetched successfully");
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      let errorMessage = error.message;
      if (error.response?.data) {
        const responseData = error.response.data;
        if (typeof responseData === "string") {
          errorMessage = responseData;
        } else if (responseData.message) {
          errorMessage = responseData.message;
        } else if (responseData.error) {
          errorMessage = typeof responseData.error === "string" ? responseData.error : responseData.error.message || JSON.stringify(responseData.error);
        }
      }
      const formattedError = status ? new Error(`API call failed: ${status} - ${errorMessage}`) : new Error(`API call failed: ${errorMessage}`);
      if (status === 401) {
        logger.info("[Kiro] Received 401 on getUsageLimits. Marking credential as unhealthy (no retry)...");
        this._markCredentialNeedRefresh("401 Unauthorized on usage query", formattedError);
        throw formattedError;
      }
      if (status === 403) {
        logger.info("[Kiro] Received 403 on getUsageLimits. Marking credential as unhealthy (no retry)...");
        const isSuspended = errorMessage && errorMessage.toLowerCase().includes("temporarily is suspended");
        if (isSuspended) {
          logger.info("[Kiro] Account temporarily suspended on usage query. Marking as unhealthy without UUID refresh...");
          this._markCredentialUnhealthy("403 Forbidden - Account temporarily suspended on usage query", formattedError);
        } else {
          this._markCredentialNeedRefresh("403 Forbidden on usage query", formattedError);
        }
        throw formattedError;
      }
      logger.error("[Kiro] Failed to fetch usage limits:", formattedError.message, error);
      throw formattedError;
    }
  }
}