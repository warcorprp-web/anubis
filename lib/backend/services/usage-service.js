import { getProviderPoolManager } from "./service-manager.js";

import { serviceInstances } from "../providers/adapter.js";

import { MODEL_PROVIDER } from "../utils/common.js";

export class UsageService {
  constructor() {
    this.providerHandlers = {
      [MODEL_PROVIDER.KIRO_API]: this.getKiroUsage.bind(this),
      [MODEL_PROVIDER.GEMINI_CLI]: this.getGeminiUsage.bind(this),
      [MODEL_PROVIDER.ANTIGRAVITY]: this.getAntigravityUsage.bind(this),
      [MODEL_PROVIDER.CODEX_API]: this.getCodexUsage.bind(this),
      [MODEL_PROVIDER.GROK_CUSTOM]: this.getGrokUsage.bind(this)
    };
  }
  async getUsage(providerType, uuid = null) {
    const handler = this.providerHandlers[providerType];
    if (!handler) {
      throw new Error(`不支持的提供商类型: ${providerType}`);
    }
    return handler(uuid);
  }
  async getAllUsage() {
    const results = {};
    const poolManager = getProviderPoolManager();
    for (const [providerType, handler] of Object.entries(this.providerHandlers)) {
      try {
        if (poolManager) {
          const pools = poolManager.getProviderPools(providerType);
          if (pools && pools.length > 0) {
            results[providerType] = [];
            for (const pool of pools) {
              try {
                const usage = await handler(pool.uuid);
                results[providerType].push({
                  uuid: pool.uuid,
                  usage: usage
                });
              } catch (error) {
                results[providerType].push({
                  uuid: pool.uuid,
                  error: error.message
                });
              }
            }
          }
        }
        if (!results[providerType] || results[providerType].length === 0) {
          const usage = await handler(null);
          results[providerType] = [ {
            uuid: "default",
            usage: usage
          } ];
        }
      } catch (error) {
        results[providerType] = [ {
          uuid: "default",
          error: error.message
        } ];
      }
    }
    return results;
  }
  async getKiroUsage(uuid = null) {
    const providerKey = uuid ? MODEL_PROVIDER.KIRO_API + uuid : MODEL_PROVIDER.KIRO_API;
    const adapter = serviceInstances[providerKey];
    if (!adapter) {
      throw new Error(`Kiro 服务实例未找到: ${providerKey}`);
    }
    if (typeof adapter.getUsageLimits === "function") {
      return adapter.getUsageLimits();
    }
    if (adapter.kiroApiService && typeof adapter.kiroApiService.getUsageLimits === "function") {
      return adapter.kiroApiService.getUsageLimits();
    }
    throw new Error(`Kiro 服务实例不支持用量查询: ${providerKey}`);
  }
  async getGeminiUsage(uuid = null) {
    const providerKey = uuid ? MODEL_PROVIDER.GEMINI_CLI + uuid : MODEL_PROVIDER.GEMINI_CLI;
    const adapter = serviceInstances[providerKey];
    if (!adapter) {
      throw new Error(`Gemini CLI 服务实例未找到: ${providerKey}`);
    }
    if (typeof adapter.getUsageLimits === "function") {
      return adapter.getUsageLimits();
    }
    if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === "function") {
      return adapter.geminiApiService.getUsageLimits();
    }
    throw new Error(`Gemini CLI 服务实例不支持用量查询: ${providerKey}`);
  }
  async getAntigravityUsage(uuid = null) {
    const providerKey = uuid ? MODEL_PROVIDER.ANTIGRAVITY + uuid : MODEL_PROVIDER.ANTIGRAVITY;
    const adapter = serviceInstances[providerKey];
    if (!adapter) {
      throw new Error(`Antigravity 服务实例未找到: ${providerKey}`);
    }
    if (typeof adapter.getUsageLimits === "function") {
      return adapter.getUsageLimits();
    }
    if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === "function") {
      return adapter.antigravityApiService.getUsageLimits();
    }
    throw new Error(`Antigravity 服务实例不支持用量查询: ${providerKey}`);
  }
  async getCodexUsage(uuid = null) {
    const providerKey = uuid ? MODEL_PROVIDER.CODEX_API + uuid : MODEL_PROVIDER.CODEX_API;
    const adapter = serviceInstances[providerKey];
    if (!adapter) {
      throw new Error(`Codex 服务实例未找到: ${providerKey}`);
    }
    if (typeof adapter.getUsageLimits === "function") {
      return adapter.getUsageLimits();
    }
    if (adapter.codexApiService && typeof adapter.codexApiService.getUsageLimits === "function") {
      return adapter.codexApiService.getUsageLimits();
    }
    throw new Error(`Codex 服务实例不支持用量查询: ${providerKey}`);
  }
  async getGrokUsage(uuid = null) {
    const providerKey = uuid ? MODEL_PROVIDER.GROK_CUSTOM + uuid : MODEL_PROVIDER.GROK_CUSTOM;
    const adapter = serviceInstances[providerKey];
    if (!adapter) {
      throw new Error(`Grok 服务实例未找到: ${providerKey}`);
    }
    if (typeof adapter.getUsageLimits === "function") {
      const rawUsage = await adapter.getUsageLimits();
      return formatGrokUsage(rawUsage);
    }
    throw new Error(`Grok 服务实例不支持用量查询: ${providerKey}`);
  }
  getSupportedProviders() {
    return Object.keys(this.providerHandlers);
  }
}

export const usageService = new UsageService;

export function formatKiroUsage(usageData) {
  if (!usageData) {
    return null;
  }
  const result = {
    daysUntilReset: usageData.daysUntilReset,
    nextDateReset: usageData.nextDateReset ? new Date(usageData.nextDateReset * 1e3).toISOString() : null,
    subscription: null,
    user: null,
    usageBreakdown: []
  };
  if (usageData.subscriptionInfo) {
    result.subscription = {
      title: usageData.subscriptionInfo.subscriptionTitle,
      type: usageData.subscriptionInfo.type,
      upgradeCapability: usageData.subscriptionInfo.upgradeCapability,
      overageCapability: usageData.subscriptionInfo.overageCapability
    };
  }
  if (usageData.userInfo) {
    result.user = {
      email: usageData.userInfo.email,
      userId: usageData.userInfo.userId
    };
  }
  if (usageData.usageBreakdownList && Array.isArray(usageData.usageBreakdownList)) {
    for (const breakdown of usageData.usageBreakdownList) {
      const item = {
        resourceType: breakdown.resourceType,
        displayName: breakdown.displayName,
        displayNamePlural: breakdown.displayNamePlural,
        unit: breakdown.unit,
        currency: breakdown.currency,
        currentUsage: breakdown.currentUsageWithPrecision ?? breakdown.currentUsage,
        usageLimit: breakdown.usageLimitWithPrecision ?? breakdown.usageLimit,
        currentOverages: breakdown.currentOveragesWithPrecision ?? breakdown.currentOverages,
        overageCap: breakdown.overageCapWithPrecision ?? breakdown.overageCap,
        overageRate: breakdown.overageRate,
        overageCharges: breakdown.overageCharges,
        nextDateReset: breakdown.nextDateReset ? new Date(breakdown.nextDateReset * 1e3).toISOString() : null,
        freeTrial: null,
        bonuses: []
      };
      if (breakdown.freeTrialInfo) {
        item.freeTrial = {
          status: breakdown.freeTrialInfo.freeTrialStatus,
          currentUsage: breakdown.freeTrialInfo.currentUsageWithPrecision ?? breakdown.freeTrialInfo.currentUsage,
          usageLimit: breakdown.freeTrialInfo.usageLimitWithPrecision ?? breakdown.freeTrialInfo.usageLimit,
          expiresAt: breakdown.freeTrialInfo.freeTrialExpiry ? new Date(breakdown.freeTrialInfo.freeTrialExpiry * 1e3).toISOString() : null
        };
      }
      if (breakdown.bonuses && Array.isArray(breakdown.bonuses)) {
        for (const bonus of breakdown.bonuses) {
          item.bonuses.push({
            code: bonus.bonusCode,
            displayName: bonus.displayName,
            description: bonus.description,
            status: bonus.status,
            currentUsage: bonus.currentUsage,
            usageLimit: bonus.usageLimit,
            redeemedAt: bonus.redeemedAt ? new Date(bonus.redeemedAt * 1e3).toISOString() : null,
            expiresAt: bonus.expiresAt ? new Date(bonus.expiresAt * 1e3).toISOString() : null
          });
        }
      }
      result.usageBreakdown.push(item);
    }
  }
  return result;
}

export function formatGeminiUsage(usageData) {
  if (!usageData) {
    return null;
  }
  const result = {
    daysUntilReset: null,
    nextDateReset: null,
    subscription: {
      title: "Gemini CLI OAuth",
      type: "gemini-cli-oauth",
      upgradeCapability: null,
      overageCapability: null
    },
    user: {
      email: null,
      userId: null
    },
    usageBreakdown: []
  };
  if (usageData.quotaInfo) {
    result.subscription.title = usageData.quotaInfo.currentTier || "Gemini CLI OAuth";
    if (usageData.quotaInfo.quotaResetTime) {
      result.nextDateReset = usageData.quotaInfo.quotaResetTime;
      const resetDate = new Date(usageData.quotaInfo.quotaResetTime);
      const now = new Date;
      const diffTime = resetDate.getTime() - now.getTime();
      result.daysUntilReset = Math.ceil(diffTime / (1e3 * 60 * 60 * 24));
    }
  }
  if (usageData.models && typeof usageData.models === "object") {
    for (const [modelKey, modelInfo] of Object.entries(usageData.models)) {
      const remainingPercent = typeof modelInfo.remaining === "number" ? modelInfo.remaining : 1;
      const usedPercent = 1 - remainingPercent;
      const [modelId, tokenType] = modelKey.split(":");
      const displayName = tokenType ? `${modelId} (${tokenType})` : modelId;
      const item = {
        resourceType: "MODEL_USAGE",
        displayName: displayName,
        displayNamePlural: displayName,
        unit: "quota",
        currency: null,
        currentUsage: Math.round(usedPercent * 100),
        usageLimit: 100,
        currentOverages: 0,
        overageCap: 0,
        overageRate: null,
        overageCharges: 0,
        nextDateReset: modelInfo.resetTimeRaw ? new Date(modelInfo.resetTimeRaw).toISOString() : modelInfo.resetTime ? new Date(modelInfo.resetTime).toISOString() : null,
        freeTrial: null,
        bonuses: [],
        modelName: modelId,
        tokenType: tokenType,
        inputTokenLimit: modelInfo.inputTokenLimit || 0,
        outputTokenLimit: modelInfo.outputTokenLimit || 0,
        remaining: remainingPercent,
        remainingPercent: Math.round(remainingPercent * 100),
        resetTime: modelInfo.resetTime || "--",
        resetTimeRaw: modelInfo.resetTimeRaw || modelInfo.resetTime || null
      };
      result.usageBreakdown.push(item);
    }
  }
  return result;
}

export function formatAntigravityUsage(usageData) {
  if (!usageData) {
    return null;
  }
  const result = {
    daysUntilReset: null,
    nextDateReset: null,
    subscription: {
      title: "Gemini Antigravity",
      type: "gemini-antigravity",
      upgradeCapability: null,
      overageCapability: null
    },
    user: {
      email: null,
      userId: null
    },
    usageBreakdown: []
  };
  if (usageData.quotaInfo) {
    result.subscription.title = usageData.quotaInfo.currentTier || "Gemini Antigravity";
    if (usageData.quotaInfo.quotaResetTime) {
      result.nextDateReset = usageData.quotaInfo.quotaResetTime;
      const resetDate = new Date(usageData.quotaInfo.quotaResetTime);
      const now = new Date;
      const diffTime = resetDate.getTime() - now.getTime();
      result.daysUntilReset = Math.ceil(diffTime / (1e3 * 60 * 60 * 24));
    }
  }
  if (usageData.models && typeof usageData.models === "object") {
    for (const [modelName, modelInfo] of Object.entries(usageData.models)) {
      const remainingPercent = typeof modelInfo.remaining === "number" ? modelInfo.remaining : 1;
      const usedPercent = 1 - remainingPercent;
      const resetTimeRaw = modelInfo.resetTimeRaw || (usageData.quotaInfo ? usageData.quotaInfo.quotaResetTime : null);
      const resetTimeFormatted = modelInfo.resetTime || "--";
      const item = {
        resourceType: "MODEL_USAGE",
        displayName: modelInfo.displayName || modelName,
        displayNamePlural: modelInfo.displayName || modelName,
        unit: "quota",
        currency: null,
        currentUsage: Math.round(usedPercent * 100 * 100) / 100,
        usageLimit: 100,
        currentOverages: 0,
        overageCap: 0,
        overageRate: null,
        overageCharges: 0,
        nextDateReset: resetTimeRaw ? typeof resetTimeRaw === "number" ? new Date(resetTimeRaw * 1e3).toISOString() : new Date(resetTimeRaw).toISOString() : null,
        freeTrial: null,
        bonuses: [],
        modelName: modelName,
        inputTokenLimit: modelInfo.inputTokenLimit || 0,
        outputTokenLimit: modelInfo.outputTokenLimit || 0,
        remaining: remainingPercent,
        remainingPercent: Math.round(remainingPercent * 100 * 100) / 100,
        resetTime: resetTimeFormatted,
        resetTimeRaw: resetTimeRaw
      };
      result.usageBreakdown.push(item);
    }
  }
  return result;
}

export function formatGrokUsage(usageData) {
  if (!usageData) {
    return null;
  }
  const result = {
    daysUntilReset: null,
    nextDateReset: null,
    subscription: {
      title: "Grok Custom",
      type: "grok-custom",
      upgradeCapability: null,
      overageCapability: null
    },
    user: {
      email: null,
      userId: null
    },
    usageBreakdown: []
  };
  if (usageData.totalLimit !== undefined && usageData.usedQueries !== undefined) {
    const isTokens = usageData.unit === "tokens";
    const item = {
      resourceType: "TOKEN_USAGE",
      displayName: isTokens ? "Remaining Tokens" : "Remaining Queries",
      displayNamePlural: isTokens ? "Remaining Tokens" : "Remaining Queries",
      unit: usageData.unit || "queries",
      currency: null,
      currentUsage: usageData.usedQueries,
      usageLimit: usageData.totalLimit,
      nextDateReset: null,
      freeTrial: null,
      bonuses: []
    };
    result.usageBreakdown.push(item);
  } else if (usageData.remainingTokens !== undefined) {
    const item = {
      resourceType: "TOKEN_USAGE",
      displayName: "Remaining Tokens",
      displayNamePlural: "Remaining Tokens",
      unit: "tokens",
      currency: null,
      currentUsage: 0,
      usageLimit: usageData.remainingTokens,
      nextDateReset: null,
      freeTrial: null,
      bonuses: []
    };
    result.usageBreakdown.push(item);
  }
  return result;
}

export function formatCodexUsage(usageData) {
  if (!usageData) {
    return null;
  }
  const result = {
    daysUntilReset: null,
    nextDateReset: null,
    subscription: {
      title: usageData.raw?.planType ? `Codex (${usageData.raw.planType})` : "Codex OAuth",
      type: "openai-codex-oauth",
      upgradeCapability: null,
      overageCapability: null
    },
    user: {
      email: null,
      userId: null
    },
    usageBreakdown: []
  };
  if (usageData.raw?.rateLimit?.primaryWindow?.resetAt) {
    const resetTimestamp = usageData.raw.rateLimit.primaryWindow.resetAt;
    result.nextDateReset = new Date(resetTimestamp * 1e3).toISOString();
    const resetDate = new Date(resetTimestamp * 1e3);
    const now = new Date;
    const diffTime = resetDate.getTime() - now.getTime();
    result.daysUntilReset = Math.ceil(diffTime / (1e3 * 60 * 60 * 24));
  }
  if (usageData.models && typeof usageData.models === "object") {
    for (const [modelName, modelInfo] of Object.entries(usageData.models)) {
      const remainingPercent = typeof modelInfo.remaining === "number" ? modelInfo.remaining : 1;
      const usedPercent = 1 - remainingPercent;
      const item = {
        resourceType: "MODEL_USAGE",
        displayName: modelInfo.displayName || modelName,
        displayNamePlural: modelInfo.displayName || modelName,
        unit: "quota",
        currency: null,
        currentUsage: Math.round(usedPercent * 100),
        usageLimit: 100,
        currentOverages: 0,
        overageCap: 0,
        overageRate: null,
        overageCharges: 0,
        nextDateReset: modelInfo.resetTimeRaw ? new Date(modelInfo.resetTimeRaw * 1e3).toISOString() : modelInfo.resetTime ? new Date(modelInfo.resetTime).toISOString() : null,
        freeTrial: null,
        bonuses: [],
        modelName: modelName,
        remaining: remainingPercent,
        remainingPercent: Math.round(remainingPercent * 100),
        resetTime: modelInfo.resetTime || "--",
        resetTimeRaw: modelInfo.resetTimeRaw || modelInfo.resetTime || null,
        rateLimit: usageData.raw?.rateLimit
      };
      result.usageBreakdown.push(item);
    }
  }
  return result;
}