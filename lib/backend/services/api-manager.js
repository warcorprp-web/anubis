import { handleModelListRequest, handleContentGenerationRequest, API_ACTIONS, ENDPOINT_TYPE } from "../utils/common.js";

import { getProviderPoolManager } from "./service-manager.js";

import logger from "../utils/logger.js";

export async function handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, promptLogFilename) {
  if (method === "GET") {
    if (path === "/v1/models") {
      await handleModelListRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_MODEL_LIST, currentConfig, providerPoolManager, currentConfig.uuid);
      return true;
    }
    if (path === "/v1beta/models") {
      await handleModelListRequest(req, res, apiService, ENDPOINT_TYPE.GEMINI_MODEL_LIST, currentConfig, providerPoolManager, currentConfig.uuid);
      return true;
    }
  }
  if (method === "POST") {
    if (path === "/v1/chat/completions") {
      await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_CHAT, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
      return true;
    }
    if (path === "/v1/responses") {
      await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.OPENAI_RESPONSES, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
      return true;
    }
    const geminiUrlPattern = new RegExp(`/v1beta/models/(.+?):(${API_ACTIONS.GENERATE_CONTENT}|${API_ACTIONS.STREAM_GENERATE_CONTENT})`);
    if (geminiUrlPattern.test(path)) {
      await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.GEMINI_CONTENT, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
      return true;
    }
    if (path === "/v1/messages") {
      await handleContentGenerationRequest(req, res, apiService, ENDPOINT_TYPE.CLAUDE_MESSAGE, currentConfig, promptLogFilename, providerPoolManager, currentConfig.uuid, path);
      return true;
    }
  }
  return false;
}

export function initializeAPIManagement(services) {
  const providerPoolManager = getProviderPoolManager();
  return async function heartbeatAndRefreshToken() {
    logger.info(`[Heartbeat] Server is running. Current time: ${(new Date).toLocaleString()}`, Object.keys(services));
    for (const providerKey in services) {
      const serviceAdapter = services[providerKey];
      try {
        if (serviceAdapter.config?.uuid && providerPoolManager) {
          providerPoolManager._enqueueRefresh(serviceAdapter.config.MODEL_PROVIDER, {
            config: serviceAdapter.config,
            uuid: serviceAdapter.config.uuid
          });
        } else {
          await serviceAdapter.refreshToken();
        }
      } catch (error) {
        logger.error(`[Token Refresh Error] Failed to refresh token for ${providerKey}: ${error.message}`);
      }
    }
  };
}

export function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", err => {
      reject(err);
    });
  });
}