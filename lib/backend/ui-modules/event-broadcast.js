import { existsSync, readFileSync } from "fs";

import { promises as fs } from "fs";

import path from "path";

import multer from "multer";

import logger from "../utils/logger.js";

const TOKEN_STORE_FILE = path.join(process.cwd(), "configs", "token-store.json");

const USAGE_CACHE_FILE = path.join(process.cwd(), "configs", "usage-cache.json");

export function broadcastEvent(eventType, data) {
  if (global.eventClients && global.eventClients.length > 0) {
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    global.eventClients.forEach(client => {
      client.write(`event: ${eventType}\n`);
      client.write(`data: ${payload}\n\n`);
    });
  }
}

export async function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*"
  });
  try {
    res.write("\n");
  } catch (err) {
    logger.error("[Event Broadcast] Failed to write initial data:", err.message);
    return true;
  }
  if (!global.eventClients) {
    global.eventClients = [];
  }
  global.eventClients.push(res);
  const keepAlive = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      try {
        res.write(":\n\n");
      } catch (err) {
        logger.error("[Event Broadcast] Failed to write keepalive:", err.message);
        clearInterval(keepAlive);
        global.eventClients = global.eventClients.filter(r => r !== res);
      }
    } else {
      clearInterval(keepAlive);
      global.eventClients = global.eventClients.filter(r => r !== res);
    }
  }, 3e4);
  req.on("close", () => {
    clearInterval(keepAlive);
    global.eventClients = global.eventClients.filter(r => r !== res);
  });
  return true;
}

export function initializeUIManagement() {
  if (!global.eventClients) {
    global.eventClients = [];
  }
  if (!global.logBuffer) {
    global.logBuffer = [];
  }
  const originalLog = console.log;
  console.log = function(...args) {
    originalLog.apply(console, args);
    const logEntry = {
      timestamp: (new Date).toISOString(),
      level: "info",
      message: args.map(arg => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }).join(" ")
    };
    global.logBuffer.push(logEntry);
    if (global.logBuffer.length > 100) {
      global.logBuffer.shift();
    }
    broadcastEvent("log", logEntry);
  };
  const originalError = console.error;
  console.error = function(...args) {
    originalError.apply(console, args);
    const logEntry = {
      timestamp: (new Date).toISOString(),
      level: "error",
      message: args.map(arg => {
        if (typeof arg === "string") return arg;
        try {
          return JSON.stringify(arg);
        } catch (e) {
          return String(arg);
        }
      }).join(" ")
    };
    global.logBuffer.push(logEntry);
    if (global.logBuffer.length > 100) {
      global.logBuffer.shift();
    }
    broadcastEvent("log", logEntry);
  };
}

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const uploadPath = path.join(process.cwd(), "configs", "temp");
      await fs.mkdir(uploadPath, {
        recursive: true
      });
      cb(null, uploadPath);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, `${timestamp}_${sanitizedName}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [ ".json", ".txt", ".key", ".pem", ".p12", ".pfx" ];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedTypes.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Unsupported file type"), false);
  }
};

export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024
  }
});

export function handleUploadOAuthCredentials(req, res, options = {}) {
  const {providerMap: providerMap = {}, logPrefix: logPrefix = "[UI API]", userInfo: userInfo = "", customUpload: customUpload = null} = options;
  const uploadMiddleware = customUpload ? customUpload.single("file") : upload.single("file");
  return new Promise(resolve => {
    uploadMiddleware(req, res, async err => {
      if (err) {
        logger.error(`${logPrefix} File upload error:`, err.message);
        res.writeHead(400, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: err.message || "File upload failed"
          }
        }));
        resolve(true);
        return;
      }
      try {
        if (!req.file) {
          res.writeHead(400, {
            "Content-Type": "application/json"
          });
          res.end(JSON.stringify({
            error: {
              message: "No file was uploaded"
            }
          }));
          resolve(true);
          return;
        }
        const providerType = req.body.provider || "common";
        const provider = providerMap[providerType] || providerType;
        const tempFilePath = req.file.path;
        let targetDir = path.join(process.cwd(), "configs", provider);
        if (provider === "kiro") {
          const timestamp = Date.now();
          const originalNameWithoutExt = path.parse(req.file.originalname).name;
          const subFolder = `${timestamp}_${originalNameWithoutExt}`;
          targetDir = path.join(targetDir, subFolder);
        }
        await fs.mkdir(targetDir, {
          recursive: true
        });
        const targetFilePath = path.join(targetDir, req.file.filename);
        await fs.rename(tempFilePath, targetFilePath);
        const relativePath = path.relative(process.cwd(), targetFilePath);
        broadcastEvent("config_update", {
          action: "add",
          filePath: relativePath,
          provider: provider,
          timestamp: (new Date).toISOString()
        });
        const userInfoStr = userInfo ? `, ${userInfo}` : "";
        logger.info(`${logPrefix} OAuth credentials file uploaded: ${targetFilePath} (provider: ${provider}${userInfoStr})`);
        res.writeHead(200, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          success: true,
          message: "File uploaded successfully",
          filePath: relativePath,
          originalName: req.file.originalname,
          provider: provider
        }));
        resolve(true);
      } catch (error) {
        logger.error(`${logPrefix} File upload processing error:`, error);
        res.writeHead(500, {
          "Content-Type": "application/json"
        });
        res.end(JSON.stringify({
          error: {
            message: "File upload processing failed: " + error.message
          }
        }));
        resolve(true);
      }
    });
  });
}