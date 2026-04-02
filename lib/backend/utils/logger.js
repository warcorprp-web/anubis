import * as fs from "fs";

import * as path from "path";

import { randomUUID } from "crypto";

import { AsyncLocalStorage } from "node:async_hooks";

class Logger {
  constructor() {
    this.config = {
      enabled: true,
      outputMode: "all",
      logDir: "logs",
      logLevel: "info",
      includeRequestId: true,
      includeTimestamp: true,
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 10
    };
    this.currentLogFile = null;
    this.logStream = null;
    this.asyncStorage = new AsyncLocalStorage;
    this.requestContext = new Map;
    this.contextTTL = 5 * 60 * 1e3;
    this._contextCleanupTimer = null;
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
  }
  initialize(config = {}) {
    this.config = {
      ...this.config,
      ...config
    };
    if (this.config.outputMode === "none") {
      this.config.enabled = false;
      return;
    }
    if (this.config.outputMode === "file" || this.config.outputMode === "all") {
      this.initializeFileLogging();
    }
  }
  initializeFileLogging() {
    try {
      if (!fs.existsSync(this.config.logDir)) {
        fs.mkdirSync(this.config.logDir, {
          recursive: true
        });
      }
      const date = new Date;
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      const dateStr = `${year}-${month}-${day}`;
      this.currentLogFile = path.join(this.config.logDir, `app-${dateStr}.log`);
      this.logStream = fs.createWriteStream(this.currentLogFile, {
        flags: "a"
      });
      this.logStream.on("error", err => {
        console.error("[Logger] Failed to write to log file:", err.message);
      });
    } catch (error) {
      console.error("[Logger] Failed to initialize file logging:", error.message);
    }
  }
  runWithContext(requestId, callback) {
    if (!requestId) {
      requestId = randomUUID().substring(0, 8);
    }
    this.requestContext.set(requestId, {
      _createdAt: Date.now()
    });
    this._ensureContextCleanup();
    return this.asyncStorage.run(requestId, callback);
  }
  setRequestContext(requestId, context = {}) {
    if (!requestId) {
      requestId = randomUUID().substring(0, 8);
    }
    this.asyncStorage.enterWith(requestId);
    this.requestContext.set(requestId, {
      ...context,
      _createdAt: Date.now()
    });
    this._ensureContextCleanup();
    return requestId;
  }
  getCurrentRequestId() {
    return this.asyncStorage.getStore();
  }
  getRequestContext(requestId) {
    if (!requestId) {
      requestId = this.getCurrentRequestId();
    }
    return this.requestContext.get(requestId) || {};
  }
  clearRequestContext(requestId) {
    if (requestId) {
      this.requestContext.delete(requestId);
    }
  }
  _ensureContextCleanup() {
    if (this._contextCleanupTimer) return;
    this._contextCleanupTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [id, ctx] of this.requestContext) {
        if (now - (ctx._createdAt || 0) > this.contextTTL) {
          this.requestContext.delete(id);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        this.log("warn", [ `[Logger] Cleaned ${cleaned} stale request context(s) (TTL: ${this.contextTTL}ms)` ]);
      }
      if (this.requestContext.size === 0) {
        clearInterval(this._contextCleanupTimer);
        this._contextCleanupTimer = null;
      }
    }, 6e4);
    if (this._contextCleanupTimer.unref) {
      this._contextCleanupTimer.unref();
    }
  }
  formatMessage(level, args, requestId) {
    const parts = [];
    if (this.config.includeTimestamp) {
      const now = new Date;
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      const hours = String(now.getHours()).padStart(2, "0");
      const minutes = String(now.getMinutes()).padStart(2, "0");
      const seconds = String(now.getSeconds()).padStart(2, "0");
      const ms = String(now.getMilliseconds()).padStart(3, "0");
      const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
      parts.push(`[${timestamp}]`);
    }
    if (this.config.includeRequestId && requestId) {
      parts.push(`[Req:${requestId}]`);
    }
    parts.push(`[${level.toUpperCase()}]`);
    const message = args.map(arg => {
      if (typeof arg === "object") {
        try {
          return JSON.stringify(arg, null, 2);
        } catch (e) {
          return String(arg);
        }
      }
      return String(arg);
    }).join(" ");
    parts.push(message);
    return parts.join(" ");
  }
  shouldLog(level) {
    if (!this.config.enabled) return false;
    const currentLevel = this.levels[this.config.logLevel] ?? 1;
    const targetLevel = this.levels[level] ?? 1;
    return targetLevel >= currentLevel;
  }
  checkAndRotateLogFile() {
    try {
      if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) {
        return;
      }
      const stats = fs.statSync(this.currentLogFile);
      if (stats.size >= this.config.maxFileSize) {
        if (this.logStream && !this.logStream.destroyed) {
          this.logStream.end();
        }
        const timestamp = (new Date).getTime();
        const ext = path.extname(this.currentLogFile);
        const basename = path.basename(this.currentLogFile, ext);
        const newName = path.join(this.config.logDir, `${basename}-${timestamp}${ext}`);
        fs.renameSync(this.currentLogFile, newName);
        this.logStream = fs.createWriteStream(this.currentLogFile, {
          flags: "a"
        });
        this.logStream.on("error", err => {
          console.error("[Logger] Failed to write to log file:", err.message);
        });
        this.cleanupOldLogs();
      }
    } catch (error) {
      console.error("[Logger] Failed to rotate log file:", error.message);
    }
  }
  log(level, args, requestId = null) {
    if (!this.shouldLog(level)) return;
    const message = this.formatMessage(level, args, requestId);
    if (this.config.outputMode === "console" || this.config.outputMode === "all") {
      const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
      consoleMethod(message);
    }
    if (this.config.outputMode === "file" || this.config.outputMode === "all") {
      if (this.logStream && !this.logStream.destroyed && this.logStream.writable) {
        try {
          this.checkAndRotateLogFile();
          this.logStream.write(message + "\n");
        } catch (err) {
          console.error("[Logger] Failed to write to log file:", err.message);
        }
      }
    }
  }
  debug(...args) {
    const requestId = this.getCurrentRequestId();
    this.log("debug", args, requestId);
  }
  info(...args) {
    const requestId = this.getCurrentRequestId();
    this.log("info", args, requestId);
  }
  warn(...args) {
    const requestId = this.getCurrentRequestId();
    this.log("warn", args, requestId);
  }
  error(...args) {
    const requestId = this.getCurrentRequestId();
    this.log("error", args, requestId);
  }
  withRequest(requestId) {
    if (!requestId) {
      requestId = this.getCurrentRequestId();
    }
    return {
      debug: (...args) => this.log("debug", args, requestId),
      info: (...args) => this.log("info", args, requestId),
      warn: (...args) => this.log("warn", args, requestId),
      error: (...args) => this.log("error", args, requestId)
    };
  }
  close() {
    if (this._contextCleanupTimer) {
      clearInterval(this._contextCleanupTimer);
      this._contextCleanupTimer = null;
    }
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = null;
    }
  }
  cleanupOldLogs() {
    try {
      if (!fs.existsSync(this.config.logDir)) {
        return;
      }
      const files = fs.readdirSync(this.config.logDir).filter(file => file.startsWith("app-") && file.endsWith(".log")).map(file => ({
        name: file,
        path: path.join(this.config.logDir, file),
        time: fs.statSync(path.join(this.config.logDir, file)).mtime.getTime()
      })).sort((a, b) => b.time - a.time);
      if (files.length > this.config.maxFiles) {
        for (let i = this.config.maxFiles; i < files.length; i++) {
          try {
            fs.unlinkSync(files[i].path);
          } catch (err) {
            console.error("[Logger] Failed to delete old log file:", files[i].name, err.message);
          }
        }
      }
    } catch (error) {
      console.error("[Logger] Failed to cleanup old logs:", error.message);
    }
  }
  clearTodayLog() {
    try {
      if (!this.currentLogFile || !fs.existsSync(this.currentLogFile)) {
        console.warn("[Logger] No current log file to clear");
        return false;
      }
      if (this.logStream && !this.logStream.destroyed) {
        this.logStream.end();
      }
      fs.writeFileSync(this.currentLogFile, "");
      this.logStream = fs.createWriteStream(this.currentLogFile, {
        flags: "a"
      });
      this.logStream.on("error", err => {
        console.error("[Logger] Failed to write to log file:", err.message);
      });
      console.log("[Logger] Today's log file cleared successfully");
      return true;
    } catch (error) {
      console.error("[Logger] Failed to clear today's log file:", error.message);
      return false;
    }
  }
}

const logger = new Logger;

export default logger;

export { Logger };