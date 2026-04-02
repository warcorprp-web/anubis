import { createKey, listKeys, getKey, deleteKey, updateKeyLimit, resetKeyUsage, toggleKey, updateKeyName, validateKey, incrementUsage, getStats, KEY_PREFIX, setConfigGetter } from "./key-manager.js";

import { extractPotluckKey, isPotluckRequest, sendPotluckError } from "./middleware.js";

import logger from "../../utils/logger.js";

import { handlePotluckApiRoutes, handlePotluckUserApiRoutes } from "./api-routes.js";

const apiPotluckPlugin = {
  name: "api-potluck",
  version: "1.0.2",
  description: 'API 大锅饭 - Key 管理和用量统计插件<br>管理端：<a href="potluck.html" target="_blank">potluck.html</a><br>用户端：<a href="potluck-user.html" target="_blank">potluck-user.html</a>',
  type: "auth",
  _priority: 10,
  async init(config) {
    logger.info("[API Potluck Plugin] Initializing...");
  },
  async destroy() {
    logger.info("[API Potluck Plugin] Destroying...");
  },
  staticPaths: [ "potluck.html", "potluck-user.html" ],
  routes: [ {
    method: "*",
    path: "/api/potluckuser",
    handler: handlePotluckUserApiRoutes
  }, {
    method: "*",
    path: "/api/potluck",
    handler: handlePotluckApiRoutes
  } ],
  async authenticate(req, res, requestUrl, config) {
    const apiKey = extractPotluckKey(req, requestUrl);
    if (!apiKey) {
      return {
        handled: false,
        authorized: null
      };
    }
    const validation = await validateKey(apiKey);
    if (!validation.valid) {
      const errorMessages = {
        invalid_format: "Invalid API key format",
        not_found: "API key not found",
        disabled: "API key has been disabled",
        quota_exceeded: "Quota exceeded for this API key"
      };
      const statusCodes = {
        invalid_format: 401,
        not_found: 401,
        disabled: 403,
        quota_exceeded: 429
      };
      const error = {
        statusCode: statusCodes[validation.reason] || 401,
        message: errorMessages[validation.reason] || "Authentication failed",
        code: validation.reason,
        keyData: validation.keyData
      };
      sendPotluckError(res, error);
      return {
        handled: true,
        authorized: false,
        error: error
      };
    }
    logger.info(`[API Potluck Plugin] Authorized with key: ${apiKey.substring(0, 12)}...`);
    return {
      handled: false,
      authorized: true,
      data: {
        potluckApiKey: apiKey,
        potluckKeyData: validation.keyData
      }
    };
  },
  hooks: {
    async onContentGenerated(hookContext) {
      if (hookContext.potluckApiKey) {
        try {
          await incrementUsage(hookContext.potluckApiKey, hookContext.toProvider, hookContext.model);
        } catch (e) {
          logger.error("[API Potluck Plugin] Failed to record usage:", e.message);
        }
      }
    }
  },
  exports: {
    createKey: createKey,
    listKeys: listKeys,
    getKey: getKey,
    deleteKey: deleteKey,
    updateKeyLimit: updateKeyLimit,
    resetKeyUsage: resetKeyUsage,
    toggleKey: toggleKey,
    updateKeyName: updateKeyName,
    validateKey: validateKey,
    incrementUsage: incrementUsage,
    getStats: getStats,
    KEY_PREFIX: KEY_PREFIX,
    extractPotluckKey: extractPotluckKey,
    isPotluckRequest: isPotluckRequest
  }
};

export default apiPotluckPlugin;

export { createKey, listKeys, getKey, deleteKey, updateKeyLimit, resetKeyUsage, toggleKey, updateKeyName, validateKey, incrementUsage, getStats, KEY_PREFIX, extractPotluckKey, isPotluckRequest };