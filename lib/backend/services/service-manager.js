import { getServiceAdapter, serviceInstances } from "../providers/adapter.js";

import logger from "../utils/logger.js";

import { ProviderPoolManager } from "../providers/provider-pool-manager.js";

import deepmerge from "deepmerge";

import * as fs from "fs";

import { promises as pfs } from "fs";

import * as path from "path";

import { PROVIDER_MAPPINGS, createProviderConfig, addToUsedPaths, isPathUsed, getFileName, formatSystemPath } from "../utils/provider-utils.js";

import { MODEL_PROVIDER } from "../utils/common.js";

let providerPoolManager = null;

export async function autoLinkProviderConfigs(config, options = {}) {
  if (!config.providerPools) {
    config.providerPools = {};
  }
  let totalNewProviders = 0;
  const allNewProviders = {};
  if (options.onlyCurrentCred && options.credPath) {
    const result = await linkSingleCredential(config, options.credPath);
    if (result) {
      totalNewProviders = 1;
      allNewProviders[result.displayName] = [ result.provider ];
    }
  } else {
    for (const mapping of PROVIDER_MAPPINGS) {
      const configsPath = path.join(process.cwd(), "configs", mapping.dirName);
      const {providerType: providerType, credPathKey: credPathKey, defaultCheckModel: defaultCheckModel, displayName: displayName, needsProjectId: needsProjectId} = mapping;
      if (!config.providerPools[providerType]) {
        config.providerPools[providerType] = [];
      }
      if (!fs.existsSync(configsPath)) {
        continue;
      }
      const linkedPaths = new Set;
      for (const provider of config.providerPools[providerType]) {
        if (provider[credPathKey]) {
          addToUsedPaths(linkedPaths, provider[credPathKey]);
        }
      }
      const newProviders = [];
      await scanProviderDirectory(configsPath, linkedPaths, newProviders, {
        credPathKey: credPathKey,
        defaultCheckModel: defaultCheckModel,
        needsProjectId: needsProjectId
      });
      if (newProviders.length > 0) {
        config.providerPools[providerType].push(...newProviders);
        totalNewProviders += newProviders.length;
        allNewProviders[displayName] = newProviders;
      }
    }
  }
  if (totalNewProviders > 0) {
    const filePath = config.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    try {
      await pfs.writeFile(filePath, JSON.stringify(config.providerPools, null, 2), "utf8");
      logger.info(`[Auto-Link] Added ${totalNewProviders} new config(s) to provider pools:`);
      for (const [displayName, providers] of Object.entries(allNewProviders)) {
        logger.info(`  ${displayName}: ${providers.length} config(s)`);
        providers.forEach(p => {
          const credKey = Object.keys(p).find(k => k.endsWith("_CREDS_FILE_PATH") || k.endsWith("_TOKEN_FILE_PATH"));
          if (credKey) {
            logger.info(`    - ${p[credKey]}`);
          }
        });
      }
    } catch (error) {
      logger.error(`[Auto-Link] Failed to save provider_pools.json: ${error.message}`);
    }
  } else {
    logger.info("[Auto-Link] No new configs to link");
  }
  if (providerPoolManager) {
    providerPoolManager.providerPools = config.providerPools;
    providerPoolManager.initializeProviderStatus();
  }
  return config.providerPools;
}

async function linkSingleCredential(config, credPath) {
  try {
    const absolutePath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
    const relativePath = path.relative(process.cwd(), absolutePath);
    if (!fs.existsSync(absolutePath)) {
      logger.warn(`[Auto-Link] Credential file not found: ${relativePath}`);
      return null;
    }
    const ext = path.extname(absolutePath).toLowerCase();
    if (ext !== ".json") {
      logger.warn(`[Auto-Link] Only JSON files are supported: ${relativePath}`);
      return null;
    }
    let matchedMapping = null;
    for (const mapping of PROVIDER_MAPPINGS) {
      const configsPath = path.join(process.cwd(), "configs", mapping.dirName);
      if (absolutePath.startsWith(configsPath)) {
        matchedMapping = mapping;
        break;
      }
    }
    if (!matchedMapping) {
      logger.warn(`[Auto-Link] Could not determine provider type for: ${relativePath}`);
      return null;
    }
    const {providerType: providerType, credPathKey: credPathKey, defaultCheckModel: defaultCheckModel, displayName: displayName, needsProjectId: needsProjectId} = matchedMapping;
    if (!config.providerPools[providerType]) {
      config.providerPools[providerType] = [];
    }
    const linkedPaths = new Set;
    for (const provider of config.providerPools[providerType]) {
      if (provider[credPathKey]) {
        addToUsedPaths(linkedPaths, provider[credPathKey]);
      }
    }
    const fileName = getFileName(absolutePath);
    const isLinked = isPathUsed(relativePath, fileName, linkedPaths);
    if (isLinked) {
      logger.info(`[Auto-Link] Credential already linked: ${relativePath}`);
      return null;
    }
    const newProvider = createProviderConfig({
      credPathKey: credPathKey,
      credPath: formatSystemPath(relativePath),
      defaultCheckModel: defaultCheckModel,
      needsProjectId: needsProjectId
    });
    config.providerPools[providerType].push(newProvider);
    logger.info(`[Auto-Link] Successfully linked credential: ${relativePath} to ${displayName}`);
    return {
      provider: newProvider,
      displayName: displayName,
      providerType: providerType
    };
  } catch (error) {
    logger.error(`[Auto-Link] Failed to link credential ${credPath}: ${error.message}`);
    return null;
  }
}

async function scanProviderDirectory(dirPath, linkedPaths, newProviders, options) {
  const {credPathKey: credPathKey, defaultCheckModel: defaultCheckModel, needsProjectId: needsProjectId} = options;
  try {
    const files = await pfs.readdir(dirPath, {
      withFileTypes: true
    });
    for (const file of files) {
      const fullPath = path.join(dirPath, file.name);
      if (file.isFile()) {
        const ext = path.extname(file.name).toLowerCase();
        if (ext === ".json") {
          const relativePath = path.relative(process.cwd(), fullPath);
          const fileName = getFileName(fullPath);
          const isLinked = isPathUsed(relativePath, fileName, linkedPaths);
          if (!isLinked) {
            const newProvider = createProviderConfig({
              credPathKey: credPathKey,
              credPath: formatSystemPath(relativePath),
              defaultCheckModel: defaultCheckModel,
              needsProjectId: needsProjectId
            });
            newProviders.push(newProvider);
          }
        }
      } else if (file.isDirectory()) {
        const relativePath = path.relative(process.cwd(), fullPath);
        const depth = relativePath.split(path.sep).length;
        if (depth < 5) {
          await scanProviderDirectory(fullPath, linkedPaths, newProviders, options);
        }
      }
    }
  } catch (error) {
    logger.warn(`[Auto-Link] Failed to scan directory ${dirPath}: ${error.message}`);
  }
}

export async function initApiService(config, isReady = false) {
  if (config.providerPools && Object.keys(config.providerPools).length > 0) {
    providerPoolManager = new ProviderPoolManager(config.providerPools, {
      globalConfig: config,
      maxErrorCount: config.MAX_ERROR_COUNT ?? 3,
      providerFallbackChain: config.providerFallbackChain || {}
    });
    logger.info("[Initialization] ProviderPoolManager initialized with configured pools.");
    if (isReady) {
      providerPoolManager.warmupNodes().catch(err => {
        logger.error(`[Initialization] Warmup failed: ${err.message}`);
      });
      providerPoolManager.checkAndRefreshExpiringNodes().catch(err => {
        logger.error(`[Initialization] Check and refresh expiring nodes failed: ${err.message}`);
      });
    }
  } else {
    logger.info("[Initialization] No provider pools configured. Using single provider mode.");
  }
  if (config.providerPools && Object.keys(config.providerPools).length > 0) {
    let totalInitialized = 0;
    let totalFailed = 0;
    for (const [providerType, providerConfigs] of Object.entries(config.providerPools)) {
      if (config.DEFAULT_MODEL_PROVIDERS && Array.isArray(config.DEFAULT_MODEL_PROVIDERS)) {
        if (!config.DEFAULT_MODEL_PROVIDERS.includes(providerType)) {
          logger.info(`[Initialization] Skipping provider type '${providerType}' (not in DEFAULT_MODEL_PROVIDERS).`);
          continue;
        }
      }
      if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
        continue;
      }
      logger.info(`[Initialization] Initializing ${providerConfigs.length} node(s) for provider '${providerType}'...`);
      for (const providerConfig of providerConfigs) {
        if (providerConfig.isDisabled) {
          continue;
        }
        try {
          const nodeConfig = deepmerge(config, {
            ...providerConfig,
            MODEL_PROVIDER: providerType
          });
          delete nodeConfig.providerPools;
          getServiceAdapter(nodeConfig);
          totalInitialized++;
          const identifier = providerConfig.customName || providerConfig.uuid || "unknown";
          logger.info(`  ✓ Initialized node: ${identifier}`);
        } catch (error) {
          totalFailed++;
          const identifier = providerConfig.customName || providerConfig.uuid || "unknown";
          logger.warn(`  ✗ Failed to initialize node ${identifier}: ${error.message}`);
        }
      }
    }
    logger.info(`[Initialization] Provider pool initialization complete: ${totalInitialized} succeeded, ${totalFailed} failed.`);
  } else {
    logger.info("[Initialization] No provider pools configured. Skipping node initialization.");
  }
  return serviceInstances;
}

async function _resolveEffectiveRouting(config, requestedModel) {
  let effectiveProvider = config.MODEL_PROVIDER;
  let actualModelName = requestedModel;
  if (requestedModel && requestedModel.includes(":")) {
    const [prefix, ...modelParts] = requestedModel.split(":");
    const modelSuffix = modelParts.join(":");
    if (providerPoolManager && (providerPoolManager.providerStatus[prefix] || config.providerPools?.[prefix])) {
      effectiveProvider = prefix;
      actualModelName = modelSuffix;
      logger.info(`[Routing] Prefix resolved: ${prefix}:${modelSuffix}`);
    }
  }
  if (effectiveProvider === MODEL_PROVIDER.AUTO && requestedModel) {
    throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${requestedModel}'`);
  }
  return {
    effectiveProvider: effectiveProvider,
    actualModelName: actualModelName
  };
}

export async function getApiService(config, requestedModel = null, options = {}) {
  const {effectiveProvider: effectiveProvider, actualModelName: actualModelName} = await _resolveEffectiveRouting(config, requestedModel);
  config.MODEL_PROVIDER = effectiveProvider;
  if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) return null;
  let serviceConfig = config;
  if (providerPoolManager && config.providerPools && config.providerPools[config.MODEL_PROVIDER]) {
    const selectedProviderConfig = await providerPoolManager.selectProvider(config.MODEL_PROVIDER, actualModelName, {
      ...options,
      skipUsageCount: true
    });
    if (selectedProviderConfig) {
      serviceConfig = deepmerge(config, selectedProviderConfig);
      delete serviceConfig.providerPools;
      config.uuid = serviceConfig.uuid;
      config.customName = serviceConfig.customName;
      const customNameDisplay = serviceConfig.customName ? ` (${serviceConfig.customName})` : "";
      logger.info(`[API Service] Using pooled configuration for ${config.MODEL_PROVIDER}: ${serviceConfig.uuid}${customNameDisplay}${actualModelName ? ` (model: ${actualModelName})` : ""}`);
    } else {
      const errorMsg = `[API Service] No healthy provider found in pool for ${config.MODEL_PROVIDER}${actualModelName ? ` supporting model: ${actualModelName}` : ""}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
    throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
  }
  return getServiceAdapter(serviceConfig);
}

export async function getApiServiceWithFallback(config, requestedModel = null, options = {}) {
  const {effectiveProvider: effectiveProvider, actualModelName: actualModelName} = await _resolveEffectiveRouting(config, requestedModel);
  config.MODEL_PROVIDER = effectiveProvider;
  if (effectiveProvider === MODEL_PROVIDER.AUTO && !actualModelName) {
    return {
      service: null,
      serviceConfig: config,
      actualProviderType: effectiveProvider,
      isFallback: false,
      uuid: null,
      actualModel: null
    };
  }
  let serviceConfig = config;
  let actualProviderType = config.MODEL_PROVIDER;
  let isFallback = false;
  let selectedUuid = null;
  let actualModel = actualModelName;
  if (providerPoolManager && config.providerPools && config.providerPools[config.MODEL_PROVIDER]) {
    const useAcquire = options.acquireSlot === true;
    let selectedResult;
    if (useAcquire) {
      selectedResult = await providerPoolManager.acquireSlotWithFallback(config.MODEL_PROVIDER, actualModelName, options);
    } else {
      selectedResult = await providerPoolManager.selectProviderWithFallback(config.MODEL_PROVIDER, actualModelName, {
        ...options,
        skipUsageCount: true
      });
    }
    if (selectedResult) {
      const {config: selectedProviderConfig, actualProviderType: selectedType, isFallback: fallbackUsed, actualModel: fallbackModel} = selectedResult;
      serviceConfig = deepmerge(config, selectedProviderConfig);
      delete serviceConfig.providerPools;
      actualProviderType = selectedType;
      isFallback = fallbackUsed;
      selectedUuid = selectedProviderConfig.uuid;
      actualModel = fallbackModel || actualModelName;
      if (isFallback) {
        serviceConfig.MODEL_PROVIDER = actualProviderType;
      }
    } else {
      const errorMsg = `[API Service] No healthy provider found in pool (including fallback) for ${config.MODEL_PROVIDER}${actualModelName ? ` supporting model: ${actualModelName}` : ""}`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  } else if (effectiveProvider === MODEL_PROVIDER.AUTO && actualModelName) {
    throw new Error(`[API Service] Auto-routing failed: Model name must include a provider prefix (e.g., 'provider:model'). Received: '${actualModelName}'`);
  }
  const service = getServiceAdapter(serviceConfig);
  return {
    service: service,
    serviceConfig: serviceConfig,
    actualProviderType: actualProviderType,
    isFallback: isFallback,
    uuid: selectedUuid,
    actualModel: actualModel
  };
}

export function getProviderPoolManager() {
  return providerPoolManager;
}

export function markProviderUnhealthy(provider, providerInfo) {
  if (providerPoolManager) {
    providerPoolManager.markProviderUnhealthy(provider, providerInfo);
  }
}

export async function getProviderStatus(config, options = {}) {
  let providerPools = {};
  const filePath = config.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
  try {
    if (providerPoolManager && providerPoolManager.providerPools) {
      providerPools = providerPoolManager.providerPools;
    } else if (filePath && fs.existsSync(filePath)) {
      const poolsData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      providerPools = poolsData;
    }
  } catch (error) {
    logger.warn("[API Service] Failed to load provider pools:", error.message);
  }
  const slimFields = [ "customName", "isHealthy", "lastErrorTime", "lastErrorMessage" ];
  const identifyFieldMap = {
    "openai-custom": "OPENAI_BASE_URL",
    "openaiResponses-custom": "OPENAI_BASE_URL",
    "gemini-cli-oauth": "GEMINI_OAUTH_CREDS_FILE_PATH",
    "claude-custom": "CLAUDE_BASE_URL",
    "claude-kiro-oauth": "KIRO_OAUTH_CREDS_FILE_PATH",
    "openai-qwen-oauth": "QWEN_OAUTH_CREDS_FILE_PATH",
    "gemini-antigravity": "ANTIGRAVITY_OAUTH_CREDS_FILE_PATH",
    "openai-iflow": "IFLOW_TOKEN_FILE_PATH",
    "forward-api": "FORWARD_BASE_URL",
    "grok-custom": "GROK_COOKIE_TOKEN"
  };
  let providerPoolsSlim = [];
  let unhealthyProvideIdentifyList = [];
  let count = 0;
  let unhealthyCount = 0;
  let unhealthyRatio = 0;
  const filterProvider = options && options.provider;
  const filterCustomName = options && options.customName;
  for (const key of Object.keys(providerPools)) {
    if (!Array.isArray(providerPools[key])) continue;
    if (filterProvider && key !== filterProvider) continue;
    const identifyField = identifyFieldMap[key] || null;
    const slimArr = providerPools[key].filter(item => {
      if (item.isDisabled) return false;
      if (filterCustomName && item.customName !== filterCustomName) return false;
      return true;
    }).map(item => {
      const slim = {};
      for (const f of slimFields) {
        slim[f] = item.hasOwnProperty(f) ? item[f] : null;
      }
      if (identifyField && item.hasOwnProperty(identifyField)) {
        let tmpCustomName = item.customName ? `${item.customName}` : "NoCustomName";
        let identifyStr = `${tmpCustomName}::${key}::${item[identifyField]}`;
        slim.identify = identifyStr;
      } else {
        slim.identify = null;
      }
      slim.provider = key;
      count++;
      if (slim.isHealthy === false) {
        unhealthyCount++;
        if (slim.identify) unhealthyProvideIdentifyList.push(slim.identify);
      }
      return slim;
    });
    providerPoolsSlim.push(...slimArr);
  }
  if (count > 0) {
    unhealthyRatio = Number((unhealthyCount / count).toFixed(2));
  }
  let unhealthySummeryMessage = unhealthyProvideIdentifyList.join("\n");
  if (unhealthySummeryMessage === "") unhealthySummeryMessage = null;
  return {
    providerPoolsSlim: providerPoolsSlim,
    unhealthySummeryMessage: unhealthySummeryMessage,
    count: count,
    unhealthyCount: unhealthyCount,
    unhealthyRatio: unhealthyRatio
  };
}