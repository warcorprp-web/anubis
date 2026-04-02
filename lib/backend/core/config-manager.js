import * as fs from "fs";

import { promises as pfs } from "fs";

import { INPUT_SYSTEM_PROMPT_FILE, MODEL_PROVIDER } from "../utils/common.js";

import logger from "../utils/logger.js";

export let CONFIG = {};

export let PROMPT_LOG_FILENAME = "";

const ALL_MODEL_PROVIDERS = Object.values(MODEL_PROVIDER);

function normalizeConfiguredProviders(config) {
  const fallbackProvider = MODEL_PROVIDER.GEMINI_CLI;
  const dedupedProviders = [];
  const addProvider = value => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    const matched = ALL_MODEL_PROVIDERS.find(provider => provider.toLowerCase() === trimmed.toLowerCase());
    if (!matched) {
      logger.warn(`[Config Warning] Unknown model provider '${trimmed}'. This entry will be ignored.`);
      return;
    }
    if (!dedupedProviders.includes(matched)) {
      dedupedProviders.push(matched);
    }
  };
  const rawValue = config.MODEL_PROVIDER;
  if (Array.isArray(rawValue)) {
    rawValue.forEach(entry => addProvider(typeof entry === "string" ? entry : String(entry)));
  } else if (typeof rawValue === "string") {
    rawValue.split(",").forEach(addProvider);
  } else if (rawValue != null) {
    addProvider(String(rawValue));
  }
  if (dedupedProviders.length === 0) {
    dedupedProviders.push(fallbackProvider);
  }
  config.DEFAULT_MODEL_PROVIDERS = dedupedProviders;
  config.MODEL_PROVIDER = dedupedProviders[0];
}

export async function initializeConfig(args = process.argv.slice(2), configFilePath = "configs/config.json") {
  const defaultConfig = {
    REQUIRED_API_KEY: "123456",
    SERVER_PORT: 3e3,
    HOST: "0.0.0.0",
    MODEL_PROVIDER: MODEL_PROVIDER.GEMINI_CLI,
    SYSTEM_PROMPT_FILE_PATH: INPUT_SYSTEM_PROMPT_FILE,
    SYSTEM_PROMPT_MODE: "append",
    PROXY_URL: null,
    PROXY_ENABLED_PROVIDERS: [],
    PROMPT_LOG_BASE_NAME: "prompt_log",
    PROMPT_LOG_MODE: "none",
    REQUEST_MAX_RETRIES: 3,
    REQUEST_BASE_DELAY: 1e3,
    CREDENTIAL_SWITCH_MAX_RETRIES: 5,
    CRON_NEAR_MINUTES: 15,
    CRON_REFRESH_TOKEN: false,
    LOGIN_EXPIRY: 3600,
    LOGIN_MAX_ATTEMPTS: 5,
    LOGIN_LOCKOUT_DURATION: 1800,
    LOGIN_MIN_INTERVAL: 5e3,
    PROVIDER_POOLS_FILE_PATH: null,
    MAX_ERROR_COUNT: 10,
    providerFallbackChain: {},
    LOG_ENABLED: true,
    LOG_OUTPUT_MODE: "all",
    LOG_LEVEL: "info",
    LOG_DIR: "logs",
    LOG_INCLUDE_REQUEST_ID: true,
    LOG_INCLUDE_TIMESTAMP: true,
    LOG_MAX_FILE_SIZE: 10485760,
    LOG_MAX_FILES: 10,
    TLS_SIDECAR_ENABLED: false,
    TLS_SIDECAR_ENABLED_PROVIDERS: [],
    TLS_SIDECAR_PORT: 9090,
    TLS_SIDECAR_BINARY_PATH: null,
    TLS_SIDECAR_PROXY_URL: null
  };
  let currentConfig = {
    ...defaultConfig
  };
  try {
    const configData = fs.readFileSync(configFilePath, "utf8");
    const loadedConfig = JSON.parse(configData);
    Object.assign(currentConfig, loadedConfig);
    logger.info("[Config] Loaded configuration from configs/config.json");
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.error("[Config Error] Failed to load configs/config.json:", error.message);
    } else {
      logger.info("[Config] configs/config.json not found, using default configuration.");
    }
  }
  const cliArgDefs = [ {
    flag: "--api-key",
    configKey: "REQUIRED_API_KEY",
    type: "string"
  }, {
    flag: "--log-prompts",
    configKey: "PROMPT_LOG_MODE",
    type: "enum",
    validValues: [ "console", "file" ]
  }, {
    flag: "--port",
    configKey: "SERVER_PORT",
    type: "int"
  }, {
    flag: "--model-provider",
    configKey: "MODEL_PROVIDER",
    type: "string"
  }, {
    flag: "--system-prompt-file",
    configKey: "SYSTEM_PROMPT_FILE_PATH",
    type: "string"
  }, {
    flag: "--system-prompt-mode",
    configKey: "SYSTEM_PROMPT_MODE",
    type: "enum",
    validValues: [ "overwrite", "append" ]
  }, {
    flag: "--host",
    configKey: "HOST",
    type: "string"
  }, {
    flag: "--prompt-log-base-name",
    configKey: "PROMPT_LOG_BASE_NAME",
    type: "string"
  }, {
    flag: "--cron-near-minutes",
    configKey: "CRON_NEAR_MINUTES",
    type: "int"
  }, {
    flag: "--cron-refresh-token",
    configKey: "CRON_REFRESH_TOKEN",
    type: "bool"
  }, {
    flag: "--provider-pools-file",
    configKey: "PROVIDER_POOLS_FILE_PATH",
    type: "string"
  }, {
    flag: "--max-error-count",
    configKey: "MAX_ERROR_COUNT",
    type: "int"
  }, {
    flag: "--login-max-attempts",
    configKey: "LOGIN_MAX_ATTEMPTS",
    type: "int"
  }, {
    flag: "--login-lockout-duration",
    configKey: "LOGIN_LOCKOUT_DURATION",
    type: "int"
  }, {
    flag: "--login-min-interval",
    configKey: "LOGIN_MIN_INTERVAL",
    type: "int"
  } ];
  const flagMap = new Map(cliArgDefs.map(def => [ def.flag, def ]));
  for (let i = 0; i < args.length; i++) {
    const def = flagMap.get(args[i]);
    if (!def) continue;
    if (i + 1 >= args.length) {
      logger.warn(`[Config Warning] ${def.flag} flag requires a value.`);
      continue;
    }
    const rawValue = args[++i];
    switch (def.type) {
     case "string":
      currentConfig[def.configKey] = rawValue;
      break;

     case "int":
      currentConfig[def.configKey] = parseInt(rawValue, 10);
      break;

     case "bool":
      currentConfig[def.configKey] = rawValue.toLowerCase() === "true";
      break;

     case "enum":
      if (def.validValues.includes(rawValue)) {
        currentConfig[def.configKey] = rawValue;
      } else {
        logger.warn(`[Config Warning] Invalid value for ${def.flag}. Expected one of: ${def.validValues.join(", ")}.`);
      }
      break;
    }
  }
  normalizeConfiguredProviders(currentConfig);
  if (!currentConfig.SYSTEM_PROMPT_FILE_PATH) {
    currentConfig.SYSTEM_PROMPT_FILE_PATH = INPUT_SYSTEM_PROMPT_FILE;
  }
  currentConfig.SYSTEM_PROMPT_CONTENT = await getSystemPromptFileContent(currentConfig.SYSTEM_PROMPT_FILE_PATH);
  if (!currentConfig.PROVIDER_POOLS_FILE_PATH) {
    currentConfig.PROVIDER_POOLS_FILE_PATH = "configs/provider_pools.json";
  }
  if (currentConfig.PROVIDER_POOLS_FILE_PATH) {
    try {
      const poolsData = await pfs.readFile(currentConfig.PROVIDER_POOLS_FILE_PATH, "utf8");
      currentConfig.providerPools = JSON.parse(poolsData);
      logger.info(`[Config] Loaded provider pools from ${currentConfig.PROVIDER_POOLS_FILE_PATH}`);
    } catch (error) {
      logger.error(`[Config Error] Failed to load provider pools from ${currentConfig.PROVIDER_POOLS_FILE_PATH}: ${error.message}`);
      currentConfig.providerPools = {};
    }
  } else {
    currentConfig.providerPools = {};
  }
  if (currentConfig.PROMPT_LOG_MODE === "file") {
    const now = new Date;
    const pad = num => String(num).padStart(2, "0");
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    PROMPT_LOG_FILENAME = `${currentConfig.PROMPT_LOG_BASE_NAME}-${timestamp}.log`;
  } else {
    PROMPT_LOG_FILENAME = "";
  }
  Object.assign(CONFIG, currentConfig);
  logger.initialize({
    enabled: CONFIG.LOG_ENABLED ?? true,
    outputMode: CONFIG.LOG_OUTPUT_MODE || "all",
    logLevel: CONFIG.LOG_LEVEL || "info",
    logDir: CONFIG.LOG_DIR || "logs",
    includeRequestId: CONFIG.LOG_INCLUDE_REQUEST_ID ?? true,
    includeTimestamp: CONFIG.LOG_INCLUDE_TIMESTAMP ?? true,
    maxFileSize: CONFIG.LOG_MAX_FILE_SIZE || 10485760,
    maxFiles: CONFIG.LOG_MAX_FILES || 10
  });
  logger.cleanupOldLogs();
  return CONFIG;
}

export async function getSystemPromptFileContent(filePath) {
  try {
    await pfs.access(filePath, pfs.constants.F_OK);
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.warn(`[System Prompt] Specified system prompt file not found: ${filePath}`);
    } else {
      logger.error(`[System Prompt] Error accessing system prompt file ${filePath}: ${error.message}`);
    }
    return null;
  }
  try {
    const content = await pfs.readFile(filePath, "utf8");
    if (!content.trim()) {
      return null;
    }
    logger.info(`[System Prompt] Loaded system prompt from ${filePath}`);
    return content;
  } catch (error) {
    logger.error(`[System Prompt] Error reading system prompt file ${filePath}: ${error.message}`);
    return null;
  }
}

export { ALL_MODEL_PROVIDERS };