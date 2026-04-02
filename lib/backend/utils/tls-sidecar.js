import { spawn } from "child_process";

import fs from "fs";

import path from "path";

import { fileURLToPath } from "url";

import logger from "./logger.js";

import http from "http";

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 9090;

const HEALTH_CHECK_INTERVAL = 3e4;

const HEALTH_CHECK_TIMEOUT = 3e3;

const MAX_RESTART_ATTEMPTS = 5;

const RESTART_DELAY = 2e3;

class TLSSidecar {
  constructor() {
    this.process = null;
    this.port = DEFAULT_PORT;
    this.baseUrl = null;
    this.healthCheckTimer = null;
    this.restartCount = 0;
    this.isShuttingDown = false;
    this.ready = false;
  }
  async start(options = {}) {
    if (this.process) {
      logger.info("[TLS-Sidecar] Already running");
      return true;
    }
    this.port = options.port || parseInt(process.env.TLS_SIDECAR_PORT) || DEFAULT_PORT;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    const binaryPath = options.binaryPath || this._findBinary();
    if (!binaryPath) {
      logger.error("[TLS-Sidecar] Binary not found. Build it with: cd tls-sidecar && go build -o tls-sidecar");
      return false;
    }
    logger.info(`[TLS-Sidecar] Starting: ${binaryPath} on port ${this.port}`);
    try {
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(binaryPath, 493);
        } catch (e) {
          logger.warn(`[TLS-Sidecar] Failed to chmod binary: ${e.message}`);
        }
      }
      this.process = spawn(binaryPath, [], {
        env: {
          ...process.env,
          TLS_SIDECAR_PORT: String(this.port)
        },
        stdio: [ "ignore", "pipe", "pipe" ]
      });
      this.process.stdout.on("data", data => {
        const msg = data.toString().trim();
        if (msg) logger.info(`[TLS-Sidecar] ${msg}`);
      });
      this.process.stderr.on("data", data => {
        const msg = data.toString().trim();
        if (msg) logger.error(`[TLS-Sidecar] ${msg}`);
      });
      this.process.on("exit", (code, signal) => {
        logger.warn(`[TLS-Sidecar] Process exited (code=${code}, signal=${signal})`);
        this.process = null;
        this.ready = false;
        if (!this.isShuttingDown && this.restartCount < MAX_RESTART_ATTEMPTS) {
          this.restartCount++;
          logger.info(`[TLS-Sidecar] Auto-restart attempt ${this.restartCount}/${MAX_RESTART_ATTEMPTS}`);
          setTimeout(() => this.start(options), RESTART_DELAY);
        }
      });
      this.process.on("error", err => {
        logger.error(`[TLS-Sidecar] Spawn error: ${err.message}`);
        this.process = null;
        this.ready = false;
      });
      const ok = await this._waitForReady();
      if (ok) {
        this.ready = true;
        this.restartCount = 0;
        this._startHealthCheck();
        logger.info(`[TLS-Sidecar] Ready at ${this.baseUrl}`);
      }
      return ok;
    } catch (err) {
      logger.error(`[TLS-Sidecar] Failed to start: ${err.message}`);
      return false;
    }
  }
  async stop() {
    this.isShuttingDown = true;
    this._stopHealthCheck();
    if (this.process) {
      logger.info("[TLS-Sidecar] Stopping...");
      return new Promise(resolve => {
        const timeout = setTimeout(() => {
          if (this.process) {
            logger.warn("[TLS-Sidecar] Force killing");
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 5e3);
        this.process.once("exit", () => {
          clearTimeout(timeout);
          this.process = null;
          this.ready = false;
          logger.info("[TLS-Sidecar] Stopped");
          resolve();
        });
        this.process.kill("SIGTERM");
      });
    }
  }
  isReady() {
    return this.ready && this.process !== null;
  }
  getBaseUrl() {
    return this.isReady() ? this.baseUrl : null;
  }
  wrapAxiosConfig(axiosConfig, proxyUrl) {
    if (!this.isReady()) {
      return axiosConfig;
    }
    const targetUrl = axiosConfig.url;
    axiosConfig.url = this.baseUrl;
    axiosConfig.headers = axiosConfig.headers || {};
    axiosConfig.headers["X-Target-Url"] = targetUrl;
    if (proxyUrl) {
      axiosConfig.headers["X-Proxy-Url"] = proxyUrl;
    }
    delete axiosConfig.httpAgent;
    delete axiosConfig.httpsAgent;
    axiosConfig.proxy = false;
    return axiosConfig;
  }
  _findBinary() {
    const projectRoot = path.resolve(__dirname, "..", "..");
    const isWin = process.platform === "win32";
    const ext = isWin ? ".exe" : "";
    const candidates = [ path.join(projectRoot, "tls-sidecar", `tls-sidecar${ext}`), path.join(projectRoot, `tls-sidecar${ext}`), path.join("/usr", "local", "bin", `tls-sidecar${ext}`), path.join("/app", "tls-sidecar", `tls-sidecar${ext}`), path.join("/app", `tls-sidecar${ext}`) ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          return p;
        }
      } catch {}
    }
    return null;
  }
  async _waitForReady(timeoutMs = 1e4) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const ok = await this._healthCheck();
        if (ok) return true;
      } catch {}
      await sleep(500);
    }
    logger.error("[TLS-Sidecar] Timed out waiting for sidecar to become ready");
    return false;
  }
  _healthCheck() {
    return new Promise(resolve => {
      const req = http.get(`${this.baseUrl}/health`, {
        timeout: HEALTH_CHECK_TIMEOUT
      }, res => {
        let body = "";
        res.on("data", chunk => body += chunk);
        res.on("end", () => {
          resolve(res.statusCode === 200);
        });
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }
  _startHealthCheck() {
    this._stopHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      const ok = await this._healthCheck();
      if (!ok && this.ready) {
        logger.warn("[TLS-Sidecar] Health check failed");
        this.ready = false;
      } else if (ok && !this.ready) {
        logger.info("[TLS-Sidecar] Recovered");
        this.ready = true;
      }
    }, HEALTH_CHECK_INTERVAL);
  }
  _stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let instance = null;

export function getTLSSidecar() {
  if (!instance) {
    instance = new TLSSidecar;
  }
  return instance;
}

export default TLSSidecar;