import { CONFIG } from "../core/config-adapter";

import logger from "../utils/logger.js";

import { serviceInstances, getServiceAdapter } from "../providers/adapter.js";

import { formatKiroUsage, formatGeminiUsage, formatAntigravityUsage, formatCodexUsage, formatGrokUsage } from "../services/usage-service.js";

import { readUsageCache, writeUsageCache, readProviderUsageCache, updateProviderUsageCache } from "./usage-cache.js";

import { PROVIDER_MAPPINGS } from "../utils/provider-utils.js";

import path from "path";

const supportedProviders = [ "claude-kiro-oauth", "gemini-cli-oauth", "gemini-antigravity", "openai-codex-oauth", "grok-custom" ];

async function getAllProvidersUsage(currentConfig, providerPoolManager) {
  const results = {
    timestamp: (new Date).toISOString(),
    providers: {}
  };
  const usagePromises = supportedProviders.map(async providerType => {
    try {
      const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
      return {
        providerType: providerType,
        data: providerUsage,
        success: true
      };
    } catch (error) {
      return {
        providerType: providerType,
        data: {
          error: error.message,
          instances: []
        },
        success: false
      };
    }
  });
  const usageResults = await Promise.all(usagePromises);
  for (const result of usageResults) {
    results.providers[result.providerType] = result.data;
  }
  return results;
}

async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager) {
  const result = {
    providerType: providerType,
    instances: [],
    totalCount: 0,
    successCount: 0,
    errorCount: 0
  };
  let providers = [];
  if (providerPoolManager && providerPoolManager.providerPools && providerPoolManager.providerPools[providerType]) {
    providers = providerPoolManager.providerPools[providerType];
  } else if (currentConfig.providerPools && currentConfig.providerPools[providerType]) {
    providers = currentConfig.providerPools[providerType];
  }
  result.totalCount = providers.length;
  for (const provider of providers) {
    const providerKey = providerType + (provider.uuid || "");
    let adapter = serviceInstances[providerKey];
    const instanceResult = {
      uuid: provider.uuid || "unknown",
      name: getProviderDisplayName(provider, providerType),
      configFilePath: getProviderConfigFilePath(provider, providerType),
      isHealthy: provider.isHealthy !== false,
      isDisabled: provider.isDisabled === true,
      success: false,
      usage: null,
      error: null
    };
    if (provider.isDisabled) {
      instanceResult.error = "Provider is disabled";
      result.errorCount++;
    } else if (!adapter) {
      try {
        logger.info(`[Usage API] Auto-initializing service adapter for ${providerType}: ${provider.uuid}`);
        const serviceConfig = {
          ...CONFIG,
          ...provider,
          MODEL_PROVIDER: providerType
        };
        adapter = getServiceAdapter(serviceConfig);
      } catch (initError) {
        logger.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
        instanceResult.error = `Service instance initialization failed: ${initError.message}`;
        result.errorCount++;
      }
    }
    if (adapter && !instanceResult.error) {
      try {
        const usage = await getAdapterUsage(adapter, providerType);
        instanceResult.success = true;
        instanceResult.usage = usage;
        result.successCount++;
      } catch (error) {
        instanceResult.error = error.message;
        result.errorCount++;
      }
    }
    result.instances.push(instanceResult);
  }
  return result;
}

async function getAdapterUsage(adapter, providerType) {
  if (providerType === "claude-kiro-oauth") {
    if (typeof adapter.getUsageLimits === "function") {
      const rawUsage = await adapter.getUsageLimits();
      return formatKiroUsage(rawUsage);
    } else if (adapter.kiroApiService && typeof adapter.kiroApiService.getUsageLimits === "function") {
      const rawUsage = await adapter.kiroApiService.getUsageLimits();
      return formatKiroUsage(rawUsage);
    }
    throw new Error("This adapter does not support usage query");
  }
  if (providerType === "gemini-cli-oauth") {
    if (typeof adapter.getUsageLimits === "function") {
      const rawUsage = await adapter.getUsageLimits();
      return formatGeminiUsage(rawUsage);
    } else if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === "function") {
      const rawUsage = await adapter.geminiApiService.getUsageLimits();
      return formatGeminiUsage(rawUsage);
    }
    throw new Error("This adapter does not support usage query");
  }
  if (providerType === "gemini-antigravity") {
    if (typeof adapter.getUsageLimits === "function") {
      const rawUsage = await adapter.getUsageLimits();
      return formatAntigravityUsage(rawUsage);
    } else if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === "function") {
      const rawUsage = await adapter.antigravityApiService.getUsageLimits();
      return formatAntigravityUsage(rawUsage);
    }
    throw new Error("This adapter does not support usage query");
  }
  if (providerType === "openai-codex-oauth") {
    if (typeof adapter.getUsageLimits === "function") {
      const rawUsage = await adapter.getUsageLimits();
      return formatCodexUsage(rawUsage);
    } else if (adapter.codexApiService && typeof adapter.codexApiService.getUsageLimits === "function") {
      const rawUsage = await adapter.codexApiService.getUsageLimits();
      return formatCodexUsage(rawUsage);
    }
    throw new Error("This adapter does not support usage query");
  }
  if (providerType === "grok-custom") {
    if (typeof adapter.getUsageLimits === "function") {
      const rawUsage = await adapter.getUsageLimits();
      return formatGrokUsage(rawUsage);
    }
    throw new Error("This adapter does not support usage query");
  }
  throw new Error(`Unsupported provider type: ${providerType}`);
}

function getProviderDisplayName(provider, providerType) {
  if (provider.customName) {
    return provider.customName;
  }
  if (provider.uuid) {
    return provider.uuid;
  }
  const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === providerType);
  const credPathKey = mapping ? mapping.credPathKey : null;
  if (credPathKey && provider[credPathKey]) {
    const filePath = provider[credPathKey];
    const fileName = path.basename(filePath);
    const dirName = path.basename(path.dirname(filePath));
    return `${dirName}/${fileName}`;
  }
  return "Unnamed";
}

function getProviderConfigFilePath(provider, providerType) {
  const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === providerType);
  const credPathKey = mapping ? mapping.credPathKey : null;
  return credPathKey && provider[credPathKey] ? provider[credPathKey] : null;
}

export async function handleGetSupportedProviders(req, res) {
  try {
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(supportedProviders));
    return true;
  } catch (error) {
    logger.error("[Usage API] Failed to get supported providers:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to get supported providers: " + error.message
      }
    }));
    return true;
  }
}

export async function handleGetUsage(req, res, currentConfig, providerPoolManager) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const refresh = url.searchParams.get("refresh") === "true";
    let usageResults;
    if (!refresh) {
      const cachedData = await readUsageCache();
      if (cachedData) {
        logger.info("[Usage API] Returning cached usage data");
        usageResults = {
          ...cachedData,
          fromCache: true
        };
      }
    }
    if (!usageResults) {
      logger.info("[Usage API] Fetching fresh usage data");
      usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager);
      await writeUsageCache(usageResults);
    }
    const finalResults = {
      ...usageResults,
      serverTime: (new Date).toISOString()
    };
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(finalResults));
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to get usage:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to get usage info: " + error.message
      }
    }));
    return true;
  }
}

export async function handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const refresh = url.searchParams.get("refresh") === "true";
    let usageResults;
    if (!refresh) {
      const cachedData = await readProviderUsageCache(providerType);
      if (cachedData) {
        logger.info(`[Usage API] Returning cached usage data for ${providerType}`);
        usageResults = {
          ...cachedData,
          fromCache: true
        };
      }
    }
    if (!usageResults) {
      logger.info(`[Usage API] Fetching fresh usage data for ${providerType}`);
      usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
      await updateProviderUsageCache(providerType, usageResults);
    }
    const finalResults = {
      ...usageResults,
      serverTime: (new Date).toISOString()
    };
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify(finalResults));
    return true;
  } catch (error) {
    logger.error(`[UI API] Failed to get usage for ${providerType}:`, error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: `Failed to get usage info for ${providerType}: ` + error.message
      }
    }));
    return true;
  }
}