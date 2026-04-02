import { existsSync } from "fs";

import logger from "../utils/logger.js";

import { promises as fs } from "fs";

import path from "path";

import { addToUsedPaths, isPathUsed, pathsEqual } from "../utils/provider-utils.js";

export async function scanConfigFiles(currentConfig, providerPoolManager) {
  const configFiles = [];
  const configsPath = path.join(process.cwd(), "configs");
  if (!existsSync(configsPath)) {
    return configFiles;
  }
  const usedPaths = new Set;
  addToUsedPaths(usedPaths, currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH);
  addToUsedPaths(usedPaths, currentConfig.KIRO_OAUTH_CREDS_FILE_PATH);
  addToUsedPaths(usedPaths, currentConfig.QWEN_OAUTH_CREDS_FILE_PATH);
  addToUsedPaths(usedPaths, currentConfig.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH);
  addToUsedPaths(usedPaths, currentConfig.IFLOW_TOKEN_FILE_PATH);
  addToUsedPaths(usedPaths, currentConfig.CODEX_OAUTH_CREDS_FILE_PATH);
  let providerPools = currentConfig.providerPools;
  if (providerPoolManager && providerPoolManager.providerPools) {
    providerPools = providerPoolManager.providerPools;
  }
  if (providerPools) {
    for (const [providerType, providers] of Object.entries(providerPools)) {
      for (const provider of providers) {
        addToUsedPaths(usedPaths, provider.GEMINI_OAUTH_CREDS_FILE_PATH);
        addToUsedPaths(usedPaths, provider.KIRO_OAUTH_CREDS_FILE_PATH);
        addToUsedPaths(usedPaths, provider.QWEN_OAUTH_CREDS_FILE_PATH);
        addToUsedPaths(usedPaths, provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH);
        addToUsedPaths(usedPaths, provider.IFLOW_TOKEN_FILE_PATH);
        addToUsedPaths(usedPaths, provider.CODEX_OAUTH_CREDS_FILE_PATH);
      }
    }
  }
  try {
    const configsFiles = await scanOAuthDirectory(configsPath, usedPaths, currentConfig);
    configFiles.push(...configsFiles);
  } catch (error) {
    logger.warn(`[Config Scanner] Failed to scan configs directory:`, error.message);
  }
  return configFiles;
}

async function analyzeOAuthFile(filePath, usedPaths, currentConfig) {
  try {
    const stats = await fs.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const filename = path.basename(filePath);
    const relativePath = path.relative(process.cwd(), filePath);
    let content = "";
    let type = "oauth";
    let isValid = true;
    let errorMessage = "";
    let oauthProvider = "unknown";
    let usageInfo = getFileUsageInfo(relativePath, filename, usedPaths, currentConfig);
    const normalizedPath = relativePath.replace(/\\/g, "/").toLowerCase();
    if (normalizedPath.includes("/kiro/")) oauthProvider = "kiro"; else if (normalizedPath.includes("/gemini/")) oauthProvider = "gemini"; else if (normalizedPath.includes("/qwen/")) oauthProvider = "qwen"; else if (normalizedPath.includes("/antigravity/")) oauthProvider = "antigravity"; else if (normalizedPath.includes("/codex/")) oauthProvider = "codex"; else if (normalizedPath.includes("/iflow/")) oauthProvider = "iflow";
    try {
      content = await fs.readFile(filePath, "utf8");
      const lowerFilename = filename.toLowerCase();
      if (lowerFilename === "provider_pools.json" || lowerFilename === "provider-pools.json") {
        type = "provider-pool";
      } else if (lowerFilename.includes("system_prompt") || lowerFilename.includes("system-prompt")) {
        type = "system-prompt";
      } else if (lowerFilename === "plugins.json") {
        type = "plugins";
      } else if (lowerFilename === "usage-cache.json") {
        type = "usage";
      } else if (lowerFilename === "config.json") {
        type = "config";
      } else if (lowerFilename.includes("potluck-keys")) {
        type = "api-key";
      } else if (lowerFilename.includes("potluck-data")) {
        type = "database";
      } else if (lowerFilename === "token-store.json") {
        type = "oauth";
      }
      if (ext === ".json") {
        try {
          const jsonData = JSON.parse(content);
          if (type === "oauth") {
            if (jsonData.providerPools || jsonData.provider_pools) {
              type = "provider-pool";
            } else if (jsonData.apiKey || jsonData.api_key) {
              type = "api-key";
            }
          }
          if (jsonData.client_id || jsonData.client_secret) {
            if (oauthProvider === "unknown") oauthProvider = "oauth2";
          } else if (jsonData.access_token || jsonData.refresh_token) {
            if (oauthProvider === "unknown") oauthProvider = "token_based";
          } else if (jsonData.credentials) {
            if (oauthProvider === "unknown") oauthProvider = "service_account";
          } else if (jsonData.apiKey || jsonData.api_key) {
            if (oauthProvider === "unknown") oauthProvider = "api_key";
          }
          if (jsonData.base_url || jsonData.endpoint) {
            const baseUrl = (jsonData.base_url || jsonData.endpoint).toLowerCase();
            if (baseUrl.includes("openai.com")) {
              oauthProvider = "openai";
            } else if (baseUrl.includes("anthropic.com")) {
              oauthProvider = "claude";
            } else if (baseUrl.includes("googleapis.com")) {
              oauthProvider = "gemini";
            }
          }
        } catch (jsonErr) {
          isValid = false;
          errorMessage = `JSON Parse Error: ${jsonErr.message}`;
        }
      } else {
        if (ext === ".key" || ext === ".pem") {
          if (content.includes("-----BEGIN") && content.includes("PRIVATE KEY-----")) {
            oauthProvider = "private_key";
          }
        } else if (ext === ".txt") {
          if (content.includes("api_key") || content.includes("apikey")) {
            if (type === "oauth") type = "api-key";
            if (oauthProvider === "unknown") oauthProvider = "api_key";
          }
        } else if (ext === ".oauth" || ext === ".creds") {
          if (oauthProvider === "unknown") oauthProvider = "oauth_credentials";
        }
      }
    } catch (readError) {
      isValid = false;
      errorMessage = `Unable to read file: ${readError.message}`;
    }
    return {
      name: filename,
      path: relativePath,
      size: stats.size,
      type: type,
      provider: oauthProvider,
      extension: ext,
      modified: stats.mtime.toISOString(),
      isValid: isValid,
      errorMessage: errorMessage,
      isUsed: isPathUsed(relativePath, filename, usedPaths),
      usageInfo: usageInfo,
      preview: content.substring(0, 100) + (content.length > 100 ? "..." : "")
    };
  } catch (error) {
    logger.warn(`[OAuth Analyzer] Failed to analyze file ${filePath}:`, error.message);
    return null;
  }
}

function getFileUsageInfo(relativePath, fileName, usedPaths, currentConfig) {
  const usageInfo = {
    isUsed: false,
    usageType: null,
    usageDetails: []
  };
  const isUsed = isPathUsed(relativePath, fileName, usedPaths);
  if (!isUsed) {
    return usageInfo;
  }
  usageInfo.isUsed = true;
  if (currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH && (pathsEqual(relativePath, currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH) || pathsEqual(relativePath, currentConfig.GEMINI_OAUTH_CREDS_FILE_PATH.replace(/\\/g, "/")))) {
    usageInfo.usageType = "main_config";
    usageInfo.usageDetails.push({
      type: "Main Config",
      location: "Gemini OAuth credentials file path",
      configKey: "GEMINI_OAUTH_CREDS_FILE_PATH"
    });
  }
  if (currentConfig.KIRO_OAUTH_CREDS_FILE_PATH && (pathsEqual(relativePath, currentConfig.KIRO_OAUTH_CREDS_FILE_PATH) || pathsEqual(relativePath, currentConfig.KIRO_OAUTH_CREDS_FILE_PATH.replace(/\\/g, "/")))) {
    usageInfo.usageType = "main_config";
    usageInfo.usageDetails.push({
      type: "Main Config",
      location: "Kiro OAuth credentials file path",
      configKey: "KIRO_OAUTH_CREDS_FILE_PATH"
    });
  }
  if (currentConfig.QWEN_OAUTH_CREDS_FILE_PATH && (pathsEqual(relativePath, currentConfig.QWEN_OAUTH_CREDS_FILE_PATH) || pathsEqual(relativePath, currentConfig.QWEN_OAUTH_CREDS_FILE_PATH.replace(/\\/g, "/")))) {
    usageInfo.usageType = "main_config";
    usageInfo.usageDetails.push({
      type: "Main Config",
      location: "Qwen OAuth credentials file path",
      configKey: "QWEN_OAUTH_CREDS_FILE_PATH"
    });
  }
  if (currentConfig.IFLOW_TOKEN_FILE_PATH && (pathsEqual(relativePath, currentConfig.IFLOW_TOKEN_FILE_PATH) || pathsEqual(relativePath, currentConfig.IFLOW_TOKEN_FILE_PATH.replace(/\\/g, "/")))) {
    usageInfo.usageType = "main_config";
    usageInfo.usageDetails.push({
      type: "Main Config",
      location: "iFlow Token file path",
      configKey: "IFLOW_TOKEN_FILE_PATH"
    });
  }
  if (currentConfig.CODEX_OAUTH_CREDS_FILE_PATH && (pathsEqual(relativePath, currentConfig.CODEX_OAUTH_CREDS_FILE_PATH) || pathsEqual(relativePath, currentConfig.CODEX_OAUTH_CREDS_FILE_PATH.replace(/\\/g, "/")))) {
    usageInfo.usageType = "main_config";
    usageInfo.usageDetails.push({
      type: "Main Config",
      location: "Codex OAuth credentials file path",
      configKey: "CODEX_OAUTH_CREDS_FILE_PATH"
    });
  }
  if (currentConfig.providerPools) {
    const allProviders = Object.entries(currentConfig.providerPools).flatMap(([providerType, providers]) => providers.map((provider, index) => ({
      provider: provider,
      providerType: providerType,
      index: index
    })));
    for (const {provider: provider, providerType: providerType, index: index} of allProviders) {
      const providerUsages = [];
      if (provider.GEMINI_OAUTH_CREDS_FILE_PATH && (pathsEqual(relativePath, provider.GEMINI_OAUTH_CREDS_FILE_PATH) || pathsEqual(relativePath, provider.GEMINI_OAUTH_CREDS_FILE_PATH.replace(/\\/g, "/")))) {
        providerUsages.push({
          type: "Provider Pool",
          location: `Gemini OAuth credentials (node ${index + 1})`,
          providerType: providerType,
          providerIndex: index,
          nodeName: provider.customName,
          uuid: provider.uuid,
          isHealthy: provider.isHealthy !== false,
          isDisabled: provider.isDisabled === true,
          configKey: "GEMINI_OAUTH_CREDS_FILE_PATH"
        });
      }
      if (provider.KIRO_OAUTH_CREDS_FILE_PATH && (pathsEqual(relativePath, provider.KIRO_OAUTH_CREDS_FILE_PATH) || pathsEqual(relativePath, provider.KIRO_OAUTH_CREDS_FILE_PATH.replace(/\\/g, "/")))) {
        providerUsages.push({
          type: "Provider Pool",
          location: `Kiro OAuth credentials (node ${index + 1})`,
          providerType: providerType,
          providerIndex: index,
          nodeName: provider.customName,
          uuid: provider.uuid,
          isHealthy: provider.isHealthy !== false,
          isDisabled: provider.isDisabled === true,
          configKey: "KIRO_OAUTH_CREDS_FILE_PATH"
        });
      }
      if (provider.QWEN_OAUTH_CREDS_FILE_PATH && (pathsEqual(relativePath, provider.QWEN_OAUTH_CREDS_FILE_PATH) || pathsEqual(relativePath, provider.QWEN_OAUTH_CREDS_FILE_PATH.replace(/\\/g, "/")))) {
        providerUsages.push({
          type: "Provider Pool",
          location: `Qwen OAuth credentials (node ${index + 1})`,
          providerType: providerType,
          providerIndex: index,
          nodeName: provider.customName,
          uuid: provider.uuid,
          isHealthy: provider.isHealthy !== false,
          isDisabled: provider.isDisabled === true,
          configKey: "QWEN_OAUTH_CREDS_FILE_PATH"
        });
      }
      if (provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH && (pathsEqual(relativePath, provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH) || pathsEqual(relativePath, provider.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH.replace(/\\/g, "/")))) {
        providerUsages.push({
          type: "Provider Pool",
          location: `Antigravity OAuth credentials (node ${index + 1})`,
          providerType: providerType,
          providerIndex: index,
          nodeName: provider.customName,
          uuid: provider.uuid,
          isHealthy: provider.isHealthy !== false,
          isDisabled: provider.isDisabled === true,
          configKey: "ANTIGRAVITY_OAUTH_CREDS_FILE_PATH"
        });
      }
      if (provider.IFLOW_TOKEN_FILE_PATH && (pathsEqual(relativePath, provider.IFLOW_TOKEN_FILE_PATH) || pathsEqual(relativePath, provider.IFLOW_TOKEN_FILE_PATH.replace(/\\/g, "/")))) {
        providerUsages.push({
          type: "Provider Pool",
          location: `iFlow Token (node ${index + 1})`,
          providerType: providerType,
          providerIndex: index,
          nodeName: provider.customName,
          uuid: provider.uuid,
          isHealthy: provider.isHealthy !== false,
          isDisabled: provider.isDisabled === true,
          configKey: "IFLOW_TOKEN_FILE_PATH"
        });
      }
      if (provider.CODEX_OAUTH_CREDS_FILE_PATH && (pathsEqual(relativePath, provider.CODEX_OAUTH_CREDS_FILE_PATH) || pathsEqual(relativePath, provider.CODEX_OAUTH_CREDS_FILE_PATH.replace(/\\/g, "/")))) {
        providerUsages.push({
          type: "Provider Pool",
          location: `Codex OAuth credentials (node ${index + 1})`,
          providerType: providerType,
          providerIndex: index,
          nodeName: provider.customName,
          uuid: provider.uuid,
          isHealthy: provider.isHealthy !== false,
          isDisabled: provider.isDisabled === true,
          configKey: "CODEX_OAUTH_CREDS_FILE_PATH"
        });
      }
      if (providerUsages.length > 0) {
        usageInfo.usageType = "provider_pool";
        usageInfo.usageDetails.push(...providerUsages);
      }
    }
  }
  if (usageInfo.usageDetails.length > 1) {
    usageInfo.usageType = "multiple";
  }
  return usageInfo;
}

async function scanOAuthDirectory(dirPath, usedPaths, currentConfig) {
  const oauthFiles = [];
  try {
    const files = await fs.readdir(dirPath, {
      withFileTypes: true
    });
    for (const file of files) {
      const fullPath = path.join(dirPath, file.name);
      if (file.isFile()) {
        const ext = path.extname(file.name).toLowerCase();
        if ([ ".json", ".oauth", ".creds", ".key", ".pem", ".txt" ].includes(ext)) {
          const fileInfo = await analyzeOAuthFile(fullPath, usedPaths, currentConfig);
          if (fileInfo) {
            oauthFiles.push(fileInfo);
          }
        }
      } else if (file.isDirectory()) {
        const relativePath = path.relative(process.cwd(), fullPath);
        if (relativePath.split(path.sep).length < 4) {
          const subFiles = await scanOAuthDirectory(fullPath, usedPaths, currentConfig);
          oauthFiles.push(...subFiles);
        }
      }
    }
  } catch (error) {
    logger.warn(`[OAuth Scanner] Failed to scan directory ${dirPath}:`, error.message);
  }
  return oauthFiles;
}