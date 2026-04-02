import { existsSync, readFileSync, createReadStream } from "fs";

import logger from "../utils/logger.js";

import path from "path";

import { getCpuUsagePercent } from "./system-monitor.js";

export async function handleGetSystem(req, res) {
  const memUsage = process.memoryUsage();
  let appVersion = "unknown";
  try {
    const versionFilePath = path.join(process.cwd(), "VERSION");
    if (existsSync(versionFilePath)) {
      appVersion = readFileSync(versionFilePath, "utf8").trim();
    }
  } catch (error) {
    logger.warn("[UI API] Failed to read VERSION file:", error.message);
  }
  let cpuUsage = "0.0%";
  const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === "true";
  if (IS_WORKER_PROCESS) {
    cpuUsage = getCpuUsagePercent(process.pid);
  } else {
    cpuUsage = getCpuUsagePercent();
  }
  res.writeHead(200, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify({
    appVersion: appVersion,
    nodeVersion: process.version,
    serverTime: (new Date).toISOString(),
    memoryUsage: `${Math.round(memUsage.heapUsed / 1024 / 1024)} MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)} MB`,
    cpuUsage: cpuUsage,
    uptime: process.uptime()
  }));
  return true;
}

export async function handleDownloadTodayLog(req, res) {
  try {
    if (!logger.currentLogFile || !existsSync(logger.currentLogFile)) {
      res.writeHead(404, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: {
          message: "Today's log file not found"
        }
      }));
      return true;
    }
    const fileName = path.basename(logger.currentLogFile);
    res.writeHead(200, {
      "Content-Type": "text/plain",
      "Content-Disposition": `attachment; filename="${fileName}"`
    });
    const readStream = createReadStream(logger.currentLogFile);
    readStream.pipe(res);
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to download log:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to download log: " + error.message
      }
    }));
    return true;
  }
}

export async function handleClearTodayLog(req, res) {
  try {
    const success = logger.clearTodayLog();
    if (success) {
      const {broadcastEvent: broadcastEvent} = await import("./event-broadcast.js");
      broadcastEvent("log_cleared", {
        action: "log_cleared",
        timestamp: (new Date).toISOString(),
        message: "Today's log file has been cleared"
      });
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: true,
        message: "当日日志已清空"
      }));
    } else {
      res.writeHead(500, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: false,
        error: {
          message: "清空日志失败"
        }
      }));
    }
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to clear log:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: false,
      error: {
        message: "Failed to clear log: " + error.message
      }
    }));
    return true;
  }
}

export async function handleHealthCheck(req, res) {
  res.writeHead(200, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify({
    status: "ok",
    timestamp: Date.now()
  }));
  return true;
}

export async function handleGetServiceMode(req, res) {
  const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === "true";
  const masterPort = process.env.MASTER_PORT || 3100;
  res.writeHead(200, {
    "Content-Type": "application/json"
  });
  res.end(JSON.stringify({
    mode: IS_WORKER_PROCESS ? "worker" : "standalone",
    pid: process.pid,
    ppid: process.ppid,
    uptime: process.uptime(),
    canAutoRestart: IS_WORKER_PROCESS && !!process.send,
    masterPort: IS_WORKER_PROCESS ? masterPort : null,
    nodeVersion: process.version,
    platform: process.platform
  }));
  return true;
}

export async function handleRestartService(req, res) {
  try {
    const IS_WORKER_PROCESS = process.env.IS_WORKER_PROCESS === "true";
    if (IS_WORKER_PROCESS && process.send) {
      logger.info("[UI API] Requesting restart from master process...");
      process.send({
        type: "restart_request"
      });
      const {broadcastEvent: broadcastEvent} = await import("./event-broadcast.js");
      broadcastEvent("service_restart", {
        action: "restart_requested",
        timestamp: (new Date).toISOString(),
        message: "Service restart requested, worker will be restarted by master process"
      });
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: true,
        message: "Restart request sent to master process",
        mode: "worker",
        details: {
          workerPid: process.pid,
          restartMethod: "master_controlled"
        }
      }));
    } else {
      logger.info("[UI API] Service is running in standalone mode, cannot auto-restart");
      res.writeHead(400, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: false,
        message: "Service is running in standalone mode. Please use master.js to enable auto-restart feature.",
        mode: "standalone",
        hint: "Start the service with: node src/core/master.js [args]"
      }));
    }
    return true;
  } catch (error) {
    logger.error("[UI API] Failed to restart service:", error);
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      error: {
        message: "Failed to restart service: " + error.message
      }
    }));
    return true;
  }
}