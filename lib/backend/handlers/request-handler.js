import deepmerge from "deepmerge";

import logger from "../utils/logger.js";

import { handleError, getClientIp } from "../utils/common.js";

import { handleUIApiRequests, serveStaticFiles } from "../services/ui-manager.js";

import { handleAPIRequests } from "../services/api-manager.js";

import { getApiService, getProviderStatus } from "../services/service-manager.js";

import { getProviderPoolManager } from "../services/service-manager.js";

import { MODEL_PROVIDER } from "../utils/common.js";

import { getRegisteredProviders } from "../providers/adapter.js";

import { countTokensAnthropic } from "../utils/token-utils.js";

import { PROMPT_LOG_FILENAME } from "../core/config-manager.js";

import { getPluginManager } from "../core/plugin-manager.js";

import { randomUUID } from "crypto";

import { handleGrokAssetsProxy } from "../utils/grok-assets-proxy.js";

function generateRequestId() {
  return randomUUID().slice(0, 8);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error("Invalid JSON in request body"));
      }
    });
    req.on("error", reject);
  });
}

export function createRequestHandler(config, providerPoolManager) {
  return async function requestHandler(req, res) {
    const clientIp = getClientIp(req);
    const requestId = `${clientIp}:${generateRequestId()}`;
    return logger.runWithContext(requestId, async () => {
      const currentConfig = deepmerge({}, config);
      const protocol = req.socket.encrypted || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      const host = req.headers.host;
      currentConfig.requestBaseUrl = `${protocol}://${host}`;
      const requestUrl = new URL(req.url, `http://${req.headers.host}`);
      let path = requestUrl.pathname;
      const method = req.method;
      try {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, PATCH");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-goog-api-key, Model-Provider, X-Requested-With, Accept, Origin");
        res.setHeader("Access-Control-Max-Age", "86400");
        if (method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        const pluginManager = getPluginManager();
        const isPluginStatic = pluginManager.isPluginStaticPath(path);
        if (path.startsWith("/static/") || path === "/" || path === "/favicon.ico" || path === "/index.html" || path.startsWith("/app/") || path.startsWith("/components/") || path === "/login.html" || path.endsWith(".ttf") || path.endsWith(".woff") || path.endsWith(".woff2") || isPluginStatic) {
          const served = await serveStaticFiles(path, res);
          if (served) return;
        }
        const pluginRouteHandled = await pluginManager.executeRoutes(method, path, req, res);
        if (pluginRouteHandled) return;
        const uiHandled = await handleUIApiRequests(method, path, req, res, currentConfig, providerPoolManager);
        if (uiHandled) return;
        logger.info(`[Server] Received request: ${req.method} http://${req.headers.host}${req.url}`);
        if (method === "GET" && path === "/health") {
          res.writeHead(200, {
            "Content-Type": "application/json"
          });
          res.end(JSON.stringify({
            status: "healthy",
            timestamp: (new Date).toISOString(),
            provider: currentConfig.MODEL_PROVIDER
          }));
          return true;
        }
        if (method === "GET" && path === "/api/grok/assets") {
          await handleGrokAssetsProxy(req, res, currentConfig, providerPoolManager);
          return true;
        }
        if (method === "GET" && path === "/provider_health") {
          try {
            const provider = requestUrl.searchParams.get("provider");
            const customName = requestUrl.searchParams.get("customName");
            let unhealthRatioThreshold = requestUrl.searchParams.get("unhealthRatioThreshold");
            unhealthRatioThreshold = unhealthRatioThreshold === null ? 1e-4 : parseFloat(unhealthRatioThreshold);
            let provideStatus = await getProviderStatus(currentConfig, {
              provider: provider,
              customName: customName
            });
            let summaryHealth = true;
            if (!isNaN(unhealthRatioThreshold)) {
              summaryHealth = provideStatus.unhealthyRatio <= unhealthRatioThreshold;
            }
            res.writeHead(200, {
              "Content-Type": "application/json"
            });
            res.end(JSON.stringify({
              timestamp: (new Date).toISOString(),
              items: provideStatus.providerPoolsSlim,
              count: provideStatus.count,
              unhealthyCount: provideStatus.unhealthyCount,
              unhealthyRatio: provideStatus.unhealthyRatio,
              unhealthySummeryMessage: provideStatus.unhealthySummeryMessage,
              summaryHealth: summaryHealth
            }));
            return true;
          } catch (error) {
            logger.info(`[Server] req provider_health error: ${error.message}`);
            handleError(res, {
              statusCode: 500,
              message: `Failed to get providers health: ${error.message}`
            }, currentConfig.MODEL_PROVIDER);
            return;
          }
        }
        const modelProviderHeader = req.headers["model-provider"];
        if (modelProviderHeader) {
          const registeredProviders = getRegisteredProviders();
          if (registeredProviders.includes(modelProviderHeader)) {
            currentConfig.MODEL_PROVIDER = modelProviderHeader;
            logger.info(`[Config] MODEL_PROVIDER overridden by header to: ${currentConfig.MODEL_PROVIDER}`);
          } else {
            logger.warn(`[Config] Provider ${modelProviderHeader} in header is not available.`);
            res.writeHead(400, {
              "Content-Type": "application/json"
            });
            res.end(JSON.stringify({
              error: {
                message: `Provider ${modelProviderHeader} is not available.`
              }
            }));
            return;
          }
        }
        const pathSegments = path.split("/").filter(segment => segment.length > 0);
        if (pathSegments.length > 0) {
          const firstSegment = pathSegments[0];
          const registeredProviders = getRegisteredProviders();
          const isValidProvider = registeredProviders.includes(firstSegment);
          const isAutoMode = firstSegment === MODEL_PROVIDER.AUTO;
          if (firstSegment && (isValidProvider || isAutoMode)) {
            currentConfig.MODEL_PROVIDER = firstSegment;
            logger.info(`[Config] MODEL_PROVIDER overridden by path segment to: ${currentConfig.MODEL_PROVIDER}`);
            pathSegments.shift();
            path = "/" + pathSegments.join("/");
            requestUrl.pathname = path;
          } else if (firstSegment && Object.values(MODEL_PROVIDER).includes(firstSegment)) {
            logger.warn(`[Config] Provider ${firstSegment} is recognized but no adapter is registered.`);
            res.writeHead(400, {
              "Content-Type": "application/json"
            });
            res.end(JSON.stringify({
              error: {
                message: `Provider ${firstSegment} is not available.`
              }
            }));
            return;
          } else if (firstSegment && !isValidProvider) {
            logger.info(`[Config] Ignoring invalid MODEL_PROVIDER in path segment: ${firstSegment}`);
          }
        }
        const authResult = await pluginManager.executeAuth(req, res, requestUrl, currentConfig);
        if (authResult.handled) {
          return;
        }
        if (!authResult.authorized) {
          res.writeHead(401, {
            "Content-Type": "application/json"
          });
          res.end(JSON.stringify({
            error: {
              message: "Unauthorized: API key is invalid or missing."
            }
          }));
          return;
        }
        const middlewareResult = await pluginManager.executeMiddleware(req, res, requestUrl, currentConfig);
        if (middlewareResult.handled) {
          return;
        }
        if (path.includes("/count_tokens") && method === "POST") {
          try {
            const body = await parseRequestBody(req);
            logger.info(`[Server] Handling count_tokens request for model: ${body.model}`);
            try {
              const result = countTokensAnthropic(body);
              res.writeHead(200, {
                "Content-Type": "application/json"
              });
              res.end(JSON.stringify(result));
            } catch (tokenError) {
              logger.warn(`[Server] Common countTokens failed, falling back: ${tokenError.message}`);
              res.writeHead(200, {
                "Content-Type": "application/json"
              });
              res.end(JSON.stringify({
                input_tokens: 0
              }));
            }
            return true;
          } catch (error) {
            logger.error(`[Server] count_tokens error: ${error.message}`);
            handleError(res, {
              statusCode: 500,
              message: `Failed to count tokens: ${error.message}`
            }, currentConfig.MODEL_PROVIDER);
            return;
          }
        }
        let apiService;
        try {
          const apiHandled = await handleAPIRequests(method, path, req, res, currentConfig, apiService, providerPoolManager, PROMPT_LOG_FILENAME);
          if (apiHandled) return;
          res.writeHead(404, {
            "Content-Type": "application/json"
          });
          res.end(JSON.stringify({
            error: {
              message: "Not Found"
            }
          }));
        } catch (error) {
          handleError(res, error, currentConfig.MODEL_PROVIDER);
        }
      } finally {
        logger.clearRequestContext(requestId);
      }
    });
  };
}