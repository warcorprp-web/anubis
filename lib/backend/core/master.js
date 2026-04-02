import { fork } from "child_process";

import logger from "../utils/logger.js";

import * as http from "http";

import * as path from "path";

import { fileURLToPath } from "url";

import { isRetryableNetworkError } from "../utils/common.js";

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

let workerProcess = null;

let workerStatus = {
  pid: null,
  startTime: null,
  restartCount: 0,
  lastRestartTime: null,
  isRestarting: false
};

const config = {
  workerScript: path.join(__dirname, "../services/api-server.js"),
  maxRestartAttempts: 10,
  restartDelay: 1e3,
  masterPort: parseInt(process.env.MASTER_PORT) || 3100,
  args: process.argv.slice(2)
};

function startWorker() {
  if (workerProcess) {
    logger.info("[Master] Worker process already running, PID:", workerProcess.pid);
    return;
  }
  logger.info("[Master] Starting worker process...");
  logger.info("[Master] Worker script:", config.workerScript);
  logger.info("[Master] Worker args:", config.args.join(" "));
  workerProcess = fork(config.workerScript, config.args, {
    stdio: [ "inherit", "inherit", "inherit", "ipc" ],
    env: {
      ...process.env,
      IS_WORKER_PROCESS: "true"
    }
  });
  workerStatus.pid = workerProcess.pid;
  workerStatus.startTime = (new Date).toISOString();
  logger.info("[Master] Worker process started, PID:", workerProcess.pid);
  workerProcess.on("message", message => {
    logger.info("[Master] Received message from worker:", message);
    handleWorkerMessage(message);
  });
  workerProcess.on("exit", (code, signal) => {
    logger.info(`[Master] Worker process exited with code ${code}, signal ${signal}`);
    workerProcess = null;
    workerStatus.pid = null;
    if (!workerStatus.isRestarting && code !== 0) {
      logger.info("[Master] Worker crashed, attempting auto-restart...");
      scheduleRestart();
    }
  });
  workerProcess.on("error", error => {
    logger.error("[Master] Worker process error:", error.message);
  });
}

function stopWorker(graceful = true) {
  return new Promise(resolve => {
    if (!workerProcess) {
      logger.info("[Master] No worker process to stop");
      resolve();
      return;
    }
    logger.info("[Master] Stopping worker process, PID:", workerProcess.pid);
    const timeout = setTimeout(() => {
      if (workerProcess) {
        logger.info("[Master] Force killing worker process...");
        workerProcess.kill("SIGKILL");
      }
      resolve();
    }, 5e3);
    workerProcess.once("exit", () => {
      clearTimeout(timeout);
      workerProcess = null;
      workerStatus.pid = null;
      logger.info("[Master] Worker process stopped");
      resolve();
    });
    if (graceful) {
      workerProcess.send({
        type: "shutdown"
      });
      workerProcess.kill("SIGTERM");
    } else {
      workerProcess.kill("SIGKILL");
    }
  });
}

async function restartWorker() {
  if (workerStatus.isRestarting) {
    logger.info("[Master] Restart already in progress");
    return {
      success: false,
      message: "Restart already in progress"
    };
  }
  workerStatus.isRestarting = true;
  workerStatus.restartCount++;
  workerStatus.lastRestartTime = (new Date).toISOString();
  logger.info("[Master] Restarting worker process...");
  try {
    await stopWorker(true);
    await new Promise(resolve => setTimeout(resolve, config.restartDelay));
    startWorker();
    workerStatus.isRestarting = false;
    return {
      success: true,
      message: "Worker restarted successfully",
      pid: workerStatus.pid,
      restartCount: workerStatus.restartCount
    };
  } catch (error) {
    workerStatus.isRestarting = false;
    logger.error("[Master] Failed to restart worker:", error.message);
    return {
      success: false,
      message: "Failed to restart worker: " + error.message
    };
  }
}

function scheduleRestart() {
  if (workerStatus.restartCount >= config.maxRestartAttempts) {
    logger.error("[Master] Max restart attempts reached, giving up");
    return;
  }
  const delay = Math.min(config.restartDelay * Math.pow(2, workerStatus.restartCount), 3e4);
  logger.info(`[Master] Scheduling restart in ${delay}ms...`);
  setTimeout(() => {
    restartWorker();
  }, delay);
}

function handleWorkerMessage(message) {
  if (!message || !message.type) return;
  switch (message.type) {
   case "ready":
    logger.info("[Master] Worker is ready");
    break;

   case "restart_request":
    logger.info("[Master] Worker requested restart");
    restartWorker();
    break;

   case "status":
    logger.info("[Master] Worker status:", message.data);
    break;

   default:
    logger.info("[Master] Unknown message type:", message.type);
  }
}

function getStatus() {
  return {
    master: {
      pid: process.pid,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage()
    },
    worker: {
      pid: workerStatus.pid,
      startTime: workerStatus.startTime,
      restartCount: workerStatus.restartCount,
      lastRestartTime: workerStatus.lastRestartTime,
      isRestarting: workerStatus.isRestarting,
      isRunning: workerProcess !== null
    }
  };
}

function createMasterServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === "GET" && path === "/master/status") {
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify(getStatus()));
      return;
    }
    if (method === "POST" && path === "/master/restart") {
      logger.info("[Master] Restart requested via API");
      const result = await restartWorker();
      res.writeHead(result.success ? 200 : 500, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify(result));
      return;
    }
    if (method === "POST" && path === "/master/stop") {
      logger.info("[Master] Stop requested via API");
      await stopWorker(true);
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: true,
        message: "Worker stopped"
      }));
      return;
    }
    if (method === "POST" && path === "/master/start") {
      logger.info("[Master] Start requested via API");
      if (workerProcess) {
        res.writeHead(400, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          success: false,
          message: "Worker already running"
        }));
        return;
      }
      startWorker();
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: true,
        message: "Worker started",
        pid: workerStatus.pid
      }));
      return;
    }
    if (method === "GET" && path === "/master/health") {
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        status: "healthy",
        workerRunning: workerProcess !== null,
        timestamp: (new Date).toISOString()
      }));
      return;
    }
    res.writeHead(404, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: "Not Found"
    }));
  });
  server.listen(config.masterPort, () => {
    logger.info(`[Master] Management server listening on port ${config.masterPort}`);
    logger.info(`[Master] Available endpoints:`);
    logger.info(`  GET  /master/status  - Get master and worker status`);
    logger.info(`  GET  /master/health  - Health check`);
    logger.info(`  POST /master/restart - Restart worker process`);
    logger.info(`  POST /master/stop    - Stop worker process`);
    logger.info(`  POST /master/start   - Start worker process`);
  });
  return server;
}

function setupSignalHandlers() {
  process.on("SIGTERM", async () => {
    logger.info("[Master] Received SIGTERM, shutting down...");
    await stopWorker(true);
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    logger.info("[Master] Received SIGINT, shutting down...");
    await stopWorker(true);
    process.exit(0);
  });
  process.on("uncaughtException", error => {
    logger.error("[Master] Uncaught exception:", error);
    if (isRetryableNetworkError(error)) {
      logger.warn("[Master] Network error detected, continuing operation...");
      return;
    }
    logger.error("[Master] Fatal error detected in master process");
  });
  process.on("unhandledRejection", (reason, promise) => {
    logger.error("[Master] Unhandled rejection at:", promise, "reason:", reason);
    if (reason && isRetryableNetworkError(reason)) {
      logger.warn("[Master] Network error in promise rejection, continuing operation...");
      return;
    }
  });
}

async function main() {
  logger.info("=".repeat(50));
  logger.info("[Master] AIClient2API Master Process");
  logger.info("[Master] PID:", process.pid);
  logger.info("[Master] Node version:", process.version);
  logger.info("[Master] Working directory:", process.cwd());
  logger.info("=".repeat(50));
  setupSignalHandlers();
  createMasterServer();
  startWorker();
}

main().catch(error => {
  logger.error("[Master] Failed to start:", error);
  process.exit(1);
});