import { existsSync } from "fs";

import logger from "../utils/logger.js";

import { promises as fs } from "fs";

import path from "path";

const USAGE_CACHE_FILE = path.join(process.cwd(), "configs", "usage-cache.json");

export async function readUsageCache() {
  try {
    if (existsSync(USAGE_CACHE_FILE)) {
      const content = await fs.readFile(USAGE_CACHE_FILE, "utf8");
      return JSON.parse(content);
    }
    return null;
  } catch (error) {
    logger.warn("[Usage Cache] Failed to read usage cache:", error.message);
    return null;
  }
}

export async function writeUsageCache(usageData) {
  try {
    await fs.writeFile(USAGE_CACHE_FILE, JSON.stringify(usageData, null, 2), "utf8");
    logger.info("[Usage Cache] Usage data cached to", USAGE_CACHE_FILE);
  } catch (error) {
    logger.error("[Usage Cache] Failed to write usage cache:", error.message);
  }
}

export async function readProviderUsageCache(providerType) {
  const cache = await readUsageCache();
  if (cache && cache.providers && cache.providers[providerType]) {
    return {
      ...cache.providers[providerType],
      cachedAt: cache.timestamp,
      fromCache: true
    };
  }
  return null;
}

export async function updateProviderUsageCache(providerType, usageData) {
  let cache = await readUsageCache();
  if (!cache) {
    cache = {
      timestamp: (new Date).toISOString(),
      providers: {}
    };
  }
  cache.providers[providerType] = usageData;
  cache.timestamp = (new Date).toISOString();
  await writeUsageCache(cache);
}