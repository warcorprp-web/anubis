import { existsSync, readFileSync, writeFileSync } from "fs";

import logger from "../utils/logger.js";

import { getRequestBody } from "../utils/common.js";

import { getAllProviderModels, getProviderModels } from "../providers/provider-models.js";

import { generateUUID, createProviderConfig, formatSystemPath, detectProviderFromPath, addToUsedPaths, isPathUsed, pathsEqual } from "../utils/provider-utils.js";

import { broadcastEvent } from "./event-broadcast.js";

import { getRegisteredProviders } from "../providers/adapter.js";

export async function handleGetProviders(req, res, currentConfig, providerPoolManager) {
  let providerPools = {};
  const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
  try {
    if (providerPoolManager && providerPoolManager.providerPools) {
      providerPools = providerPoolManager.providerPools;
    } else if (filePath && existsSync(filePath)) {
      const poolsData = JSON.parse(readFileSync(filePath, "utf-8"));
      providerPools = poolsData;
    }
  } catch (error) {
    logger.warn("[UI API] Failed to load provider pools:", error.message);
  }
  res.writeHead(200, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(providerPools));
  return true;
}

export async function handleGetSupportedProviders(req, res) {
  const supportedProviders = getRegisteredProviders();
  res.writeHead(200, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(supportedProviders));
  return true;
}

export async function handleGetProviderType(req, res, currentConfig, providerPoolManager, providerType) {
  let providerPools = {};
  const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
  try {
    if (providerPoolManager && providerPoolManager.providerPools) {
      providerPools = providerPoolManager.providerPools;
    } else if (filePath && existsSync(filePath)) {
      const poolsData = JSON.parse(readFileSync(filePath, "utf-8"));
      providerPools = poolsData;
    }
  } catch (error) {
    logger.warn("[UI API] Failed to load provider pools:", error.message);
  }
  const providers = providerPools[providerType] || [];
  res.writeHead(200, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify({
    providerType: providerType,
    providers: providers,
    totalCount: providers.length,
    healthyCount: providers.filter(p => p.isHealthy).length
  }));
  return true;
}

export async function handleGetProviderModels(req, res) {
  const allModels = getAllProviderModels();
  res.writeHead(200, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify(allModels));
  return true;
}

export async function handleGetProviderTypeModels(req, res, providerType) {
  const models = getProviderModels(providerType);
  res.writeHead(200, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify({
    providerType: providerType,
    models: models
  }));
  return true;
}

export async function handleAddProvider(req, res, currentConfig, providerPoolManager) {
  try {
    const body = await getRequestBody(req);
    const {providerType: providerType, providerConfig: providerConfig} = body;
    if (!providerType || !providerConfig) {
      res.writeHead(400, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "providerType and providerConfig are required"
        }
      }));
      return true;
    }
    if (!providerConfig.uuid) {
      providerConfig.uuid = generateUUID();
    }
    providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
    providerConfig.lastUsed = providerConfig.lastUsed || null;
    providerConfig.usageCount = providerConfig.usageCount || 0;
    providerConfig.errorCount = providerConfig.errorCount || 0;
    providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "provider_pools.json";
    let providerPools = {};
    if (existsSync(filePath)) {
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        providerPools = JSON.parse(fileContent);
      } catch (readError) {
        logger.warn("[UI API] Failed to read existing provider pools:", readError.message);
      }
    }
    if (!providerPools[providerType]) {
      providerPools[providerType] = [];
    }
    providerPools[providerType].push(providerConfig);
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), "utf-8");
    logger.info(`[UI API] Added new provider to ${providerType}: ${providerConfig.uuid}`);
    if (providerPoolManager) {
      providerPoolManager.providerPools = providerPools;
      providerPoolManager.initializeProviderStatus();
    }
    broadcastEvent("config_update", {
      action: "add",
      filePath: filePath,
      providerType: providerType,
      providerConfig: providerConfig,
      timestamp: (new Date).toISOString()
    });
    broadcastEvent("provider_update", {
      action: "add",
      providerType: providerType,
      providerConfig: providerConfig,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: "Provider added successfully",
      provider: providerConfig,
      providerType: providerType
    }));
    return true;
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: error.message
      }
    }));
    return true;
  }
}

export async function handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
  try {
    const body = await getRequestBody(req);
    const {providerConfig: providerConfig} = body;
    if (!providerConfig) {
      res.writeHead(400, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "providerConfig is required"
        }
      }));
      return true;
    }
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    let providerPools = {};
    if (existsSync(filePath)) {
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        providerPools = JSON.parse(fileContent);
      } catch (readError) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: "Provider pools file not found"
          }
        }));
        return true;
      }
    }
    const providers = providerPools[providerType] || [];
    const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
    if (providerIndex === -1) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Provider not found"
        }
      }));
      return true;
    }
    const existingProvider = providers[providerIndex];
    const updatedProvider = {
      ...existingProvider,
      ...providerConfig,
      uuid: providerUuid,
      lastUsed: existingProvider.lastUsed,
      usageCount: existingProvider.usageCount,
      errorCount: existingProvider.errorCount,
      lastErrorTime: existingProvider.lastErrorTime
    };
    providerPools[providerType][providerIndex] = updatedProvider;
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), "utf-8");
    logger.info(`[UI API] Updated provider ${providerUuid} in ${providerType}`);
    if (providerPoolManager) {
      providerPoolManager.providerPools = providerPools;
      providerPoolManager.initializeProviderStatus();
    }
    broadcastEvent("config_update", {
      action: "update",
      filePath: filePath,
      providerType: providerType,
      providerConfig: updatedProvider,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: "Provider updated successfully",
      provider: updatedProvider
    }));
    return true;
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: error.message
      }
    }));
    return true;
  }
}

export async function handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
  try {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    let providerPools = {};
    if (existsSync(filePath)) {
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        providerPools = JSON.parse(fileContent);
      } catch (readError) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: "Provider pools file not found"
          }
        }));
        return true;
      }
    }
    const providers = providerPools[providerType] || [];
    const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
    if (providerIndex === -1) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Provider not found"
        }
      }));
      return true;
    }
    const deletedProvider = providers[providerIndex];
    providers.splice(providerIndex, 1);
    if (providers.length === 0) {
      delete providerPools[providerType];
    }
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), "utf-8");
    logger.info(`[UI API] Deleted provider ${providerUuid} from ${providerType}`);
    if (providerPoolManager) {
      providerPoolManager.providerPools = providerPools;
      providerPoolManager.initializeProviderStatus();
    }
    broadcastEvent("config_update", {
      action: "delete",
      filePath: filePath,
      providerType: providerType,
      providerConfig: deletedProvider,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: "Provider deleted successfully",
      deletedProvider: deletedProvider
    }));
    return true;
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: error.message
      }
    }));
    return true;
  }
}

export async function handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action) {
  try {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    let providerPools = {};
    if (existsSync(filePath)) {
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        providerPools = JSON.parse(fileContent);
      } catch (readError) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: "Provider pools file not found"
          }
        }));
        return true;
      }
    }
    const providers = providerPools[providerType] || [];
    const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
    if (providerIndex === -1) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Provider not found"
        }
      }));
      return true;
    }
    const provider = providers[providerIndex];
    provider.isDisabled = action === "disable";
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), "utf-8");
    logger.info(`[UI API] ${action === "disable" ? "Disabled" : "Enabled"} provider ${providerUuid} in ${providerType}`);
    if (providerPoolManager) {
      providerPoolManager.providerPools = providerPools;
      if (action === "disable") {
        providerPoolManager.disableProvider(providerType, provider);
      } else {
        providerPoolManager.enableProvider(providerType, provider);
      }
    }
    broadcastEvent("config_update", {
      action: action,
      filePath: filePath,
      providerType: providerType,
      providerConfig: provider,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: `Provider ${action}d successfully`,
      provider: provider
    }));
    return true;
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: error.message
      }
    }));
    return true;
  }
}

export async function handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType) {
  try {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    let providerPools = {};
    if (existsSync(filePath)) {
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        providerPools = JSON.parse(fileContent);
      } catch (readError) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: "Provider pools file not found"
          }
        }));
        return true;
      }
    }
    const providers = providerPools[providerType] || [];
    if (providers.length === 0) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "No providers found for this type"
        }
      }));
      return true;
    }
    let resetCount = 0;
    providers.forEach(provider => {
      if (!provider.isHealthy) {
        resetCount++;
      }
      provider.isHealthy = true;
      provider.errorCount = 0;
      provider.refreshCount = 0;
      provider.needsRefresh = false;
      provider.lastErrorTime = null;
    });
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), "utf-8");
    logger.info(`[UI API] Reset health status for ${resetCount} providers in ${providerType}`);
    if (providerPoolManager) {
      providerPoolManager.providerPools = providerPools;
      providerPoolManager.initializeProviderStatus();
    }
    broadcastEvent("config_update", {
      action: "reset_health",
      filePath: filePath,
      providerType: providerType,
      resetCount: resetCount,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: `Successfully reset health status for ${resetCount} providers`,
      resetCount: resetCount,
      totalCount: providers.length
    }));
    return true;
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: error.message
      }
    }));
    return true;
  }
}

export async function handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType) {
  try {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    let providerPools = {};
    if (existsSync(filePath)) {
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        providerPools = JSON.parse(fileContent);
      } catch (readError) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: "Provider pools file not found"
          }
        }));
        return true;
      }
    }
    const providers = providerPools[providerType] || [];
    if (providers.length === 0) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "No providers found for this type"
        }
      }));
      return true;
    }
    const unhealthyProviders = providers.filter(p => !p.isHealthy);
    const healthyProviders = providers.filter(p => p.isHealthy);
    if (unhealthyProviders.length === 0) {
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: true,
        message: "No unhealthy providers to delete",
        deletedCount: 0,
        remainingCount: providers.length
      }));
      return true;
    }
    if (healthyProviders.length === 0) {
      delete providerPools[providerType];
    } else {
      providerPools[providerType] = healthyProviders;
    }
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), "utf-8");
    logger.info(`[UI API] Deleted ${unhealthyProviders.length} unhealthy providers from ${providerType}`);
    if (providerPoolManager) {
      providerPoolManager.providerPools = providerPools;
      providerPoolManager.initializeProviderStatus();
    }
    broadcastEvent("config_update", {
      action: "delete_unhealthy",
      filePath: filePath,
      providerType: providerType,
      deletedCount: unhealthyProviders.length,
      deletedProviders: unhealthyProviders.map(p => ({
        uuid: p.uuid,
        customName: p.customName
      })),
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: `Successfully deleted ${unhealthyProviders.length} unhealthy providers`,
      deletedCount: unhealthyProviders.length,
      remainingCount: healthyProviders.length,
      deletedProviders: unhealthyProviders.map(p => ({
        uuid: p.uuid,
        customName: p.customName
      }))
    }));
    return true;
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: error.message
      }
    }));
    return true;
  }
}

export async function handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType) {
  try {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    let providerPools = {};
    if (existsSync(filePath)) {
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        providerPools = JSON.parse(fileContent);
      } catch (readError) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: "Provider pools file not found"
          }
        }));
        return true;
      }
    }
    const providers = providerPools[providerType] || [];
    if (providers.length === 0) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "No providers found for this type"
        }
      }));
      return true;
    }
    const refreshedProviders = [];
    for (const provider of providers) {
      if (!provider.isHealthy) {
        const oldUuid = provider.uuid;
        const newUuid = generateUUID();
        provider.uuid = newUuid;
        refreshedProviders.push({
          oldUuid: oldUuid,
          newUuid: newUuid,
          customName: provider.customName
        });
      }
    }
    if (refreshedProviders.length === 0) {
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: true,
        message: "No unhealthy providers to refresh",
        refreshedCount: 0,
        totalCount: providers.length
      }));
      return true;
    }
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), "utf-8");
    logger.info(`[UI API] Refreshed UUIDs for ${refreshedProviders.length} unhealthy providers in ${providerType}`);
    if (providerPoolManager) {
      providerPoolManager.providerPools = providerPools;
      providerPoolManager.initializeProviderStatus();
    }
    broadcastEvent("config_update", {
      action: "refresh_unhealthy_uuids",
      filePath: filePath,
      providerType: providerType,
      refreshedCount: refreshedProviders.length,
      refreshedProviders: refreshedProviders,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: `Successfully refreshed UUIDs for ${refreshedProviders.length} unhealthy providers`,
      refreshedCount: refreshedProviders.length,
      totalCount: providers.length,
      refreshedProviders: refreshedProviders
    }));
    return true;
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: error.message
      }
    }));
    return true;
  }
}

export async function handleHealthCheck(req, res, currentConfig, providerPoolManager, providerType) {
  try {
    if (!providerPoolManager) {
      res.writeHead(400, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Provider pool manager not initialized"
        }
      }));
      return true;
    }
    const providers = providerPoolManager.providerStatus[providerType] || [];
    if (providers.length === 0) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "No providers found for this type"
        }
      }));
      return true;
    }
    const unhealthyProviders = providers.filter(ps => !ps.config.isHealthy);
    if (unhealthyProviders.length === 0) {
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: true,
        message: "No unhealthy providers to check",
        successCount: 0,
        failCount: 0,
        totalCount: providers.length,
        results: []
      }));
      return true;
    }
    logger.info(`[UI API] Starting health check for ${unhealthyProviders.length} unhealthy providers in ${providerType} (total: ${providers.length})`);
    const results = [];
    for (const providerStatus of unhealthyProviders) {
      const providerConfig = providerStatus.config;
      if (providerConfig.isDisabled) {
        logger.info(`[UI API] Skipping health check for disabled provider: ${providerConfig.uuid}`);
        continue;
      }
      try {
        const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig, true);
        if (healthResult === null) {
          results.push({
            uuid: providerConfig.uuid,
            success: null,
            message: "Health check not supported for this provider type"
          });
          continue;
        }
        if (healthResult.success) {
          providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
          results.push({
            uuid: providerConfig.uuid,
            success: true,
            modelName: healthResult.modelName,
            message: "Healthy"
          });
        } else {
          const errorMessage = healthResult.errorMessage || "Check failed";
          const isAuthError = /\b(401|403)\b/.test(errorMessage) || /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
          if (isAuthError) {
            providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
            logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
          } else {
            providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
          }
          providerStatus.config.lastHealthCheckTime = (new Date).toISOString();
          if (healthResult.modelName) {
            providerStatus.config.lastHealthCheckModel = healthResult.modelName;
          }
          results.push({
            uuid: providerConfig.uuid,
            success: false,
            modelName: healthResult.modelName,
            message: errorMessage,
            isAuthError: isAuthError
          });
        }
      } catch (error) {
        const errorMessage = error.message || "Unknown error";
        const isAuthError = /\b(401|403)\b/.test(errorMessage) || /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
        if (isAuthError) {
          providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
          logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
        } else {
          providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
        }
        results.push({
          uuid: providerConfig.uuid,
          success: false,
          message: errorMessage,
          isAuthError: isAuthError
        });
      }
    }
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    const providerPools = {};
    for (const pType in providerPoolManager.providerStatus) {
      providerPools[pType] = providerPoolManager.providerStatus[pType].map(ps => ps.config);
    }
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), "utf-8");
    const successCount = results.filter(r => r.success === true).length;
    const failCount = results.filter(r => r.success === false).length;
    logger.info(`[UI API] Health check completed for ${providerType}: ${successCount} recovered, ${failCount} still unhealthy (checked ${unhealthyProviders.length} unhealthy nodes)`);
    broadcastEvent("config_update", {
      action: "health_check",
      filePath: filePath,
      providerType: providerType,
      results: results,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: `Health check completed: ${successCount} healthy, ${failCount} unhealthy`,
      successCount: successCount,
      failCount: failCount,
      totalCount: providers.length,
      results: results
    }));
    return true;
  } catch (error) {
    logger.error("[UI API] Health check error:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: error.message
      }
    }));
    return true;
  }
}

export async function handleQuickLinkProvider(req, res, currentConfig, providerPoolManager) {
  try {
    const body = await getRequestBody(req);
    const {filePath: filePath, filePaths: filePaths} = body;
    const pathsToLink = filePaths || (filePath ? [ filePath ] : []);
    if (!pathsToLink || pathsToLink.length === 0) {
      res.writeHead(400, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "filePath or filePaths is required"
        }
      }));
      return true;
    }
    const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    let providerPools = {};
    if (existsSync(poolsFilePath)) {
      try {
        const fileContent = readFileSync(poolsFilePath, "utf-8");
        providerPools = JSON.parse(fileContent);
      } catch (readError) {
        logger.warn("[UI API] Failed to read existing provider pools:", readError.message);
      }
    }
    const results = [];
    const linkedProviders = [];
    for (const currentFilePath of pathsToLink) {
      const normalizedPath = currentFilePath.replace(/\\/g, "/").toLowerCase();
      const providerMapping = detectProviderFromPath(normalizedPath);
      if (!providerMapping) {
        results.push({
          filePath: currentFilePath,
          success: false,
          error: "Unable to identify provider type for config file"
        });
        continue;
      }
      const {providerType: providerType, credPathKey: credPathKey, defaultCheckModel: defaultCheckModel, displayName: displayName} = providerMapping;
      if (!providerPools[providerType]) {
        providerPools[providerType] = [];
      }
      const normalizedForComparison = currentFilePath.replace(/\\/g, "/");
      const isAlreadyLinked = providerPools[providerType].some(p => {
        const existingPath = p[credPathKey];
        if (!existingPath) return false;
        const normalizedExistingPath = existingPath.replace(/\\/g, "/");
        return normalizedExistingPath === normalizedForComparison || normalizedExistingPath === "./" + normalizedForComparison || "./" + normalizedExistingPath === normalizedForComparison;
      });
      if (isAlreadyLinked) {
        results.push({
          filePath: currentFilePath,
          success: false,
          error: "This config file is already linked",
          providerType: providerType
        });
        continue;
      }
      const newProvider = createProviderConfig({
        credPathKey: credPathKey,
        credPath: formatSystemPath(currentFilePath),
        defaultCheckModel: defaultCheckModel,
        needsProjectId: providerMapping.needsProjectId
      });
      providerPools[providerType].push(newProvider);
      linkedProviders.push({
        providerType: providerType,
        provider: newProvider
      });
      results.push({
        filePath: currentFilePath,
        success: true,
        providerType: providerType,
        displayName: displayName,
        provider: newProvider
      });
      logger.info(`[UI API] Quick linked config: ${currentFilePath} -> ${providerType}`);
    }
    const successCount = results.filter(r => r.success).length;
    if (successCount > 0) {
      writeFileSync(poolsFilePath, JSON.stringify(providerPools, null, 2), "utf-8");
      if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        providerPoolManager.initializeProviderStatus();
      }
      broadcastEvent("config_update", {
        action: "quick_link_batch",
        filePath: poolsFilePath,
        results: results,
        timestamp: (new Date).toISOString()
      });
      for (const {providerType: providerType, provider: provider} of linkedProviders) {
        broadcastEvent("provider_update", {
          action: "add",
          providerType: providerType,
          providerConfig: provider,
          timestamp: (new Date).toISOString()
        });
      }
    }
    const failCount = results.filter(r => !r.success).length;
    const message = successCount > 0 ? `Successfully linked ${successCount} config file(s)${failCount > 0 ? `, ${failCount} failed` : ""}` : `Failed to link all ${failCount} config file(s)`;
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: successCount > 0,
      message: message,
      successCount: successCount,
      failCount: failCount,
      results: results
    }));
    return true;
  } catch (error) {
    logger.error("[UI API] Quick link failed:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Link failed: " + error.message
      }
    }));
    return true;
  }
}

export async function handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
  try {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
    let providerPools = {};
    if (existsSync(filePath)) {
      try {
        const fileContent = readFileSync(filePath, "utf-8");
        providerPools = JSON.parse(fileContent);
      } catch (readError) {
        res.writeHead(404, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: "Provider pools file not found"
          }
        }));
        return true;
      }
    }
    const providers = providerPools[providerType] || [];
    const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
    if (providerIndex === -1) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Provider not found"
        }
      }));
      return true;
    }
    const oldUuid = providerUuid;
    const newUuid = generateUUID();
    providerPools[providerType][providerIndex].uuid = newUuid;
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), "utf-8");
    logger.info(`[UI API] Refreshed UUID for provider in ${providerType}: ${oldUuid} -> ${newUuid}`);
    if (providerPoolManager) {
      providerPoolManager.providerPools = providerPools;
      providerPoolManager.initializeProviderStatus();
    }
    broadcastEvent("config_update", {
      action: "refresh_uuid",
      filePath: filePath,
      providerType: providerType,
      oldUuid: oldUuid,
      newUuid: newUuid,
      timestamp: (new Date).toISOString()
    });
    res.writeHead(200, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: true,
      message: "UUID refreshed successfully",
      oldUuid: oldUuid,
      newUuid: newUuid,
      provider: providerPools[providerType][providerIndex]
    }));
    return true;
  } catch (error) {
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: error.message
      }
    }));
    return true;
  }
}