import * as path from "path";

import logger from "./logger.js";

import { promises as fs } from "fs";

export const PROVIDER_MAPPINGS = [ {
  dirName: "kiro",
  patterns: [ "configs/kiro/", "/kiro/" ],
  providerType: "claude-kiro-oauth",
  credPathKey: "KIRO_OAUTH_CREDS_FILE_PATH",
  defaultCheckModel: "claude-haiku-4-5",
  displayName: "Claude Kiro OAuth",
  needsProjectId: false,
  urlKeys: [ "KIRO_BASE_URL", "KIRO_REFRESH_URL", "KIRO_REFRESH_IDC_URL" ]
}, {
  dirName: "gemini",
  patterns: [ "configs/gemini/", "/gemini/", "configs/gemini-cli/" ],
  providerType: "gemini-cli-oauth",
  credPathKey: "GEMINI_OAUTH_CREDS_FILE_PATH",
  defaultCheckModel: "gemini-2.5-flash",
  displayName: "Gemini CLI OAuth",
  needsProjectId: true,
  urlKeys: [ "GEMINI_BASE_URL" ]
}, {
  dirName: "qwen",
  patterns: [ "configs/qwen/", "/qwen/" ],
  providerType: "openai-qwen-oauth",
  credPathKey: "QWEN_OAUTH_CREDS_FILE_PATH",
  defaultCheckModel: "qwen3-coder-plus",
  displayName: "Qwen OAuth",
  needsProjectId: false,
  urlKeys: [ "QWEN_BASE_URL", "QWEN_OAUTH_BASE_URL" ]
}, {
  dirName: "antigravity",
  patterns: [ "configs/antigravity/", "/antigravity/" ],
  providerType: "gemini-antigravity",
  credPathKey: "ANTIGRAVITY_OAUTH_CREDS_FILE_PATH",
  defaultCheckModel: "gemini-2.5-computer-use-preview-10-2025",
  displayName: "Gemini Antigravity",
  needsProjectId: true,
  urlKeys: [ "ANTIGRAVITY_BASE_URL_DAILY", "ANTIGRAVITY_BASE_URL_AUTOPUSH" ]
}, {
  dirName: "iflow",
  patterns: [ "configs/iflow/", "/iflow/" ],
  providerType: "openai-iflow",
  credPathKey: "IFLOW_TOKEN_FILE_PATH",
  defaultCheckModel: "gpt-4o",
  displayName: "iFlow API",
  needsProjectId: false,
  urlKeys: [ "IFLOW_BASE_URL" ]
}, {
  dirName: "codex",
  patterns: [ "configs/codex/", "/codex/" ],
  providerType: "openai-codex-oauth",
  credPathKey: "CODEX_OAUTH_CREDS_FILE_PATH",
  defaultCheckModel: "gpt-5.2-codex",
  displayName: "OpenAI Codex OAuth",
  needsProjectId: false,
  urlKeys: [ "CODEX_BASE_URL" ]
}, {
  dirName: "grok",
  patterns: [ "configs/grok/", "/grok/" ],
  providerType: "grok-custom",
  credPathKey: "GROK_COOKIE_TOKEN",
  defaultCheckModel: "grok-3",
  displayName: "Grok Reverse",
  needsProjectId: false,
  urlKeys: [ "GROK_BASE_URL", "GROK_CF_CLEARANCE", "GROK_USER_AGENT" ]
} ];

export function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}

export function normalizePath(filePath) {
  if (!filePath) return filePath;
  const normalized = path.normalize(filePath);
  return normalized.replace(/\\/g, "/");
}

export function getFileName(filePath) {
  return path.basename(filePath);
}

export function formatSystemPath(relativePath) {
  if (!relativePath) return relativePath;
  const isWindows = process.platform === "win32";
  const separator = isWindows ? "\\" : "/";
  const systemPath = relativePath.replace(/[\/\\]/g, separator);
  return systemPath.startsWith("." + separator) ? systemPath : "." + separator + systemPath;
}

export function pathsEqual(path1, path2) {
  if (!path1 || !path2) return false;
  try {
    const normalized1 = normalizePath(path1);
    const normalized2 = normalizePath(path2);
    if (normalized1 === normalized2) {
      return true;
    }
    const clean1 = normalized1.replace(/^\.\//, "");
    const clean2 = normalized2.replace(/^\.\//, "");
    if (clean1 === clean2) {
      return true;
    }
    if (normalized1.endsWith("/" + clean2) || normalized2.endsWith("/" + clean1)) {
      return true;
    }
    return false;
  } catch (error) {
    logger.warn(`[Path Comparison] Error comparing paths: ${path1} vs ${path2}`, error.message);
    return false;
  }
}

export function isPathUsed(relativePath, fileName, usedPaths) {
  if (!relativePath) return false;
  const normalizedRelativePath = normalizePath(relativePath);
  const cleanRelativePath = normalizedRelativePath.replace(/^\.\//, "");
  const relativeFileName = getFileName(normalizedRelativePath);
  for (const usedPath of usedPaths) {
    if (!usedPath) continue;
    if (pathsEqual(relativePath, usedPath) || pathsEqual(relativePath, "./" + usedPath)) {
      return true;
    }
    if (pathsEqual(normalizedRelativePath, usedPath) || pathsEqual(normalizedRelativePath, "./" + usedPath)) {
      return true;
    }
    if (pathsEqual(cleanRelativePath, usedPath) || pathsEqual(cleanRelativePath, "./" + usedPath)) {
      return true;
    }
    const usedFileName = getFileName(usedPath);
    if (usedFileName === fileName || usedFileName === relativeFileName) {
      const usedDir = path.dirname(usedPath);
      const relativeDir = path.dirname(normalizedRelativePath);
      if (pathsEqual(usedDir, relativeDir) || pathsEqual(usedDir, cleanRelativePath.replace(/\/[^\/]+$/, "")) || pathsEqual(relativeDir.replace(/^\.\//, ""), usedDir.replace(/^\.\//, ""))) {
        return true;
      }
    }
    try {
      const resolvedUsedPath = path.resolve(usedPath);
      const resolvedRelativePath = path.resolve(relativePath);
      if (resolvedUsedPath === resolvedRelativePath) {
        return true;
      }
    } catch (error) {}
  }
  return false;
}

export function detectProviderFromPath(normalizedPath) {
  for (const mapping of PROVIDER_MAPPINGS) {
    for (const pattern of mapping.patterns) {
      if (normalizedPath.includes(pattern)) {
        return {
          providerType: mapping.providerType,
          credPathKey: mapping.credPathKey,
          defaultCheckModel: mapping.defaultCheckModel,
          displayName: mapping.displayName,
          needsProjectId: mapping.needsProjectId
        };
      }
    }
  }
  return null;
}

export function getProviderMappingByDirName(dirName) {
  return PROVIDER_MAPPINGS.find(m => m.dirName === dirName) || null;
}

export async function isValidOAuthCredentials(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const jsonData = JSON.parse(content);
    if (jsonData.access_token || jsonData.refresh_token || jsonData.accessToken || jsonData.refreshToken || jsonData.client_id || jsonData.client_secret || jsonData.token || jsonData.credentials) {
      return true;
    }
    if (jsonData.installed || jsonData.web) {
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

export function createProviderConfig(options) {
  const {credPathKey: credPathKey, credPath: credPath, defaultCheckModel: defaultCheckModel, needsProjectId: needsProjectId, urlKeys: urlKeys} = options;
  const newProvider = {
    [credPathKey]: credPath,
    uuid: generateUUID(),
    checkModelName: defaultCheckModel,
    checkHealth: false,
    isHealthy: true,
    isDisabled: false,
    lastUsed: null,
    usageCount: 0,
    errorCount: 0,
    lastErrorTime: null,
    lastHealthCheckTime: null,
    lastHealthCheckModel: null,
    lastErrorMessage: null
  };
  if (needsProjectId) {
    newProvider.PROJECT_ID = "";
  }
  if (urlKeys && Array.isArray(urlKeys)) {
    urlKeys.forEach(key => {
      newProvider[key] = "";
    });
  }
  return newProvider;
}

export function addToUsedPaths(usedPaths, filePath) {
  if (!filePath) return;
  const normalizedPath = filePath.replace(/\\/g, "/");
  usedPaths.add(filePath);
  usedPaths.add(normalizedPath);
  if (normalizedPath.startsWith("./")) {
    usedPaths.add(normalizedPath.slice(2));
  } else {
    usedPaths.add("./" + normalizedPath);
  }
}

export function isPathLinked(relativePath, linkedPaths) {
  return linkedPaths.has(relativePath) || linkedPaths.has("./" + relativePath) || linkedPaths.has(relativePath.replace(/^\.\//, ""));
}