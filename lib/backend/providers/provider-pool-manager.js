import * as fs from "fs";

import { getServiceAdapter, getRegisteredProviders } from "./adapter.js";

import logger from "../utils/logger.js";

import { MODEL_PROVIDER, getProtocolPrefix } from "../utils/common.js";

import { getProviderModels } from "./provider-models.js";

import { broadcastEvent } from "../ui-modules/event-broadcast.js";

import { convertData } from "../convert/convert.js";

import { ENDPOINT_TYPE } from "../utils/common.js";

export class ProviderPoolManager {
  static DEFAULT_HEALTH_CHECK_MODELS={
    "gemini-cli-oauth": "gemini-2.5-flash",
    "gemini-antigravity": "gemini-2.5-flash",
    "openai-custom": "gpt-4o-mini",
    "claude-custom": "claude-3-7-sonnet-20250219",
    "claude-kiro-oauth": "claude-haiku-4-5",
    "openai-qwen-oauth": "qwen3-coder-flash",
    "openai-iflow": "qwen3-coder-plus",
    "openai-codex-oauth": "gpt-5-codex-mini",
    "openaiResponses-custom": "gpt-4o-mini",
    "forward-api": "gpt-4o-mini",
    "deepseek": "deepseek-chat"
  };
  constructor(providerPools, options = {}) {
    this.providerPools = providerPools;
    this.globalConfig = options.globalConfig || {};
    this.providerStatus = {};
    this.roundRobinIndex = {};
    this.maxErrorCount = options.maxErrorCount ?? 10;
    this.healthCheckInterval = options.healthCheckInterval ?? 10 * 60 * 1e3;
    this.logLevel = options.logLevel || "info";
    this.saveDebounceTime = options.saveDebounceTime || 1e3;
    this.saveTimer = null;
    this.pendingSaves = new Set;
    this.fallbackChain = options.globalConfig?.providerFallbackChain || {};
    this.modelFallbackMapping = options.globalConfig?.modelFallbackMapping || {};
    this._selectionLocks = {};
    this._isSelecting = {};
    this.refreshConcurrency = {
      global: options.globalConfig?.REFRESH_CONCURRENCY_GLOBAL ?? 2,
      perProvider: options.globalConfig?.REFRESH_CONCURRENCY_PER_PROVIDER ?? 1
    };
    this.activeProviderRefreshes = 0;
    this.globalRefreshWaiters = [];
    this.warmupTarget = options.globalConfig?.WARMUP_TARGET || 0;
    this.refreshingUuids = new Set;
    this.refreshQueues = {};
    this.refreshBufferQueues = {};
    this.refreshBufferTimers = {};
    this.bufferDelay = options.globalConfig?.REFRESH_BUFFER_DELAY ?? 5e3;
    this._selectionSequence = 0;
    this.initializeProviderStatus();
  }
  async checkAndRefreshExpiringNodes() {
    this._log("info", "Checking nodes for approaching expiration dates using provider adapters...");
    for (const providerType in this.providerStatus) {
      const providers = this.providerStatus[providerType];
      for (const providerStatus of providers) {
        const config = providerStatus.config;
        let configPath = null;
        if (providerType.startsWith("claude-kiro")) {
          configPath = config.KIRO_OAUTH_CREDS_FILE_PATH;
        } else if (providerType.startsWith("gemini-cli")) {
          configPath = config.GEMINI_OAUTH_CREDS_FILE_PATH;
        } else if (providerType.startsWith("gemini-antigravity")) {
          configPath = config.ANTIGRAVITY_OAUTH_CREDS_FILE_PATH;
        } else if (providerType.startsWith("openai-qwen")) {
          configPath = config.QWEN_OAUTH_CREDS_FILE_PATH;
        } else if (providerType.startsWith("openai-iflow")) {
          configPath = config.IFLOW_OAUTH_CREDS_FILE_PATH;
        } else if (providerType.startsWith("openai-codex")) {
          configPath = config.CODEX_OAUTH_CREDS_FILE_PATH;
        }
        if (!config.isHealthy || config.isDisabled) continue;
        if (configPath && fs.existsSync(configPath)) {
          try {
            if (true) {
              this._log("warn", `Node ${providerStatus.uuid} (${providerType}) is near expiration. Enqueuing refresh...`);
              this._enqueueRefresh(providerType, providerStatus);
            }
          } catch (err) {
            this._log("error", `Failed to check expiry for node ${providerStatus.uuid}: ${err.message}`);
          }
        } else {
          this._log("debug", `Node ${providerStatus.uuid} (${providerType}) has no valid config file path or file does not exist.`);
        }
      }
    }
  }
  async warmupNodes() {
    if (this.warmupTarget <= 0) return;
    this._log("info", `Starting system warmup (Group Target: ${this.warmupTarget} nodes per provider)...`);
    const nodesToWarmup = [];
    for (const type in this.providerStatus) {
      const pool = this.providerStatus[type];
      const candidates = pool.filter(p => p.config.isHealthy && !p.config.isDisabled && !this.refreshingUuids.has(p.uuid)).sort((a, b) => {
        if (a.config.needsRefresh && !b.config.needsRefresh) return -1;
        if (!a.config.needsRefresh && b.config.needsRefresh) return 1;
        const scoreA = this._calculateNodeScore(a);
        const scoreB = this._calculateNodeScore(b);
        return scoreA - scoreB;
      }).slice(0, this.warmupTarget);
      candidates.forEach(p => nodesToWarmup.push({
        type: type,
        status: p
      }));
    }
    this._log("info", `Warmup: Selected total ${nodesToWarmup.length} nodes across all providers to refresh.`);
    for (const node of nodesToWarmup) {
      this._enqueueRefresh(node.type, node.status, true);
    }
  }
  _enqueueRefresh(providerType, providerStatus, force = false) {
    const uuid = providerStatus.uuid;
    if (this.refreshingUuids.has(uuid)) {
      this._log("debug", `Node ${uuid} is already in refresh queue.`);
      return;
    }
    const healthyCount = this.getHealthyCount(providerType);
    if (healthyCount < 5) {
      this._log("info", `Provider ${providerType} has only ${healthyCount} healthy nodes. Bypassing buffer and enqueuing refresh for ${uuid} immediately.`);
      this._enqueueRefreshImmediate(providerType, providerStatus, force);
      return;
    }
    if (!this.refreshBufferQueues[providerType]) {
      this.refreshBufferQueues[providerType] = new Map;
    }
    const bufferQueue = this.refreshBufferQueues[providerType];
    const existing = bufferQueue.get(uuid);
    const isNewEntry = !existing;
    bufferQueue.set(uuid, {
      providerStatus: providerStatus,
      force: existing ? existing.force || force : force
    });
    if (isNewEntry) {
      this._log("debug", `Node ${uuid} added to buffer queue for ${providerType}. Buffer size: ${bufferQueue.size}`);
    } else {
      this._log("debug", `Node ${uuid} already in buffer queue, updated force flag. Buffer size: ${bufferQueue.size}`);
    }
    if (isNewEntry || !this.refreshBufferTimers[providerType]) {
      if (this.refreshBufferTimers[providerType]) {
        clearTimeout(this.refreshBufferTimers[providerType]);
      }
      this.refreshBufferTimers[providerType] = setTimeout(() => {
        this._flushRefreshBuffer(providerType);
      }, this.bufferDelay);
    }
  }
  _flushRefreshBuffer(providerType) {
    const bufferQueue = this.refreshBufferQueues[providerType];
    if (!bufferQueue || bufferQueue.size === 0) {
      return;
    }
    this._log("info", `Flushing refresh buffer for ${providerType}. Processing ${bufferQueue.size} unique nodes.`);
    for (const [uuid, {providerStatus: providerStatus, force: force}] of bufferQueue.entries()) {
      this._enqueueRefreshImmediate(providerType, providerStatus, force);
    }
    bufferQueue.clear();
    delete this.refreshBufferTimers[providerType];
  }
  _enqueueRefreshImmediate(providerType, providerStatus, force = false) {
    const uuid = providerStatus.uuid;
    if (this.refreshingUuids.has(uuid)) {
      this._log("debug", `Node ${uuid} is already in refresh queue (immediate check).`);
      return;
    }
    this.refreshingUuids.add(uuid);
    if (!this.refreshQueues[providerType]) {
      this.refreshQueues[providerType] = {
        activeCount: 0,
        waitingTasks: []
      };
    }
    const queue = this.refreshQueues[providerType];
    const runTask = async () => {
      try {
        await this._refreshNodeToken(providerType, providerStatus, force);
      } catch (err) {
        this._log("error", `Failed to process refresh for node ${uuid}: ${err.message}`);
      } finally {
        this.refreshingUuids.delete(uuid);
        const currentQueue = this.refreshQueues[providerType];
        if (!currentQueue) return;
        currentQueue.activeCount--;
        if (currentQueue.waitingTasks.length > 0) {
          const nextTask = currentQueue.waitingTasks.shift();
          currentQueue.activeCount++;
          Promise.resolve().then(nextTask);
        } else if (currentQueue.activeCount === 0) {
          if (currentQueue.waitingTasks.length === 0 && this.refreshQueues[providerType] === currentQueue) {
            this.activeProviderRefreshes--;
            delete this.refreshQueues[providerType];
          }
          if (this.globalRefreshWaiters.length > 0) {
            const nextProviderStart = this.globalRefreshWaiters.shift();
            Promise.resolve().then(nextProviderStart);
          }
        }
      }
    };
    const tryStartProviderQueue = () => {
      if (queue.activeCount < this.refreshConcurrency.perProvider) {
        queue.activeCount++;
        runTask();
      } else {
        queue.waitingTasks.push(runTask);
      }
    };
    if (this.refreshQueues[providerType].activeCount > 0) {
      tryStartProviderQueue();
    } else if (this.activeProviderRefreshes < this.refreshConcurrency.global) {
      this.activeProviderRefreshes++;
      tryStartProviderQueue();
    } else {
      this.globalRefreshWaiters.push(() => {
        if (!this.refreshQueues[providerType]) {
          this.refreshQueues[providerType] = {
            activeCount: 0,
            waitingTasks: []
          };
        }
        this.activeProviderRefreshes++;
        tryStartProviderQueue();
      });
    }
  }
  async _refreshNodeToken(providerType, providerStatus, force = false) {
    const config = providerStatus.config;
    const currentRefreshCount = config.refreshCount || 0;
    if (currentRefreshCount >= 5 && !force) {
      this._log("warn", `Node ${providerStatus.uuid} has reached maximum refresh count (5), marking as unhealthy`);
      this.markProviderUnhealthyImmediately(providerType, config, "Maximum refresh count (5) reached");
      return;
    }
    try {
      config.refreshCount = currentRefreshCount + 1;
      const tempConfig = {
        ...this.globalConfig,
        ...config,
        MODEL_PROVIDER: providerType
      };
      const serviceAdapter = getServiceAdapter(tempConfig);
      if (typeof serviceAdapter.refreshToken === "function") {
        const startTime = Date.now();
        force ? await serviceAdapter.forceRefreshToken() : await serviceAdapter.refreshToken();
        const duration = Date.now() - startTime;
        this._log("info", `Token refresh successful for node ${providerStatus.uuid} (Duration: ${duration}ms)`);
        config.needsRefresh = false;
        config.refreshCount = 0;
        config.lastRefreshTime = Date.now();
      } else {
        throw new Error(`refreshToken method not implemented for ${providerType}`);
      }
    } catch (error) {
      this._log("error", `Token refresh failed for node ${providerStatus.uuid}: ${error.message}`);
      this.markProviderUnhealthyImmediately(providerType, config, `Refresh failed: ${error.message}`);
      throw error;
    }
  }
  _calculateNodeScore(providerStatus, now = Date.now(), minSeqInPool = -1) {
    const config = providerStatus.config;
    const state = providerStatus.state;
    if (!config.isHealthy || config.isDisabled) return 1e18;
    const concurrencyLimit = parseInt(config.concurrencyLimit || 0);
    const queueLimit = parseInt(config.queueLimit || 0);
    if (concurrencyLimit > 0) {
      if (state.activeCount >= concurrencyLimit) {
        if (queueLimit > 0 && state.waitingCount >= queueLimit) {
          return 1e17;
        }
        return 1e15 + (state.waitingCount || 0) * 1e10;
      }
    }
    const lastHealthCheckTime = config.lastHealthCheckTime ? new Date(config.lastHealthCheckTime).getTime() : 0;
    const isFresh = lastHealthCheckTime && now - lastHealthCheckTime < 6e4;
    const lastUsedTime = config.lastUsed ? new Date(config.lastUsed).getTime() : now - 864e5;
    const baseScore = isFresh ? -1e14 : lastUsedTime;
    const usageCount = config.usageCount || 0;
    const usageScore = usageCount * 1e4;
    const lastSelectionSeq = config._lastSelectionSeq || 0;
    if (minSeqInPool === -1) {
      const pool = this.providerStatus[providerStatus.type] || [];
      minSeqInPool = Math.min(...pool.map(p => p.config._lastSelectionSeq || 0));
    }
    const relativeSeq = Math.max(0, lastSelectionSeq - minSeqInPool);
    const cappedRelativeSeq = Math.min(relativeSeq, 100);
    const sequenceScore = cappedRelativeSeq * 1e3;
    const loadScore = (state.activeCount || 0) * 5e3;
    const freshBonus = isFresh ? now - lastHealthCheckTime : 0;
    return baseScore + usageScore + sequenceScore + loadScore + freshBonus;
  }
  getHealthyCount(providerType) {
    return (this.providerStatus[providerType] || []).filter(p => p.config.isHealthy && !p.config.isDisabled).length;
  }
  _log(level, message) {
    const levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3
    };
    if (levels[level] >= levels[this.logLevel]) {
      logger[level](`[ProviderPoolManager] ${message}`);
    }
  }
  _logHealthStatusChange(providerType, providerConfig, fromStatus, toStatus, errorMessage = null) {
    const customName = providerConfig.customName || providerConfig.uuid;
    const timestamp = (new Date).toISOString();
    const logEntry = {
      timestamp: timestamp,
      providerType: providerType,
      uuid: providerConfig.uuid,
      customName: customName,
      fromStatus: fromStatus,
      toStatus: toStatus,
      errorMessage: errorMessage,
      usageCount: providerConfig.usageCount || 0,
      errorCount: providerConfig.errorCount || 0
    };
    if (toStatus === "unhealthy") {
      logger.warn(`[HealthMonitor] ⚠️ Provider became UNHEALTHY: ${customName} (${providerType})`);
      logger.warn(`[HealthMonitor]    Reason: ${errorMessage || "Unknown"}`);
      logger.warn(`[HealthMonitor]    Error Count: ${providerConfig.errorCount}`);
      this._triggerHealthAlert(providerType, providerConfig, "unhealthy", errorMessage);
    } else if (toStatus === "healthy" && fromStatus === "unhealthy") {
      logger.info(`[HealthMonitor] ✅ Provider recovered to HEALTHY: ${customName} (${providerType})`);
      this._triggerHealthAlert(providerType, providerConfig, "recovered", null);
    }
    broadcastEvent("health_status_change", logEntry);
  }
  async _triggerHealthAlert(providerType, providerConfig, status, errorMessage = null) {
    const webhookUrl = this.globalConfig?.HEALTH_ALERT_WEBHOOK_URL;
    if (!webhookUrl) {
      return;
    }
    const customName = providerConfig.customName || providerConfig.uuid;
    const payload = {
      timestamp: (new Date).toISOString(),
      providerType: providerType,
      uuid: providerConfig.uuid,
      customName: customName,
      status: status,
      errorMessage: errorMessage,
      stats: {
        usageCount: providerConfig.usageCount || 0,
        errorCount: providerConfig.errorCount || 0
      }
    };
    try {
      const axios = (await import("axios")).default;
      await axios.post(webhookUrl, payload, {
        timeout: 5e3,
        headers: {
          "Content-Type": "application/json"
        }
      });
      this._log("info", `Health alert sent to webhook for ${customName}: ${status}`);
    } catch (error) {
      this._log("error", `Failed to send health alert to webhook: ${error.message}`);
    }
  }
  _findProvider(providerType, uuid) {
    if (!providerType || !uuid) {
      this._log("error", `Invalid parameters: providerType=${providerType}, uuid=${uuid}`);
      return null;
    }
    const pool = this.providerStatus[providerType];
    return pool?.find(p => p.uuid === uuid) || null;
  }
  findProviderByUuid(uuid) {
    if (!uuid) return null;
    for (const type in this.providerStatus) {
      const provider = this.providerStatus[type].find(p => p.uuid === uuid);
      if (provider) return provider.config;
    }
    return null;
  }
  initializeProviderStatus() {
    for (const providerType in this.providerPools) {
      const oldStatus = this.providerStatus[providerType] || [];
      this.providerStatus[providerType] = [];
      this.roundRobinIndex[providerType] = 0;
      if (!this._selectionLocks[providerType]) {
        this._selectionLocks[providerType] = Promise.resolve();
      }
      this.providerPools[providerType].forEach(providerConfig => {
        const existing = oldStatus.find(p => p.uuid === providerConfig.uuid);
        providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
        providerConfig.isDisabled = providerConfig.isDisabled !== undefined ? providerConfig.isDisabled : false;
        providerConfig.lastUsed = providerConfig.lastUsed !== undefined ? providerConfig.lastUsed : null;
        providerConfig.usageCount = providerConfig.usageCount !== undefined ? providerConfig.usageCount : 0;
        providerConfig.errorCount = providerConfig.errorCount !== undefined ? providerConfig.errorCount : 0;
        providerConfig.needsRefresh = providerConfig.needsRefresh !== undefined ? providerConfig.needsRefresh : false;
        providerConfig.refreshCount = providerConfig.refreshCount !== undefined ? providerConfig.refreshCount : 0;
        providerConfig.lastErrorTime = providerConfig.lastErrorTime instanceof Date ? providerConfig.lastErrorTime.toISOString() : providerConfig.lastErrorTime || null;
        providerConfig.lastHealthCheckTime = providerConfig.lastHealthCheckTime || null;
        providerConfig.lastHealthCheckModel = providerConfig.lastHealthCheckModel || null;
        providerConfig.lastErrorMessage = providerConfig.lastErrorMessage || null;
        providerConfig.customName = providerConfig.customName || null;
        this.providerStatus[providerType].push({
          config: providerConfig,
          uuid: providerConfig.uuid,
          type: providerType,
          state: existing ? existing.state : {
            activeCount: 0,
            waitingCount: 0,
            queue: []
          }
        });
      });
    }
    this._log("info", `Initialized provider statuses: ok (maxErrorCount: ${this.maxErrorCount})`);
    this._log("info", `[Init] providerStatus keys: ${JSON.stringify(Object.keys(this.providerStatus))}`);
  }
  async acquireSlot(providerType, requestedModel = null, options = {}) {
    const selectedConfig = await this.selectProvider(providerType, requestedModel, {
      ...options,
      skipUsageCount: true
    });
    if (!selectedConfig) {
      return null;
    }
    const provider = this._findProvider(providerType, selectedConfig.uuid);
    if (!provider) return selectedConfig;
    const config = provider.config;
    const state = provider.state;
    const concurrencyLimit = parseInt(config.concurrencyLimit || 0);
    const queueLimit = parseInt(config.queueLimit || 0);
    if (concurrencyLimit <= 0) {
      state.activeCount++;
      return config;
    }
    if (state.activeCount < concurrencyLimit) {
      state.activeCount++;
      return config;
    }
    if (queueLimit > 0 && state.waitingCount < queueLimit) {
      this._log("info", `[Concurrency] Node ${config.uuid} busy (${state.activeCount}/${concurrencyLimit}), enqueuing request (queue: ${state.waitingCount + 1}/${queueLimit})`);
      state.waitingCount++;
      try {
        await new Promise((resolve, reject) => {
          const timeoutMs = options.queueTimeout || 3e5;
          const timeout = setTimeout(() => {
            const idx = state.queue.indexOf(handler);
            if (idx !== -1) {
              state.queue.splice(idx, 1);
              reject(new Error(`Queue timeout after ${timeoutMs / 1e3}s`));
            }
          }, timeoutMs);
          const handler = () => {
            clearTimeout(timeout);
            resolve();
          };
          state.queue.push(handler);
        });
      } finally {
        state.waitingCount--;
      }
      state.activeCount++;
      return config;
    }
    this._log("warn", `[Concurrency] Node ${config.uuid} full capacity (${state.activeCount}/${concurrencyLimit}, queue: ${state.waitingCount}/${queueLimit}), returning 429`);
    const error = new Error("Too many requests: account concurrency limit and queue reached");
    error.status = 429;
    error.code = 429;
    throw error;
  }
  releaseSlot(providerType, uuid) {
    if (!providerType || !uuid) return;
    const provider = this._findProvider(providerType, uuid);
    if (!provider) return;
    const state = provider.state;
    if (state.activeCount > 0) {
      state.activeCount--;
    }
    if (state.queue && state.queue.length > 0) {
      const next = state.queue.shift();
      if (next) {
        setImmediate(next);
      }
    }
  }
  async selectProvider(providerType, requestedModel = null, options = {}) {
    if (!providerType || typeof providerType !== "string") {
      this._log("error", `Invalid providerType: ${providerType}`);
      return null;
    }
    while (this._isSelecting[providerType]) {
      await new Promise(resolve => setImmediate(resolve));
    }
    this._isSelecting[providerType] = true;
    try {
      return this._doSelectProvider(providerType, requestedModel, options);
    } finally {
      this._isSelecting[providerType] = false;
    }
  }
  _doSelectProvider(providerType, requestedModel, options) {
    const availableProviders = this.providerStatus[providerType] || [];
    this._checkAndRecoverScheduledProviders(providerType);
    const now = Date.now();
    const minSeq = Math.min(...availableProviders.map(p => p.config._lastSelectionSeq || 0));
    let availableAndHealthyProviders = availableProviders.filter(p => p.config.isHealthy && !p.config.isDisabled && !p.config.needsRefresh);
    if (requestedModel) {
      const modelFilteredProviders = availableAndHealthyProviders.filter(p => {
        if (!p.config.notSupportedModels || !Array.isArray(p.config.notSupportedModels)) {
          return true;
        }
        return !p.config.notSupportedModels.includes(requestedModel);
      });
      if (modelFilteredProviders.length === 0) {
        this._log("warn", `No available providers for type: ${providerType} that support model: ${requestedModel}`);
        return null;
      }
      availableAndHealthyProviders = modelFilteredProviders;
      this._log("debug", `Filtered ${modelFilteredProviders.length} providers supporting model: ${requestedModel}`);
    }
    if (availableAndHealthyProviders.length === 0) {
      this._log("warn", `No available and healthy providers for type: ${providerType}`);
      return null;
    }
    const selected = availableAndHealthyProviders.sort((a, b) => {
      const scoreA = this._calculateNodeScore(a, now, minSeq);
      const scoreB = this._calculateNodeScore(b, now, minSeq);
      if (scoreA !== scoreB) return scoreA - scoreB;
      return a.uuid < b.uuid ? -1 : 1;
    })[0];
    selected.config.lastUsed = (new Date).toISOString();
    this._selectionSequence++;
    selected.config._lastSelectionSeq = this._selectionSequence;
    this._log("info", `[Concurrency Control] Atomic selection: ${selected.config.uuid} (Seq: ${this._selectionSequence})`);
    if (!options.skipUsageCount) {
      selected.config.usageCount++;
    }
    this._debouncedSave(providerType);
    this._log("debug", `Selected provider for ${providerType} (LRU): ${selected.config.uuid}${requestedModel ? ` for model: ${requestedModel}` : ""}${options.skipUsageCount ? " (skip usage count)" : ""}`);
    return selected.config;
  }
  async acquireSlotWithFallback(providerType, requestedModel = null, options = {}) {
    if (!providerType || typeof providerType !== "string") {
      this._log("error", `Invalid providerType: ${providerType}`);
      return null;
    }
    const triedTypes = new Set;
    const typesToTry = [ providerType ];
    const fallbackTypes = this.fallbackChain[providerType] || [];
    if (Array.isArray(fallbackTypes)) {
      typesToTry.push(...fallbackTypes);
    }
    for (const currentType of typesToTry) {
      if (triedTypes.has(currentType)) continue;
      triedTypes.add(currentType);
      if (!this.providerStatus[currentType] || this.providerStatus[currentType].length === 0) {
        continue;
      }
      if (currentType !== providerType && requestedModel) {
        const primaryProtocol = getProtocolPrefix(providerType);
        const fallbackProtocol = getProtocolPrefix(currentType);
        if (primaryProtocol !== fallbackProtocol) continue;
        const supportedModels = getProviderModels(currentType);
        if (supportedModels.length > 0 && !supportedModels.includes(requestedModel)) continue;
      }
      try {
        const selectedConfig = await this.acquireSlot(currentType, requestedModel, options);
        if (selectedConfig) {
          if (currentType !== providerType) {
            this._log("info", `Fallback Slot activated (Chain): ${providerType} -> ${currentType} (uuid: ${selectedConfig.uuid})`);
          }
          return {
            config: selectedConfig,
            actualProviderType: currentType,
            isFallback: currentType !== providerType
          };
        }
      } catch (err) {
        if (err.status === 429) {
          this._log("info", `Type ${currentType} busy (429), trying next fallback...`);
          continue;
        }
        throw err;
      }
    }
    if (requestedModel && this.modelFallbackMapping && this.modelFallbackMapping[requestedModel]) {
      const mapping = this.modelFallbackMapping[requestedModel];
      const targetProviderType = mapping.targetProviderType;
      const targetModel = mapping.targetModel;
      if (targetProviderType && targetModel) {
        if (this.providerStatus[targetProviderType] && this.providerStatus[targetProviderType].length > 0) {
          try {
            const selectedConfig = await this.acquireSlot(targetProviderType, targetModel, options);
            if (selectedConfig) {
              return {
                config: selectedConfig,
                actualProviderType: targetProviderType,
                isFallback: true,
                actualModel: targetModel
              };
            }
          } catch (err) {
            const targetFallbackTypes = this.fallbackChain[targetProviderType] || [];
            for (const fallbackType of targetFallbackTypes) {
              const targetProtocol = getProtocolPrefix(targetProviderType);
              const fallbackProtocol = getProtocolPrefix(fallbackType);
              if (targetProtocol !== fallbackProtocol) continue;
              const supportedModels = getProviderModels(fallbackType);
              if (supportedModels.length > 0 && !supportedModels.includes(targetModel)) continue;
              try {
                const fallbackSelectedConfig = await this.acquireSlot(fallbackType, targetModel, options);
                if (fallbackSelectedConfig) {
                  return {
                    config: fallbackSelectedConfig,
                    actualProviderType: fallbackType,
                    isFallback: true,
                    actualModel: targetModel
                  };
                }
              } catch (e) {
                continue;
              }
            }
          }
        }
      }
    }
    return null;
  }
  async selectProviderWithFallback(providerType, requestedModel = null, options = {}) {
    if (!providerType || typeof providerType !== "string") {
      this._log("error", `Invalid providerType: ${providerType}`);
      return null;
    }
    const triedTypes = new Set;
    const typesToTry = [ providerType ];
    const fallbackTypes = this.fallbackChain[providerType] || [];
    if (Array.isArray(fallbackTypes)) {
      typesToTry.push(...fallbackTypes);
    }
    for (const currentType of typesToTry) {
      if (triedTypes.has(currentType)) {
        continue;
      }
      triedTypes.add(currentType);
      if (!this.providerStatus[currentType] || this.providerStatus[currentType].length === 0) {
        this._log("debug", `No provider pool configured for type: ${currentType}`);
        continue;
      }
      if (currentType !== providerType && requestedModel) {
        const primaryProtocol = getProtocolPrefix(providerType);
        const fallbackProtocol = getProtocolPrefix(currentType);
        if (primaryProtocol !== fallbackProtocol) {
          this._log("debug", `Skipping fallback type ${currentType}: protocol mismatch (${primaryProtocol} vs ${fallbackProtocol})`);
          continue;
        }
        const supportedModels = getProviderModels(currentType);
        if (supportedModels.length > 0 && !supportedModels.includes(requestedModel)) {
          this._log("debug", `Skipping fallback type ${currentType}: model ${requestedModel} not supported`);
          continue;
        }
      }
      const selectedConfig = await this.selectProvider(currentType, requestedModel, options);
      if (selectedConfig) {
        if (currentType !== providerType) {
          this._log("info", `Fallback activated (Chain): ${providerType} -> ${currentType} (uuid: ${selectedConfig.uuid})`);
        }
        return {
          config: selectedConfig,
          actualProviderType: currentType,
          isFallback: currentType !== providerType
        };
      }
    }
    if (requestedModel && this.modelFallbackMapping && this.modelFallbackMapping[requestedModel]) {
      const mapping = this.modelFallbackMapping[requestedModel];
      const targetProviderType = mapping.targetProviderType;
      const targetModel = mapping.targetModel;
      if (targetProviderType && targetModel) {
        this._log("info", `Trying Model Fallback Mapping for ${requestedModel}: -> ${targetProviderType} (${targetModel})`);
        if (this.providerStatus[targetProviderType] && this.providerStatus[targetProviderType].length > 0) {
          const selectedConfig = await this.selectProvider(targetProviderType, targetModel, options);
          if (selectedConfig) {
            this._log("info", `Fallback activated (Model Mapping): ${providerType} (${requestedModel}) -> ${targetProviderType} (${targetModel}) (uuid: ${selectedConfig.uuid})`);
            return {
              config: selectedConfig,
              actualProviderType: targetProviderType,
              isFallback: true,
              actualModel: targetModel
            };
          } else {
            const targetFallbackTypes = this.fallbackChain[targetProviderType] || [];
            for (const fallbackType of targetFallbackTypes) {
              const targetProtocol = getProtocolPrefix(targetProviderType);
              const fallbackProtocol = getProtocolPrefix(fallbackType);
              if (targetProtocol !== fallbackProtocol) continue;
              const supportedModels = getProviderModels(fallbackType);
              if (supportedModels.length > 0 && !supportedModels.includes(targetModel)) continue;
              const fallbackSelectedConfig = await this.selectProvider(fallbackType, targetModel, options);
              if (fallbackSelectedConfig) {
                this._log("info", `Fallback activated (Model Mapping -> Chain): ${providerType} (${requestedModel}) -> ${targetProviderType} -> ${fallbackType} (${targetModel}) (uuid: ${fallbackSelectedConfig.uuid})`);
                return {
                  config: fallbackSelectedConfig,
                  actualProviderType: fallbackType,
                  isFallback: true,
                  actualModel: targetModel
                };
              }
            }
          }
        } else {
          this._log("warn", `Model Fallback target provider ${targetProviderType} not configured or empty.`);
        }
      }
    }
    this._log("warn", `None available provider found for ${providerType} (Model: ${requestedModel}) after checking fallback chain and model mapping.`);
    return null;
  }
  getFallbackChain(providerType) {
    return this.fallbackChain[providerType] || [];
  }
  setFallbackChain(providerType, fallbackTypes) {
    if (!Array.isArray(fallbackTypes)) {
      this._log("error", `Invalid fallbackTypes: must be an array`);
      return;
    }
    this.fallbackChain[providerType] = fallbackTypes;
    this._log("info", `Updated fallback chain for ${providerType}: ${fallbackTypes.join(" -> ")}`);
  }
  isAllProvidersUnhealthy(providerType) {
    const providers = this.providerStatus[providerType] || [];
    if (providers.length === 0) {
      return true;
    }
    return providers.every(p => !p.config.isHealthy || p.config.isDisabled);
  }
  getProviderStats(providerType) {
    const providers = this.providerStatus[providerType] || [];
    const stats = {
      total: providers.length,
      healthy: 0,
      unhealthy: 0,
      disabled: 0
    };
    for (const p of providers) {
      if (p.config.isDisabled) {
        stats.disabled++;
      } else if (p.config.isHealthy) {
        stats.healthy++;
      } else {
        stats.unhealthy++;
      }
    }
    return stats;
  }
  async getAllAvailableModels(endpointType = null) {
    const allModels = [];
    const registeredProviders = getRegisteredProviders();
    const allProviderTypes = Array.from(new Set([ ...registeredProviders ]));
    this._log("info", `[Models] registeredProviders = ${JSON.stringify(registeredProviders)}`);
    this._log("info", `[Models] providerStatus keys = ${JSON.stringify(Object.keys(this.providerStatus))}`);
    for (const providerType of allProviderTypes) {
      if (this.providerStatus[providerType]) {
        let models = getProviderModels(providerType);
        if (models.length === 0) {
          try {
            let targetConfig = this.globalConfig;
            if (this.providerStatus[providerType] && this.providerStatus[providerType].length > 0) {
              targetConfig = this.providerStatus[providerType][0].config;
            }
            const tempConfig = {
              ...this.globalConfig,
              ...targetConfig,
              MODEL_PROVIDER: providerType
            };
            const serviceAdapter = getServiceAdapter(tempConfig);
            if (typeof serviceAdapter.listModels === "function") {
              const nativeModels = await serviceAdapter.listModels();
              const convertedData = convertData(nativeModels, "modelList", providerType, MODEL_PROVIDER.OPENAI_CUSTOM);
              if (convertedData && Array.isArray(convertedData.data)) {
                const fetchedModels = convertedData.data.map(m => m.id);
                if (fetchedModels.length > 0) {
                  models = fetchedModels;
                }
              }
            }
          } catch (err) {
            this._log("debug", `Failed to fetch model list for ${providerType} from service: ${err.message}`);
          }
        }
        for (const model of models) {
          allModels.push({
            id: `${providerType}:${model}`,
            provider: providerType,
            model: model
          });
        }
      }
    }
    if (!endpointType) {
      return allModels;
    }
    if (endpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
      return {
        object: "list",
        data: allModels.map(m => ({
          id: m.id,
          object: "model",
          created: Math.floor(Date.now() / 1e3),
          owned_by: m.provider
        }))
      };
    } else if (endpointType === ENDPOINT_TYPE.GEMINI_MODEL_LIST) {
      return {
        models: allModels.map(m => ({
          name: `models/${m.id}`,
          baseModelId: m.model,
          version: "v1",
          displayName: `${m.model} (${m.provider})`,
          description: `Model ${m.model} provided by ${m.provider}`,
          supportedGenerationMethods: [ "generateContent", "countTokens" ]
        }))
      };
    }
    return {
      data: []
    };
  }
  markProviderNeedRefresh(providerType, providerConfig) {
    if (!providerConfig?.uuid) {
      this._log("error", "Invalid providerConfig in markProviderNeedRefresh");
      return;
    }
    const provider = this._findProvider(providerType, providerConfig.uuid);
    if (provider) {
      if (this.refreshingUuids.has(provider.uuid)) {
        this._log("debug", `Provider ${providerConfig.uuid} is already in refresh queue, ignoring duplicate request.`);
        return;
      }
      const now = Date.now();
      const lastRefreshTime = provider.config.lastRefreshTime || 0;
      if (now - lastRefreshTime < 3e4) {
        this._log("info", `Provider ${providerConfig.uuid} was refreshed recently (${Math.round((now - lastRefreshTime) / 1e3)}s ago), ignoring refresh request.`);
        return;
      }
      provider.config.needsRefresh = true;
      this._log("info", `Marked provider ${providerConfig.uuid} as needsRefresh. Enqueuing...`);
      this._enqueueRefresh(providerType, provider, true);
      this._debouncedSave(providerType);
    }
  }
  markProviderUnhealthy(providerType, providerConfig, errorMessage = null) {
    if (!providerConfig?.uuid) {
      this._log("error", "Invalid providerConfig in markProviderUnhealthy");
      return;
    }
    const provider = this._findProvider(providerType, providerConfig.uuid);
    if (provider) {
      const wasHealthy = provider.config.isHealthy;
      const now = Date.now();
      const lastErrorTime = provider.config.lastErrorTime ? new Date(provider.config.lastErrorTime).getTime() : 0;
      const errorWindowMs = 1e4;
      if (now - lastErrorTime > errorWindowMs) {
        provider.config.errorCount = 1;
      } else {
        provider.config.errorCount++;
      }
      provider.config.lastErrorTime = (new Date).toISOString();
      provider.config.lastUsed = (new Date).toISOString();
      provider.config.needsRefresh = false;
      provider.config.refreshCount = 0;
      if (errorMessage) {
        provider.config.lastErrorMessage = errorMessage;
      }
      if (this.maxErrorCount > 0 && provider.config.errorCount >= this.maxErrorCount) {
        provider.config.isHealthy = false;
        if (wasHealthy) {
          this._logHealthStatusChange(providerType, provider.config, "healthy", "unhealthy", errorMessage);
        }
        this._log("warn", `Marked provider as unhealthy: ${providerConfig.uuid} for type ${providerType}. Total errors: ${provider.config.errorCount}`);
      }
      this._debouncedSave(providerType);
    }
  }
  markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage = null) {
    if (!providerConfig?.uuid) {
      this._log("error", "Invalid providerConfig in markProviderUnhealthyImmediately");
      return;
    }
    const provider = this._findProvider(providerType, providerConfig.uuid);
    if (provider) {
      const wasHealthy = provider.config.isHealthy;
      provider.config.isHealthy = false;
      provider.config.needsRefresh = false;
      provider.config.refreshCount = 0;
      provider.config.errorCount = this.maxErrorCount;
      provider.config.lastErrorTime = (new Date).toISOString();
      provider.config.lastUsed = (new Date).toISOString();
      if (errorMessage) {
        provider.config.lastErrorMessage = errorMessage;
      }
      if (wasHealthy) {
        this._logHealthStatusChange(providerType, provider.config, "healthy", "unhealthy", errorMessage);
      }
      this._log("warn", `Immediately marked provider as unhealthy: ${providerConfig.uuid} for type ${providerType}. Reason: ${errorMessage || "Authentication error"}`);
      this._debouncedSave(providerType);
    }
  }
  markProviderUnhealthyWithRecoveryTime(providerType, providerConfig, errorMessage = null, recoveryTime = null) {
    if (!providerConfig?.uuid) {
      this._log("error", "Invalid providerConfig in markProviderUnhealthyWithRecoveryTime");
      return;
    }
    const provider = this._findProvider(providerType, providerConfig.uuid);
    if (provider) {
      provider.config.isHealthy = false;
      provider.config.needsRefresh = false;
      provider.config.refreshCount = 0;
      provider.config.errorCount = this.maxErrorCount;
      provider.config.lastErrorTime = (new Date).toISOString();
      provider.config.lastUsed = (new Date).toISOString();
      if (errorMessage) {
        provider.config.lastErrorMessage = errorMessage;
      }
      if (recoveryTime) {
        const recoveryDate = recoveryTime instanceof Date ? recoveryTime : new Date(recoveryTime);
        provider.config.scheduledRecoveryTime = recoveryDate.toISOString();
        this._log("warn", `Marked provider as unhealthy with recovery time: ${providerConfig.uuid} for type ${providerType}. Recovery at: ${recoveryDate.toISOString()}. Reason: ${errorMessage || "Quota exhausted"}`);
      } else {
        this._log("warn", `Marked provider as unhealthy: ${providerConfig.uuid} for type ${providerType}. Reason: ${errorMessage || "Quota exhausted"}`);
      }
      this._debouncedSave(providerType);
    }
  }
  markProviderHealthy(providerType, providerConfig, resetUsageCount = false, healthCheckModel = null) {
    if (!providerConfig?.uuid) {
      this._log("error", "Invalid providerConfig in markProviderHealthy");
      return;
    }
    const provider = this._findProvider(providerType, providerConfig.uuid);
    if (provider) {
      const wasHealthy = provider.config.isHealthy;
      provider.config.isHealthy = true;
      provider.config.errorCount = 0;
      provider.config.refreshCount = 0;
      provider.config.needsRefresh = false;
      provider.config.lastRefreshTime = Date.now();
      provider.config.lastErrorTime = null;
      provider.config.lastErrorMessage = null;
      provider.config._lastSelectionSeq = 0;
      if (healthCheckModel) {
        provider.config.lastHealthCheckTime = (new Date).toISOString();
        provider.config.lastHealthCheckModel = healthCheckModel;
      }
      if (resetUsageCount) {
        provider.config.usageCount = 0;
      } else {
        provider.config.usageCount++;
        provider.config.lastUsed = (new Date).toISOString();
      }
      if (!wasHealthy) {
        this._logHealthStatusChange(providerType, provider.config, "unhealthy", "healthy", null);
      }
      this._log("info", `Marked provider as healthy: ${provider.config.uuid} for type ${providerType}${resetUsageCount ? " (usage count reset)" : ""}`);
      this._debouncedSave(providerType);
    }
  }
  resetProviderRefreshStatus(providerType, uuid) {
    if (!providerType || !uuid) {
      this._log("error", "Invalid parameters in resetProviderRefreshStatus");
      return;
    }
    const provider = this._findProvider(providerType, uuid);
    if (provider) {
      provider.config.needsRefresh = false;
      provider.config.refreshCount = 0;
      provider.config.lastRefreshTime = Date.now();
      provider.config.lastHealthCheckTime = (new Date).toISOString();
      this._log("info", `Reset refresh status and marked healthy for provider ${uuid} (${providerType})`);
      this._debouncedSave(providerType);
    }
  }
  resetProviderCounters(providerType, providerConfig) {
    if (!providerConfig?.uuid) {
      this._log("error", "Invalid providerConfig in resetProviderCounters");
      return;
    }
    const provider = this._findProvider(providerType, providerConfig.uuid);
    if (provider) {
      provider.config.errorCount = 0;
      provider.config.usageCount = 0;
      provider.config._lastSelectionSeq = 0;
      this._log("info", `Reset provider counters: ${provider.config.uuid} for type ${providerType}`);
      this._debouncedSave(providerType);
    }
  }
  disableProvider(providerType, providerConfig) {
    if (!providerConfig?.uuid) {
      this._log("error", "Invalid providerConfig in disableProvider");
      return;
    }
    const provider = this._findProvider(providerType, providerConfig.uuid);
    if (provider) {
      provider.config.isDisabled = true;
      this._log("info", `Disabled provider: ${providerConfig.uuid} for type ${providerType}`);
      this._debouncedSave(providerType);
    }
  }
  enableProvider(providerType, providerConfig) {
    if (!providerConfig?.uuid) {
      this._log("error", "Invalid providerConfig in enableProvider");
      return;
    }
    const provider = this._findProvider(providerType, providerConfig.uuid);
    if (provider) {
      provider.config.isDisabled = false;
      this._log("info", `Enabled provider: ${providerConfig.uuid} for type ${providerType}`);
      this._debouncedSave(providerType);
    }
  }
  refreshProviderUuid(providerType, providerConfig) {
    if (!providerConfig?.uuid) {
      this._log("error", "Invalid providerConfig in refreshProviderUuid");
      return null;
    }
    const provider = this._findProvider(providerType, providerConfig.uuid);
    if (provider) {
      const oldUuid = provider.config.uuid;
      const newUuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === "x" ? r : r & 3 | 8;
        return v.toString(16);
      });
      provider.uuid = newUuid;
      provider.config.uuid = newUuid;
      const poolArray = this.providerPools[providerType];
      if (poolArray) {
        const originalProvider = poolArray.find(p => p.uuid === oldUuid);
        if (originalProvider) {
          originalProvider.uuid = newUuid;
        }
      }
      this._log("info", `Refreshed provider UUID: ${oldUuid} -> ${newUuid} for type ${providerType}`);
      this._debouncedSave(providerType);
      return newUuid;
    }
    this._log("warn", `Provider not found for UUID refresh: ${providerConfig.uuid} in ${providerType}`);
    return null;
  }
  _checkAndRecoverScheduledProviders(providerType = null) {
    const now = new Date;
    const typesToCheck = providerType ? [ providerType ] : Object.keys(this.providerStatus);
    for (const type of typesToCheck) {
      const providers = this.providerStatus[type] || [];
      for (const providerStatus of providers) {
        const config = providerStatus.config;
        if (config.scheduledRecoveryTime && !config.isHealthy) {
          const recoveryTime = new Date(config.scheduledRecoveryTime);
          if (now >= recoveryTime) {
            this._log("info", `Auto-recovering provider ${config.uuid} (${type}). Scheduled recovery time reached: ${recoveryTime.toISOString()}`);
            config.isHealthy = true;
            config.errorCount = 0;
            config.lastErrorTime = null;
            config.lastErrorMessage = null;
            config.scheduledRecoveryTime = null;
            this._debouncedSave(type);
          }
        }
      }
    }
  }
  async performHealthChecks(isInit = false) {
    this._log("info", "Performing health checks on all providers...");
    const now = new Date;
    this._checkAndRecoverScheduledProviders();
    for (const providerType in this.providerStatus) {
      for (const providerStatus of this.providerStatus[providerType]) {
        const providerConfig = providerStatus.config;
        if (providerConfig.scheduledRecoveryTime && !providerConfig.isHealthy) {
          const recoveryTime = new Date(providerConfig.scheduledRecoveryTime);
          if (now < recoveryTime) {
            this._log("debug", `Skipping health check for ${providerConfig.uuid} (${providerType}). Waiting for scheduled recovery at ${recoveryTime.toISOString()}`);
            continue;
          }
        }
        if (!providerStatus.config.isHealthy && providerStatus.config.lastErrorTime && now.getTime() - new Date(providerStatus.config.lastErrorTime).getTime() < this.healthCheckInterval) {
          this._log("debug", `Skipping health check for ${providerConfig.uuid} (${providerType}). Last error too recent.`);
          continue;
        }
        try {
          const healthResult = await this._checkProviderHealth(providerType, providerConfig);
          if (healthResult === null) {
            this._log("debug", `Health check for ${providerConfig.uuid} (${providerType}) skipped: Check not implemented.`);
            this.resetProviderCounters(providerType, providerConfig);
            continue;
          }
          if (healthResult.success) {
            if (!providerStatus.config.isHealthy) {
              this.markProviderHealthy(providerType, providerConfig, true, healthResult.modelName);
              this._log("info", `Health check for ${providerConfig.uuid} (${providerType}): Marked Healthy (actual check)`);
            } else {
              this.markProviderHealthy(providerType, providerConfig, true, healthResult.modelName);
              this._log("debug", `Health check for ${providerConfig.uuid} (${providerType}): Still Healthy`);
            }
          } else {
            this._log("warn", `Health check for ${providerConfig.uuid} (${providerType}) failed: ${healthResult.errorMessage || "Provider is not responding correctly."}`);
            this.markProviderUnhealthy(providerType, providerConfig, healthResult.errorMessage);
            providerStatus.config.lastHealthCheckTime = (new Date).toISOString();
            if (healthResult.modelName) {
              providerStatus.config.lastHealthCheckModel = healthResult.modelName;
            }
          }
        } catch (error) {
          this._log("error", `Health check for ${providerConfig.uuid} (${providerType}) failed: ${error.message}`);
          this.markProviderUnhealthy(providerType, providerConfig, error.message);
        }
      }
    }
  }
  _buildHealthCheckRequests(providerType, modelName) {
    const baseMessage = {
      role: "user",
      content: "Hi"
    };
    const requests = [];
    if (providerType.startsWith("gemini")) {
      requests.push({
        contents: [ {
          role: "user",
          parts: [ {
            text: baseMessage.content
          } ]
        } ]
      });
      return requests;
    }
    if (providerType.startsWith("claude-kiro")) {
      requests.push({
        messages: [ baseMessage ],
        model: modelName,
        max_tokens: 1
      });
      return requests;
    }
    if (providerType === MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES) {
      requests.push({
        input: [ baseMessage ],
        model: modelName
      });
      return requests;
    }
    requests.push({
      messages: [ baseMessage ],
      model: modelName
    });
    return requests;
  }
  async _checkProviderHealth(providerType, providerConfig, forceCheck = false) {
    if (!providerConfig.checkHealth && !forceCheck) {
      return null;
    }
    const modelName = providerConfig.checkModelName || ProviderPoolManager.DEFAULT_HEALTH_CHECK_MODELS[providerType];
    if (!modelName) {
      this._log("warn", `Unknown provider type for health check: ${providerType}. Please check DEFAULT_HEALTH_CHECK_MODELS.`);
      return {
        success: false,
        modelName: null,
        errorMessage: `Unknown provider type '${providerType}'. No default health check model configured.`
      };
    }
    const tempConfig = {
      ...providerConfig,
      MODEL_PROVIDER: providerType
    };
    const serviceAdapter = getServiceAdapter(tempConfig);
    const healthCheckRequests = this._buildHealthCheckRequests(providerType, modelName);
    const healthCheckTimeout = 15e3;
    let lastError = null;
    for (let i = 0; i < healthCheckRequests.length; i++) {
      const healthCheckRequest = healthCheckRequests[i];
      const abortController = new AbortController;
      const timeoutId = setTimeout(() => abortController.abort(), healthCheckTimeout);
      try {
        this._log("debug", `Health check attempt ${i + 1}/${healthCheckRequests.length} for ${modelName}: ${JSON.stringify(healthCheckRequest)}`);
        const requestWithSignal = {
          ...healthCheckRequest
        };
        await serviceAdapter.generateContent(modelName, requestWithSignal);
        clearTimeout(timeoutId);
        return {
          success: true,
          modelName: modelName,
          errorMessage: null
        };
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error;
        this._log("debug", `Health check attempt ${i + 1} failed for ${providerType}: ${error.message}`);
      }
    }
    this._log("error", `Health check failed for ${providerType} after ${healthCheckRequests.length} attempts: ${lastError?.message}`);
    return {
      success: false,
      modelName: modelName,
      errorMessage: lastError?.message || "All health check attempts failed"
    };
  }
  _debouncedSave(providerType) {
    this.pendingSaves.add(providerType);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this._flushPendingSaves();
    }, this.saveDebounceTime);
  }
  async _flushPendingSaves() {
    const typesToSave = Array.from(this.pendingSaves);
    if (typesToSave.length === 0) return;
    this.pendingSaves.clear();
    this.saveTimer = null;
    try {
      const filePath = this.globalConfig.PROVIDER_POOLS_FILE_PATH || "configs/provider_pools.json";
      let currentPools = {};
      try {
        const fileContent = await fs.promises.readFile(filePath, "utf8");
        currentPools = JSON.parse(fileContent);
      } catch (readError) {
        if (readError.code === "ENOENT") {
          this._log("info", "configs/provider_pools.json does not exist, creating new file.");
        } else {
          throw readError;
        }
      }
      for (const providerType of typesToSave) {
        if (this.providerStatus[providerType]) {
          currentPools[providerType] = this.providerStatus[providerType].map(p => {
            const config = {
              ...p.config
            };
            if (config.lastUsed instanceof Date) {
              config.lastUsed = config.lastUsed.toISOString();
            }
            if (config.lastErrorTime instanceof Date) {
              config.lastErrorTime = config.lastErrorTime.toISOString();
            }
            if (config.lastHealthCheckTime instanceof Date) {
              config.lastHealthCheckTime = config.lastHealthCheckTime.toISOString();
            }
            return config;
          });
        } else {
          this._log("warn", `Attempted to save unknown providerType: ${providerType}`);
        }
      }
      await fs.promises.writeFile(filePath, JSON.stringify(currentPools, null, 2), "utf8");
      this._log("info", `configs/provider_pools.json updated successfully for types: ${typesToSave.join(", ")}`);
    } catch (error) {
      this._log("error", `Failed to write provider_pools.json: ${error.message}`);
    }
  }
}