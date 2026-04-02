import { promises as fs } from "fs";

import logger from "../../utils/logger.js";

import { existsSync, readFileSync, writeFileSync } from "fs";

import path from "path";

import crypto from "crypto";

const KEYS_STORE_FILE = path.join(process.cwd(), "configs", "api-potluck-keys.json");

const KEY_PREFIX = "maki_";

const DEFAULT_CONFIG = {
  defaultDailyLimit: 500,
  persistInterval: 5e3
};

let configGetter = null;

export function setConfigGetter(getter) {
  configGetter = getter;
}

function getConfig() {
  if (configGetter) {
    return configGetter();
  }
  return DEFAULT_CONFIG;
}

let keyStore = null;

let isDirty = false;

let isWriting = false;

let persistTimer = null;

let currentPersistInterval = DEFAULT_CONFIG.persistInterval;

function ensureLoaded() {
  if (keyStore !== null) return;
  try {
    if (existsSync(KEYS_STORE_FILE)) {
      const content = readFileSync(KEYS_STORE_FILE, "utf8");
      keyStore = JSON.parse(content);
    } else {
      keyStore = {
        keys: {}
      };
      syncWriteToFile();
    }
  } catch (error) {
    logger.error("[API Potluck] Failed to load key store:", error.message);
    keyStore = {
      keys: {}
    };
  }
  const config = getConfig();
  currentPersistInterval = config.persistInterval || DEFAULT_CONFIG.persistInterval;
  if (!persistTimer) {
    persistTimer = setInterval(persistIfDirty, currentPersistInterval);
    process.on("beforeExit", () => persistIfDirty());
    process.on("SIGINT", () => {
      persistIfDirty();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      persistIfDirty();
      process.exit(0);
    });
  }
}

function syncWriteToFile() {
  try {
    const dir = path.dirname(KEYS_STORE_FILE);
    if (!existsSync(dir)) {
      require("fs").mkdirSync(dir, {
        recursive: true
      });
    }
    writeFileSync(KEYS_STORE_FILE, JSON.stringify(keyStore, null, 2), "utf8");
  } catch (error) {
    logger.error("[API Potluck] Sync write failed:", error.message);
  }
}

async function persistIfDirty() {
  if (!isDirty || isWriting || keyStore === null) return;
  isWriting = true;
  try {
    const dir = path.dirname(KEYS_STORE_FILE);
    if (!existsSync(dir)) {
      await fs.mkdir(dir, {
        recursive: true
      });
    }
    const tempFile = KEYS_STORE_FILE + ".tmp";
    await fs.writeFile(tempFile, JSON.stringify(keyStore, null, 2), "utf8");
    await fs.rename(tempFile, KEYS_STORE_FILE);
    isDirty = false;
  } catch (error) {
    logger.error("[API Potluck] Persist failed:", error.message);
  } finally {
    isWriting = false;
  }
}

function markDirty() {
  isDirty = true;
}

function generateApiKey() {
  ensureLoaded();
  let apiKey;
  let attempts = 0;
  const maxAttempts = 10;
  do {
    apiKey = `${KEY_PREFIX}${crypto.randomBytes(16).toString("hex")}`;
    attempts++;
    if (attempts >= maxAttempts) {
      throw new Error("Failed to generate unique API key after multiple attempts");
    }
  } while (keyStore.keys[apiKey]);
  return apiKey;
}

function getTodayDateString() {
  const now = new Date;
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function checkAndResetDailyCount(keyData) {
  const today = getTodayDateString();
  if (keyData.lastResetDate !== today) {
    keyData.todayUsage = 0;
    keyData.lastResetDate = today;
  }
  return keyData;
}

export async function createKey(name = "", dailyLimit = null) {
  ensureLoaded();
  const config = getConfig();
  const actualDailyLimit = dailyLimit ?? config.defaultDailyLimit ?? DEFAULT_CONFIG.defaultDailyLimit;
  const apiKey = generateApiKey();
  const now = (new Date).toISOString();
  const today = getTodayDateString();
  const keyData = {
    id: apiKey,
    name: name || `Key-${Object.keys(keyStore.keys).length + 1}`,
    createdAt: now,
    dailyLimit: actualDailyLimit,
    todayUsage: 0,
    totalUsage: 0,
    lastResetDate: today,
    lastUsedAt: null,
    enabled: true
  };
  keyStore.keys[apiKey] = keyData;
  markDirty();
  await persistIfDirty();
  logger.info(`[API Potluck] Created key: ${apiKey.substring(0, 12)}...`);
  return keyData;
}

export async function listKeys() {
  ensureLoaded();
  const keys = [];
  for (const [keyId, keyData] of Object.entries(keyStore.keys)) {
    const updated = checkAndResetDailyCount({
      ...keyData
    });
    keys.push({
      ...updated,
      maskedKey: `${keyId.substring(0, 12)}...${keyId.substring(keyId.length - 4)}`
    });
  }
  return keys;
}

export async function getKey(keyId) {
  ensureLoaded();
  const keyData = keyStore.keys[keyId];
  if (!keyData) return null;
  return checkAndResetDailyCount({
    ...keyData
  });
}

export async function deleteKey(keyId) {
  ensureLoaded();
  if (!keyStore.keys[keyId]) return false;
  delete keyStore.keys[keyId];
  markDirty();
  await persistIfDirty();
  logger.info(`[API Potluck] Deleted key: ${keyId.substring(0, 12)}...`);
  return true;
}

export async function updateKeyLimit(keyId, newLimit) {
  ensureLoaded();
  if (!keyStore.keys[keyId]) return null;
  keyStore.keys[keyId].dailyLimit = newLimit;
  markDirty();
  return keyStore.keys[keyId];
}

export async function resetKeyUsage(keyId) {
  ensureLoaded();
  if (!keyStore.keys[keyId]) return null;
  keyStore.keys[keyId].todayUsage = 0;
  keyStore.keys[keyId].lastResetDate = getTodayDateString();
  markDirty();
  return keyStore.keys[keyId];
}

export async function toggleKey(keyId) {
  ensureLoaded();
  if (!keyStore.keys[keyId]) return null;
  keyStore.keys[keyId].enabled = !keyStore.keys[keyId].enabled;
  markDirty();
  return keyStore.keys[keyId];
}

export async function updateKeyName(keyId, newName) {
  ensureLoaded();
  if (!keyStore.keys[keyId]) return null;
  keyStore.keys[keyId].name = newName;
  markDirty();
  return keyStore.keys[keyId];
}

export async function regenerateKey(oldKeyId) {
  ensureLoaded();
  const oldKeyData = keyStore.keys[oldKeyId];
  if (!oldKeyData) return null;
  const newKeyId = generateApiKey();
  const newKeyData = {
    ...oldKeyData,
    id: newKeyId,
    regeneratedAt: (new Date).toISOString(),
    regeneratedFrom: oldKeyId.substring(0, 12) + "..."
  };
  delete keyStore.keys[oldKeyId];
  keyStore.keys[newKeyId] = newKeyData;
  markDirty();
  await persistIfDirty();
  logger.info(`[API Potluck] Regenerated key: ${oldKeyId.substring(0, 12)}... -> ${newKeyId.substring(0, 12)}...`);
  return {
    oldKey: oldKeyId,
    newKey: newKeyId,
    keyData: newKeyData
  };
}

export async function validateKey(apiKey) {
  ensureLoaded();
  if (!apiKey || !apiKey.startsWith(KEY_PREFIX)) {
    return {
      valid: false,
      reason: "invalid_format"
    };
  }
  const keyData = keyStore.keys[apiKey];
  if (!keyData) return {
    valid: false,
    reason: "not_found"
  };
  if (!keyData.enabled) return {
    valid: false,
    reason: "disabled"
  };
  checkAndResetDailyCount(keyData);
  if (keyData.todayUsage < keyData.dailyLimit) {
    return {
      valid: true,
      keyData: keyData
    };
  }
  return {
    valid: false,
    reason: "quota_exceeded",
    keyData: keyData
  };
}

export async function incrementUsage(apiKey, provider = "unknown", model = "unknown") {
  ensureLoaded();
  const keyData = keyStore.keys[apiKey];
  if (!keyData) return null;
  checkAndResetDailyCount(keyData);
  if (keyData.todayUsage < keyData.dailyLimit) {
    keyData.todayUsage += 1;
  } else {
    return null;
  }
  keyData.totalUsage += 1;
  keyData.lastUsedAt = (new Date).toISOString();
  const today = getTodayDateString();
  if (!keyData.usageHistory) keyData.usageHistory = {};
  if (!keyData.usageHistory[today]) {
    keyData.usageHistory[today] = {
      providers: {},
      models: {}
    };
  }
  const pName = String(provider || "unknown");
  const mName = String(model || "unknown");
  const userHistory = keyData.usageHistory[today];
  userHistory.providers[pName] = (userHistory.providers[pName] || 0) + 1;
  userHistory.models[mName] = (userHistory.models[mName] || 0) + 1;
  const userDates = Object.keys(keyData.usageHistory).sort();
  if (userDates.length > 7) {
    const dropDates = userDates.slice(0, userDates.length - 7);
    dropDates.forEach(d => delete keyData.usageHistory[d]);
  }
  markDirty();
  return {
    ...keyData,
    usedBonus: false
  };
}

export async function getStats() {
  ensureLoaded();
  const keys = Object.values(keyStore.keys);
  let enabledKeys = 0, todayTotalUsage = 0, totalUsage = 0;
  const aggregatedHistory = {};
  for (const key of keys) {
    checkAndResetDailyCount(key);
    if (key.enabled) enabledKeys++;
    todayTotalUsage += key.todayUsage;
    totalUsage += key.totalUsage;
    if (key.usageHistory) {
      Object.entries(key.usageHistory).forEach(([date, history]) => {
        if (!aggregatedHistory[date]) {
          aggregatedHistory[date] = {
            providers: {},
            models: {}
          };
        }
        if (history.providers) {
          Object.entries(history.providers).forEach(([p, count]) => {
            aggregatedHistory[date].providers[p] = (aggregatedHistory[date].providers[p] || 0) + count;
          });
        }
        if (history.models) {
          Object.entries(history.models).forEach(([m, count]) => {
            aggregatedHistory[date].models[m] = (aggregatedHistory[date].models[m] || 0) + count;
          });
        }
      });
    }
  }
  return {
    totalKeys: keys.length,
    enabledKeys: enabledKeys,
    disabledKeys: keys.length - enabledKeys,
    todayTotalUsage: todayTotalUsage,
    totalUsage: totalUsage,
    usageHistory: aggregatedHistory
  };
}

export async function applyDailyLimitToAllKeys(newLimit) {
  ensureLoaded();
  const keys = Object.values(keyStore.keys);
  let updated = 0;
  for (const keyData of keys) {
    if (keyData.dailyLimit !== newLimit) {
      keyData.dailyLimit = newLimit;
      updated++;
    }
  }
  if (updated > 0) {
    markDirty();
    await persistIfDirty();
  }
  logger.info(`[API Potluck] Applied daily limit ${newLimit} to ${updated}/${keys.length} keys`);
  return {
    total: keys.length,
    updated: updated
  };
}

export function getAllKeyIds() {
  ensureLoaded();
  return Object.keys(keyStore.keys);
}

export { KEY_PREFIX };