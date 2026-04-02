import logger from "../utils/logger.js";

import * as http from "http";

import { initializeConfig, CONFIG } from "../core/config-manager.js";

import { initApiService, autoLinkProviderConfigs } from "./service-manager.js";

import { initializeUIManagement } from "./ui-manager.js";

import { initializeAPIManagement } from "./api-manager.js";

import { createRequestHandler } from "../handlers/request-handler.js";

import { discoverPlugins, getPluginManager } from "../core/plugin-manager.js";

import { getTLSSidecar } from "../utils/tls-sidecar.js";

import "dotenv/config";

import "../converters/register-converters.js";

import { getProviderPoolManager } from "./service-manager.js";

import { isRetryableNetworkError } from "../utils/common.js";

const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === "true";

let serverInstance = null;

function sendToMaster(message) {
  if (IS_WORKER_PROCESS && process.send) {
    process.send(message);
  }
}

function setupWorkerCommunication() {
  if (!IS_WORKER_PROCESS) return;
  process.on("message", message => {
    if (!message || !message.type) return;
    logger.info("[Worker] Received message from master:", message.type);
    switch (message.type) {
     case "shutdown":
      logger.info("[Worker] Shutdown requested by master");
      gracefulShutdown();
      break;

     case "status":
      sendToMaster({
        type: "status",
        data: {
          pid: process.pid,
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage()
        }
      });
      break;

     default:
      logger.info("[Worker] Unknown message type:", message.type);
    }
  });
  process.on("disconnect", () => {
    logger.info("[Worker] Disconnected from master, shutting down...");
    gracefulShutdown();
  });
}

async function gracefulShutdown() {
  logger.info("[Server] Initiating graceful shutdown...");
  try {
    await getTLSSidecar().stop();
  } catch {}
  if (serverInstance) {
    serverInstance.close(() => {
      logger.info("[Server] HTTP server closed");
      process.exit(0);
    });
    setTimeout(() => {
      logger.info("[Server] Shutdown timeout, forcing exit...");
      process.exit(1);
    }, 1e4);
  } else {
    process.exit(0);
  }
}

function setupSignalHandlers() {
  process.on("SIGTERM", () => {
    logger.info("[Server] Received SIGTERM");
    gracefulShutdown();
  });
  process.on("SIGINT", () => {
    logger.info("[Server] Received SIGINT");
    gracefulShutdown();
  });
  process.on("uncaughtException", error => {
    logger.error("[Server] Uncaught exception:", error);
    if (isRetryableNetworkError(error)) {
      logger.warn("[Server] Network error detected, continuing operation...");
      return;
    }
    logger.error("[Server] Fatal error detected, initiating shutdown...");
    gracefulShutdown();
  });
  process.on("unhandledRejection", (reason, promise) => {
    logger.error("[Server] Unhandled rejection at:", promise, "reason:", reason);
    if (reason && isRetryableNetworkError(reason)) {
      logger.warn("[Server] Network error in promise rejection, continuing operation...");
      return;
    }
  });
}

async function startServer() {
  await initializeConfig(process.argv.slice(2), "configs/config.json");
  if (CONFIG.TLS_SIDECAR_ENABLED) {
    const sidecar = getTLSSidecar();
    const started = await sidecar.start({
      port: CONFIG.TLS_SIDECAR_PORT,
      binaryPath: CONFIG.TLS_SIDECAR_BINARY_PATH || undefined
    });
    if (started) {
      logger.info("[Initialization] TLS sidecar started successfully");
    } else {
      logger.warn("[Initialization] TLS sidecar failed to start, falling back to Node.js TLS");
    }
  }
  logger.info("[Initialization] Discovering and initializing plugins...");
  await discoverPlugins();
  const pluginManager = getPluginManager();
  await pluginManager.initAll(CONFIG);
  const pluginList = pluginManager.getPluginList();
  if (pluginList.length > 0) {
    logger.info(`[Plugins] Loaded ${pluginList.length} plugin(s):`);
    pluginList.forEach(p => {
      const status = p.enabled ? "✓" : "✗";
      logger.info(`  ${status} ${p.name} v${p.version} - ${p.description}`);
    });
  }
  const services = await initApiService(CONFIG, true);
  initializeUIManagement(CONFIG);
  const heartbeatAndRefreshToken = initializeAPIManagement(services);
  const requestHandlerInstance = createRequestHandler(CONFIG, getProviderPoolManager());
  serverInstance = http.createServer({
    requestTimeout: 0,
    headersTimeout: 6e4,
    keepAliveTimeout: 65e3
  }, requestHandlerInstance);
  serverInstance.maxConnections = 1e3;
  serverInstance.listen(CONFIG.SERVER_PORT, CONFIG.HOST, async () => {
    logger.info(`--- Unified API Server Configuration ---`);
    const configuredProviders = Array.isArray(CONFIG.DEFAULT_MODEL_PROVIDERS) && CONFIG.DEFAULT_MODEL_PROVIDERS.length > 0 ? CONFIG.DEFAULT_MODEL_PROVIDERS : [ CONFIG.MODEL_PROVIDER ];
    const uniqueProviders = [ ...new Set(configuredProviders) ];
    logger.info(`  Primary Model Provider: ${CONFIG.MODEL_PROVIDER}`);
    if (uniqueProviders.length > 1) {
      logger.info(`  Additional Model Providers: ${uniqueProviders.slice(1).join(", ")}`);
    }
    logger.info(`  System Prompt File: ${CONFIG.SYSTEM_PROMPT_FILE_PATH || "Default"}`);
    logger.info(`  System Prompt Mode: ${CONFIG.SYSTEM_PROMPT_MODE}`);
    logger.info(`  Host: ${CONFIG.HOST}`);
    logger.info(`  Port: ${CONFIG.SERVER_PORT}`);
    logger.info(`  Required API Key: ${CONFIG.REQUIRED_API_KEY}`);
    logger.info(`  Prompt Logging: ${CONFIG.PROMPT_LOG_MODE}${CONFIG.PROMPT_LOG_FILENAME ? ` (to ${CONFIG.PROMPT_LOG_FILENAME})` : ""}`);
    logger.info(`------------------------------------------`);
    logger.info(`\nUnified API Server running on http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}`);
    logger.info(`Supports multiple API formats:`);
    logger.info(`  • OpenAI-compatible: /v1/chat/completions, /v1/responses, /v1/models`);
    logger.info(`  • Gemini-compatible: /v1beta/models, /v1beta/models/{model}:generateContent`);
    logger.info(`  • Claude-compatible: /v1/messages`);
    logger.info(`  • Health check: /health`);
    logger.info(`  • UI Management Console: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/`);
    try {
      const open = (await import("open")).default;
      const openDelay = IS_WORKER_PROCESS ? 3e3 : 1e3;
      setTimeout(() => {
        let openUrl = `http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`;
        if (CONFIG.HOST === "0.0.0.0") {
          openUrl = `http://localhost:${CONFIG.SERVER_PORT}/login.html`;
        }
        open(openUrl).then(() => {
          logger.info("[UI] Opened login page in default browser");
        }).catch(err => {
          logger.info("[UI] Please open manually: http://" + CONFIG.HOST + ":" + CONFIG.SERVER_PORT + "/login.html");
        });
      }, openDelay);
    } catch (err) {
      logger.info(`[UI] Login page available at: http://${CONFIG.HOST}:${CONFIG.SERVER_PORT}/login.html`);
    }
    if (CONFIG.CRON_REFRESH_TOKEN) {
      logger.info(`  • Cron Near Minutes: ${CONFIG.CRON_NEAR_MINUTES}`);
      logger.info(`  • Cron Refresh Token: ${CONFIG.CRON_REFRESH_TOKEN}`);
      setInterval(heartbeatAndRefreshToken, CONFIG.CRON_NEAR_MINUTES * 60 * 1e3);
    }
    const poolManager = getProviderPoolManager();
    if (poolManager) {
      logger.info("[Initialization] Performing initial health checks for provider pools...");
      poolManager.performHealthChecks(true);
    }
    if (IS_WORKER_PROCESS) {
      sendToMaster({
        type: "ready",
        pid: process.pid
      });
    }
  });
  return serverInstance;
}

setupSignalHandlers();

setupWorkerCommunication();

startServer().catch(err => {
  logger.error("[Server] Failed to start server:", err.message);
  process.exit(1);
});

export { gracefulShutdown, sendToMaster };