import { existsSync } from "fs";

import logger from "../utils/logger.js";

import { promises as fs } from "fs";

import path from "path";

import crypto from "crypto";

import { CONFIG } from "../core/config-adapter";

import { getClientIp } from "../utils/common.js";

const TOKEN_STORE_FILE = path.join(process.cwd(), "configs", "token-store.json");

const DEFAULT_PASSWORD = "admin123";

export async function readPasswordFile() {
  const pwdFilePath = path.join(process.cwd(), "configs", "pwd");
  try {
    const password = await fs.readFile(pwdFilePath, "utf8");
    const trimmedPassword = password.trim();
    if (!trimmedPassword) {
      logger.info("[Auth] Password file is empty, using default password: " + DEFAULT_PASSWORD);
      return DEFAULT_PASSWORD;
    }
    logger.info("[Auth] Successfully read password file");
    return trimmedPassword;
  } catch (error) {
    if (error.code === "ENOENT") {
      logger.info("[Auth] Password file does not exist, using default password: " + DEFAULT_PASSWORD);
    } else {
      logger.error("[Auth] Failed to read password file:", error.code || error.message);
      logger.info("[Auth] Using default password: " + DEFAULT_PASSWORD);
    }
    return DEFAULT_PASSWORD;
  }
}

export async function validateCredentials(password) {
  const storedPassword = await readPasswordFile();
  logger.info("[Auth] Validating password, stored password length:", storedPassword ? storedPassword.length : 0, ", input password length:", password ? password.length : 0);
  const isValid = storedPassword && password === storedPassword;
  logger.info("[Auth] Password validation result:", isValid);
  return isValid;
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
    });
    req.on("end", () => {
      try {
        if (!body.trim()) {
          resolve({});
        } else {
          resolve(JSON.parse(body));
        }
      } catch (error) {
        reject(new Error("Invalid JSON format"));
      }
    });
    req.on("error", reject);
  });
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function getExpiryTime() {
  const now = Date.now();
  const expiry = (CONFIG.LOGIN_EXPIRY || 3600) * 1e3;
  return now + expiry;
}

async function readTokenStore() {
  try {
    if (existsSync(TOKEN_STORE_FILE)) {
      const content = await fs.readFile(TOKEN_STORE_FILE, "utf8");
      return JSON.parse(content);
    } else {
      await writeTokenStore({
        tokens: {}
      });
      return {
        tokens: {}
      };
    }
  } catch (error) {
    logger.error("[Token Store] Failed to read token store file:", error);
    return {
      tokens: {}
    };
  }
}

async function writeTokenStore(tokenStore) {
  try {
    await fs.writeFile(TOKEN_STORE_FILE, JSON.stringify(tokenStore, null, 2), "utf8");
  } catch (error) {
    logger.error("[Token Store] Failed to write token store file:", error);
  }
}

export async function verifyToken(token) {
  const tokenStore = await readTokenStore();
  const tokenInfo = tokenStore.tokens[token];
  if (!tokenInfo) {
    return null;
  }
  if (Date.now() > tokenInfo.expiryTime) {
    await deleteToken(token);
    return null;
  }
  return tokenInfo;
}

async function saveToken(token, tokenInfo) {
  const tokenStore = await readTokenStore();
  tokenStore.tokens[token] = tokenInfo;
  await writeTokenStore(tokenStore);
}

async function deleteToken(token) {
  const tokenStore = await readTokenStore();
  if (tokenStore.tokens[token]) {
    delete tokenStore.tokens[token];
    await writeTokenStore(tokenStore);
  }
}

class LoginAttemptManager {
  constructor() {
    this.attempts = new Map;
  }
  getIpStatus(ip) {
    if (!this.attempts.has(ip)) {
      this.attempts.set(ip, {
        count: 0,
        lastAttempt: 0,
        lockoutUntil: 0
      });
    }
    return this.attempts.get(ip);
  }
  isLockedOut(ip) {
    const status = this.getIpStatus(ip);
    if (status.lockoutUntil > Date.now()) {
      return {
        locked: true,
        remainingTime: Math.ceil((status.lockoutUntil - Date.now()) / 1e3)
      };
    }
    if (status.lockoutUntil > 0 && status.lockoutUntil <= Date.now()) {
      status.count = 0;
      status.lockoutUntil = 0;
    }
    return {
      locked: false
    };
  }
  isTooFrequent(ip) {
    const status = this.getIpStatus(ip);
    const minInterval = CONFIG.LOGIN_MIN_INTERVAL || 1e3;
    const now = Date.now();
    if (now - status.lastAttempt < minInterval) {
      return true;
    }
    status.lastAttempt = now;
    return false;
  }
  recordFailure(ip) {
    const status = this.getIpStatus(ip);
    status.count++;
    const maxAttempts = CONFIG.LOGIN_MAX_ATTEMPTS || 5;
    const lockoutDuration = (CONFIG.LOGIN_LOCKOUT_DURATION || 1800) * 1e3;
    if (status.count >= maxAttempts) {
      status.lockoutUntil = Date.now() + lockoutDuration;
      logger.warn(`[Auth] IP ${ip} locked out due to too many failed login attempts (${status.count})`);
      return true;
    }
    return false;
  }
  reset(ip) {
    this.attempts.delete(ip);
  }
}

const loginAttemptManager = new LoginAttemptManager;

export async function cleanupExpiredTokens() {
  const tokenStore = await readTokenStore();
  const now = Date.now();
  let hasChanges = false;
  for (const token in tokenStore.tokens) {
    if (now > tokenStore.tokens[token].expiryTime) {
      delete tokenStore.tokens[token];
      hasChanges = true;
    }
  }
  if (hasChanges) {
    await writeTokenStore(tokenStore);
  }
}

export async function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.substring(7);
  const tokenInfo = await verifyToken(token);
  return tokenInfo !== null;
}

export async function handleLoginRequest(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: false,
      message: "Only POST requests are supported",
      messageCode: "login.error.postOnly"
    }));
    return true;
  }
  const ip = getClientIp(req);
  const lockout = loginAttemptManager.isLockedOut(ip);
  if (lockout.locked) {
    logger.warn(`[Auth] Login attempt from locked IP: ${ip}, reason: account_locked, remaining: ${lockout.remainingTime}s`);
    res.writeHead(429, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: false,
      message: `Account temporarily locked due to too many failed attempts. Please try again in ${lockout.remainingTime} seconds.`,
      messageCode: "login.error.locked",
      messageParams: {
        time: lockout.remainingTime
      }
    }));
    return true;
  }
  if (loginAttemptManager.isTooFrequent(ip)) {
    logger.warn(`[Auth] Login attempt too frequent from IP: ${ip}, reason: rate_limit`);
    res.writeHead(429, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: false,
      message: "Too many requests, please slow down.",
      messageCode: "login.error.tooFrequent"
    }));
    return true;
  }
  try {
    const requestData = await parseRequestBody(req);
    const {password: password} = requestData;
    if (!password) {
      logger.warn(`[Auth] Login failed from IP: ${ip}, reason: empty_password`);
      res.writeHead(400, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: false,
        message: "Password cannot be empty",
        messageCode: "login.error.empty"
      }));
      return true;
    }
    const isValid = await validateCredentials(password);
    if (isValid) {
      logger.info(`[Auth] Login successful from IP: ${ip}`);
      loginAttemptManager.reset(ip);
      const token = generateToken();
      const loginExpiry = CONFIG.LOGIN_EXPIRY || 3600;
      const expiryTime = Date.now() + loginExpiry * 1e3;
      await saveToken(token, {
        username: "admin",
        loginTime: Date.now(),
        expiryTime: expiryTime
      });
      res.writeHead(200, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: true,
        message: "Login successful",
        token: token,
        expiresIn: `${loginExpiry} seconds`
      }));
    } else {
      const isLocked = loginAttemptManager.recordFailure(ip);
      const status = loginAttemptManager.getIpStatus(ip);
      const maxAttempts = CONFIG.LOGIN_MAX_ATTEMPTS || 5;
      const remaining = maxAttempts - status.count;
      const lockoutDuration = CONFIG.LOGIN_LOCKOUT_DURATION || 1800;
      logger.warn(`[Auth] Login failed from IP: ${ip}, reason: incorrect_password, remaining_attempts: ${Math.max(0, remaining)}${isLocked ? ", result: locked" : ""}`);
      res.writeHead(401, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        success: false,
        message: isLocked ? `Неверный пароль. Аккаунт заблокирован на ${Math.ceil(lockoutDuration / 60)} минут.` : `Неверный пароль. Осталось попыток: ${remaining}.`,
        messageCode: isLocked ? "login.error.incorrectWithLock" : "login.error.incorrectWithRemaining",
        messageParams: isLocked ? {
          time: Math.ceil(lockoutDuration / 60)
        } : {
          count: remaining
        }
      }));
    }
  } catch (error) {
    logger.error("[Auth] Login processing error:", error);
    const isJsonError = error.message === "Invalid JSON format";
    res.writeHead(500, {
      "Content-Type": "application/json"
    });
    res.end(JSON.stringify({
      success: false,
      message: error.message || "Server error",
      messageCode: isJsonError ? "login.error.invalidJson" : undefined
    }));
  }
  return true;
}

setInterval(cleanupExpiredTokens, 5 * 60 * 1e3);