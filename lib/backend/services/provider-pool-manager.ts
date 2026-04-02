/**
 * Manages a pool of API service providers, handling their health and selection.
 * Ported line-by-line from aiclient-2-api/src/providers/provider-pool-manager.js
 */

import { loadProviderPools, saveProviderPools, loadConfig } from '@/lib/storage';
import { getServiceAdapter } from '../providers/adapter';
import logger from '../utils/logger.js';
import type { ProviderConfig } from '@/lib/types';

interface ProviderStatus {
    uuid: string;
    config: ProviderConfig;
}

interface RefreshQueue {
    activeCount: number;
    waitingTasks: Array<() => Promise<void>>;
}

export class ProviderPoolManager {
    // Константы для health check моделей (точь-в-точь как в оригинале)
    static DEFAULT_HEALTH_CHECK_MODELS: Record<string, string> = {
        'gemini-cli-oauth': 'gemini-2.5-flash',
        'gemini-antigravity': 'gemini-2.5-flash',
        'openai-custom': 'gpt-4o-mini',
        'claude-custom': 'claude-3-7-sonnet-20250219',
        'claude-kiro-oauth': 'claude-haiku-4-5',
        'openai-qwen-oauth': 'qwen3-coder-flash',
        'openai-iflow': 'qwen3-coder-plus',
        'openai-codex-oauth': 'gpt-5-codex-mini',
        'openaiResponses-custom': 'gpt-4o-mini',
        'forward-api': 'gpt-4o-mini',
    };

    private providerPools: Record<string, ProviderConfig[]>;
    private globalConfig: any;
    private providerStatus: Record<string, ProviderStatus[]>;
    private roundRobinIndex: Record<string, number>;
    private maxErrorCount: number;
    private healthCheckInterval: number;
    private logLevel: string;
    private saveDebounceTime: number;
    private saveTimer: NodeJS.Timeout | null;
    private pendingSaves: Set<string>;
    private fallbackChain: Record<string, string[]>;
    private modelFallbackMapping: Record<string, Record<string, string>>;
    private _selectionLocks: Record<string, any>;
    private _isSelecting: Record<string, boolean>;
    private refreshConcurrency: { global: number; perProvider: number };
    private activeProviderRefreshes: number;
    private globalRefreshWaiters: Array<() => void>;
    private warmupTarget: number;
    private refreshingUuids: Set<string>;
    private refreshQueues: Record<string, RefreshQueue>;
    private refreshBufferQueues: Record<string, Map<string, { providerStatus: ProviderStatus; force: boolean }>>;
    private refreshBufferTimers: Record<string, NodeJS.Timeout>;
    private bufferDelay: number;
    private _selectionSequence: number;

    constructor(providerPools: Record<string, ProviderConfig[]>, options: any = {}) {
        this.providerPools = providerPools;
        this.globalConfig = options.globalConfig || {};
        this.providerStatus = {};
        this.roundRobinIndex = {};
        this.maxErrorCount = options.maxErrorCount ?? 10;
        this.healthCheckInterval = options.healthCheckInterval ?? 10 * 60 * 1000;
        this.logLevel = options.logLevel || 'info';
        this.saveDebounceTime = options.saveDebounceTime || 1000;
        this.saveTimer = null;
        this.pendingSaves = new Set();
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
        this.refreshingUuids = new Set();
        this.refreshQueues = {};
        this.refreshBufferQueues = {};
        this.refreshBufferTimers = {};
        this.bufferDelay = options.globalConfig?.REFRESH_BUFFER_DELAY ?? 5000;
        this._selectionSequence = 0;

        this.initializeProviderStatus();
    }

    /**
     * Инициализация статусов провайдеров (точь-в-точь как в оригинале)
     */
    private initializeProviderStatus() {
        for (const providerType in this.providerPools) {
            this.providerStatus[providerType] = [];
            this.roundRobinIndex[providerType] = 0;

            const providers = this.providerPools[providerType];
            for (const providerConfig of providers) {
                this.providerStatus[providerType].push({
                    uuid: providerConfig.uuid,
                    config: providerConfig
                });
            }
        }
        this._log('info', `Initialized provider status for ${Object.keys(this.providerStatus).length} provider types.`);
    }

    /**
     * Логирование (точь-в-точь как в оригинале)
     */
    private _log(level: string, message: string, ...args: any[]) {
        const levels = ['debug', 'info', 'warn', 'error'];
        const currentLevelIndex = levels.indexOf(this.logLevel);
        const messageLevelIndex = levels.indexOf(level);

        if (messageLevelIndex >= currentLevelIndex) {
            // Безопасный вызов logger
            try {
                const logMethod = (logger as any)[level] || logger.info;
                logMethod(`[ProviderPoolManager] ${message}`, ...args);
            } catch (error) {
                console.log(`[ProviderPoolManager] ${level.toUpperCase()}: ${message}`, ...args);
            }
        }
    }

    /**
     * Получить количество здоровых провайдеров (точь-в-точь как в оригинале)
     */
    getHealthyCount(providerType: string): number {
        const providers = this.providerStatus[providerType] || [];
        return providers.filter(p => p.config.isHealthy && !p.config.isDisabled).length;
    }

    /**
     * Выбор провайдера (точь-в-точь как в оригинале)
     */
    async selectProvider(providerType: string, requestedModel: string | null = null, options: any = {}): Promise<ProviderConfig | null> {
        // Параметры валидация (точь-в-точь как в оригинале)
        if (!providerType || typeof providerType !== 'string') {
            this._log('error', `Invalid providerType: ${providerType}`);
            return null;
        }

        // Mutex lock для конкурентного доступа (точь-в-точь как в оригинале)
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

    /**
     * Внутренний метод выбора провайдера (точь-в-точь как в оригинале)
     */
    private _doSelectProvider(providerType: string, requestedModel: string | null, options: any): ProviderConfig | null {
        const availableProviders = this.providerStatus[providerType] || [];

        // Проверка и восстановление провайдеров (точь-в-точь как в оригинале)
        this._checkAndRecoverScheduledProviders(providerType);

        const now = Date.now();
        const minSeq = Math.min(...availableProviders.map(p => p.config._lastSelectionSeq || 0));

        let availableAndHealthyProviders = availableProviders.filter(p =>
            p.config.isHealthy && !p.config.isDisabled && !p.config.needsRefresh
        );

        // Фильтрация по модели (точь-в-точь как в оригинале)
        if (requestedModel) {
            // Импортируем getProviderModels (точь-в-точь как в оригинале)
            const { getProviderModels } = require('../providers/provider-models');
            const supportedModels = getProviderModels(providerType);
            
            // Если список моделей пустой - провайдер поддерживает все модели (точь-в-точь как в оригинале)
            if (supportedModels.length > 0 && !supportedModels.includes(requestedModel)) {
                this._log('warn', `Provider ${providerType} does not support model: ${requestedModel}`);
                return null;
            }

            this._log('debug', `Provider ${providerType} supports model: ${requestedModel}`);
        }

        if (availableAndHealthyProviders.length === 0) {
            this._log('warn', `No available and healthy providers for type: ${providerType}`);
            return null;
        }

        // Сортировка по score (точь-в-точь как в оригинале)
        const selected = availableAndHealthyProviders.sort((a, b) => {
            const scoreA = this._calculateNodeScore(a, now, minSeq);
            const scoreB = this._calculateNodeScore(b, now, minSeq);
            if (scoreA !== scoreB) return scoreA - scoreB;
            // Если score одинаковый - сортируем по UUID для детерминизма
            return a.uuid < b.uuid ? -1 : 1;
        })[0];

        // Обновляем lastUsed и sequence (точь-в-точь как в оригинале)
        selected.config.lastUsed = new Date().toISOString();
        this._selectionSequence++;
        selected.config._lastSelectionSeq = this._selectionSequence;

        this._log('info', `[Concurrency Control] Atomic selection: ${selected.config.uuid} (Seq: ${this._selectionSequence})`);

        if (!options.skipUsageCount) {
            selected.config.usageCount = (selected.config.usageCount || 0) + 1;
        }

        this._debouncedSave(providerType);

        this._log('debug', `Selected provider for ${providerType}: ${selected.config.uuid}${requestedModel ? ` for model: ${requestedModel}` : ''}`);

        return selected.config;
    }

    /**
     * Проверка и восстановление провайдеров по расписанию (точь-в-точь как в оригинале)
     */
    private _checkAndRecoverScheduledProviders(providerType: string) {
        const providers = this.providerStatus[providerType] || [];
        const now = new Date();

        for (const provider of providers) {
            if (provider.config.scheduledRecoveryTime && !provider.config.isHealthy) {
                const recoveryTime = new Date(provider.config.scheduledRecoveryTime);
                if (now >= recoveryTime) {
                    this._log('info', `Recovering provider ${provider.uuid} (scheduled recovery time reached)`);
                    provider.config.isHealthy = true;
                    provider.config.errorCount = 0;
                    provider.config.scheduledRecoveryTime = undefined;
                    this._debouncedSave(providerType);
                }
            }
        }
    }

    /**
     * Расчет score для сортировки провайдеров (точь-в-точь как в оригинале)
     */
    private _calculateNodeScore(providerStatus: ProviderStatus, now?: number, minSeq?: number): number {
        const config = providerStatus.config;
        let score = 0;
        const currentTime = now || Date.now();

        // 1. Нездоровые - в конец (точь-в-точь как в оригинале)
        if (!config.isHealthy) score += 1000000;

        // 2. Отключенные - в конец (точь-в-точь как в оригинале)
        if (config.isDisabled) score += 1000000;

        // 3. Нуждающиеся в refresh - в конец (точь-в-точь как в оригинале)
        if (config.needsRefresh) score += 1000000;

        // 4. Количество ошибок (точь-в-точь как в оригинале)
        score += (config.errorCount || 0) * 1000;

        // 5. Количество использований (точь-в-точь как в оригинале)
        score += (config.usageCount || 0);

        // 6. Последнее использование - давно использованные = лучше (точь-в-точь как в оригинале)
        if (config.lastUsed) {
            const timeSinceLastUse = currentTime - new Date(config.lastUsed).getTime();
            score -= timeSinceLastUse / 1000; // Вычитаем секунды
        }

        // 7. Sequence number для разрешения конфликтов (точь-в-точь как в оригинале)
        if (config._lastSelectionSeq !== undefined && minSeq !== undefined) {
            score += (config._lastSelectionSeq - minSeq) * 0.001;
        }

        return score;
    }

    /**
     * Пометить провайдер как нездоровый (точь-в-точь как в оригинале)
     */
    async markProviderUnhealthy(providerType: string, uuid: string, errorMessage: string | null) {
        const provider = this._findProvider(providerType, uuid);
        if (!provider) {
            this._log('error', `Provider not found: ${providerType}/${uuid}`);
            return;
        }

        const now = Date.now();
        const lastErrorTime = provider.config.lastErrorTime ? new Date(provider.config.lastErrorTime).getTime() : 0;
        const ERROR_WINDOW_MS = 10000; // 10 секунд

        // Если > 10 секунд с последней ошибки - сбрасываем счетчик
        if (now - lastErrorTime > ERROR_WINDOW_MS) {
            provider.config.errorCount = 1;
        } else {
            provider.config.errorCount = (provider.config.errorCount || 0) + 1;
        }

        provider.config.lastErrorTime = new Date().toISOString();
        provider.config.lastUsed = new Date().toISOString();

        if (errorMessage) {
            provider.config.lastErrorMessage = errorMessage;
        }

        // Если достигли maxErrorCount (10) - помечаем unhealthy
        if (provider.config.errorCount >= this.maxErrorCount) {
            provider.config.isHealthy = false;
            this._log('warn', `Marked provider as unhealthy: ${uuid} (${providerType})`);
        }

        this._debouncedSave(providerType);
    }

    /**
     * Пометить провайдер как нездоровый немедленно (точь-в-точь как в оригинале)
     */
    async markProviderUnhealthyImmediately(providerType: string, uuid: string, errorMessage: string | null) {
        const provider = this._findProvider(providerType, uuid);
        if (!provider) {
            this._log('error', `Provider not found: ${providerType}/${uuid}`);
            return;
        }

        provider.config.isHealthy = false;
        provider.config.errorCount = this.maxErrorCount; // Сразу максимум
        provider.config.lastErrorTime = new Date().toISOString();
        provider.config.lastUsed = new Date().toISOString();

        if (errorMessage) {
            provider.config.lastErrorMessage = errorMessage;
        }

        this._log('error', `Provider marked unhealthy immediately: ${uuid} (${providerType})`);
        this._debouncedSave(providerType);
    }

    /**
     * Пометить провайдер как здоровый (точь-в-точь как в оригинале)
     */
    async markProviderHealthy(providerType: string, uuid: string, resetUsageCount: boolean = false, healthCheckModel: string | null = null) {
        const provider = this._findProvider(providerType, uuid);
        if (!provider) {
            this._log('error', `Provider not found: ${providerType}/${uuid}`);
            return;
        }

        provider.config.isHealthy = true;
        provider.config.errorCount = 0;
        provider.config.lastErrorMessage = '';
        provider.config.lastHealthCheckTime = new Date().toISOString();

        if (healthCheckModel) {
            provider.config.lastHealthCheckModel = healthCheckModel;
        }

        if (resetUsageCount) {
            provider.config.usageCount = 0;
        }

        this._log('info', `Provider marked healthy: ${uuid} (${providerType})`);
        this._debouncedSave(providerType);
    }

    /**
     * Увеличить счетчик использований (точь-в-точь как в оригинале)
     */
    async incrementProviderUsage(providerType: string, uuid: string) {
        const provider = this._findProvider(providerType, uuid);
        if (!provider) {
            this._log('error', `Provider not found: ${providerType}/${uuid}`);
            return;
        }

        provider.config.usageCount = (provider.config.usageCount || 0) + 1;
        provider.config.lastUsed = new Date().toISOString();

        this._debouncedSave(providerType);
    }

    /**
     * Найти провайдер по UUID (точь-в-точь как в оригинале)
     */
    private _findProvider(providerType: string, uuid: string): ProviderStatus | null {
        const providers = this.providerStatus[providerType] || [];
        return providers.find(p => p.uuid === uuid) || null;
    }

    /**
     * Отложенное сохранение (точь-в-точь как в оригинале)
     */
    private _debouncedSave(providerType: string) {
        this.pendingSaves.add(providerType);

        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }

        this.saveTimer = setTimeout(async () => {
            await this._flushSaves();
        }, this.saveDebounceTime);
    }

    /**
     * Сохранение всех pending изменений (точь-в-точь как в оригинале)
     */
    private async _flushSaves() {
        if (this.pendingSaves.size === 0) return;

        const typesToSave = Array.from(this.pendingSaves);
        this.pendingSaves.clear();

        try {
            // Обновляем pools из providerStatus
            for (const providerType of typesToSave) {
                const statuses = this.providerStatus[providerType] || [];
                this.providerPools[providerType] = statuses.map(s => s.config);
            }

            await saveProviderPools(this.providerPools);
            this._log('debug', `Saved provider pools for: ${typesToSave.join(', ')}`);
        } catch (error: any) {
            this._log('error', `Failed to save provider pools: ${error.message}`);
        }
    }

    /**
     * Добавить в очередь refresh (точь-в-точь как в оригинале)
     */
    private _enqueueRefresh(providerType: string, providerStatus: ProviderStatus, force: boolean = false) {
        const uuid = providerStatus.uuid;

        // Если уже в refresh - пропускаем
        if (this.refreshingUuids.has(uuid)) {
            this._log('debug', `Node ${uuid} is already in refresh queue.`);
            return;
        }

        // Если здоровых < 5 - сразу в очередь без буфера
        const healthyCount = this.getHealthyCount(providerType);
        if (healthyCount < 5) {
            this._log('info', `Provider ${providerType} has only ${healthyCount} healthy nodes. Bypassing buffer.`);
            this._enqueueRefreshImmediate(providerType, providerStatus, force);
            return;
        }

        // Инициализируем буфер
        if (!this.refreshBufferQueues[providerType]) {
            this.refreshBufferQueues[providerType] = new Map();
        }

        const bufferQueue = this.refreshBufferQueues[providerType];
        const existing = bufferQueue.get(uuid);
        const isNewEntry = !existing;

        // Добавляем/обновляем в буфере
        bufferQueue.set(uuid, {
            providerStatus,
            force: existing ? (existing.force || force) : force
        });

        if (isNewEntry) {
            this._log('debug', `Node ${uuid} added to buffer queue. Size: ${bufferQueue.size}`);
        }

        // Устанавливаем таймер на flush буфера
        if (isNewEntry || !this.refreshBufferTimers[providerType]) {
            if (this.refreshBufferTimers[providerType]) {
                clearTimeout(this.refreshBufferTimers[providerType]);
            }

            this.refreshBufferTimers[providerType] = setTimeout(() => {
                this._flushRefreshBuffer(providerType);
            }, this.bufferDelay);
        }
    }

    /**
     * Flush буфера refresh (точь-в-точь как в оригинале)
     */
    private _flushRefreshBuffer(providerType: string) {
        const bufferQueue = this.refreshBufferQueues[providerType];
        if (!bufferQueue || bufferQueue.size === 0) return;

        this._log('info', `Flushing refresh buffer for ${providerType}. Processing ${bufferQueue.size} nodes.`);

        for (const [uuid, { providerStatus, force }] of bufferQueue.entries()) {
            this._enqueueRefreshImmediate(providerType, providerStatus, force);
        }

        bufferQueue.clear();
        delete this.refreshBufferTimers[providerType];
    }

    /**
     * Немедленно добавить в очередь refresh (точь-в-точь как в оригинале)
     */
    private _enqueueRefreshImmediate(providerType: string, providerStatus: ProviderStatus, force: boolean = false) {
        const uuid = providerStatus.uuid;

        if (this.refreshingUuids.has(uuid)) {
            this._log('debug', `Node ${uuid} already in refresh queue (immediate check).`);
            return;
        }

        this.refreshingUuids.add(uuid);

        // Инициализируем очередь провайдера
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
            } catch (err: any) {
                this._log('error', `Failed to refresh node ${uuid}: ${err.message}`);
            } finally {
                this.refreshingUuids.delete(uuid);

                const currentQueue = this.refreshQueues[providerType];
                if (!currentQueue) return;

                currentQueue.activeCount--;

                // Берем следующую задачу из очереди
                if (currentQueue.waitingTasks.length > 0) {
                    const nextTask = currentQueue.waitingTasks.shift();
                    if (nextTask) {
                        currentQueue.activeCount++;
                        Promise.resolve().then(nextTask);
                    }
                }
            }
        };

        // Проверяем лимит параллельности
        if (queue.activeCount < this.refreshConcurrency.perProvider) {
            queue.activeCount++;
            runTask();
        } else {
            this._log('debug', `Node ${uuid} added to waiting queue for ${providerType}.`);
            queue.waitingTasks.push(runTask);
        }
    }

    /**
     * Refresh токена для ноды (точь-в-точь как в оригинале)
     */
    private async _refreshNodeToken(providerType: string, providerStatus: ProviderStatus, force: boolean = false) {
        const config = providerStatus.config;
        const uuid = config.uuid;

        try {
            // Проверка максимального количества попыток refresh
            const currentRefreshCount = config.refreshCount || 0;
            if (currentRefreshCount >= 5) {
                this._log('warn', `Node ${uuid} reached max refresh count (5), marking unhealthy`);
                await this.markProviderUnhealthyImmediately(providerType, uuid, 'Maximum refresh count (5) reached');
                return;
            }

            // Создаем конфигурацию провайдера
            const tempConfig = {
                ...this.globalConfig,
                ...config,
                MODEL_PROVIDER: providerType,
                refreshCount: currentRefreshCount + 1
            };

            // Получаем экземпляр через getServiceAdapter
            const serviceAdapter = getServiceAdapter(tempConfig);

            // Вызываем refreshToken
            if (typeof serviceAdapter.refreshToken === 'function') {
                const startTime = Date.now();
                await serviceAdapter.refreshToken();
                const duration = Date.now() - startTime;

                this._log('info', `Token refresh success for ${uuid} (Duration: ${duration}ms)`);

                // Сбрасываем счетчики после успешного refresh
                config.refreshCount = 0;
                config.lastRefreshTime = Date.now();
                this._debouncedSave(providerType);
            }
        } catch (error: any) {
            this._log('error', `Token refresh failed for ${uuid}: ${error.message}`);
            await this.markProviderUnhealthyImmediately(providerType, uuid, `Refresh failed: ${error.message}`);
        }
    }

    /**
     * Получить все провайдеры определенного типа
     */
    getProviders(providerType: string): ProviderConfig[] {
        return this.providerPools[providerType] || [];
    }

    /**
     * Get all available models from all providers (точь-в-точь как в оригинале)
     */
    async getAllAvailableModels(endpointType: string | null = null): Promise<any> {
        const allModels: Array<{ id: string; provider: string; model: string }> = [];
        
        // Получаем все зарегистрированные провайдеры (точь-в-точь как в оригинале)
        const { getRegisteredProviders } = await import('../providers/adapter');
        const registeredProviders = getRegisteredProviders();
        const allProviderTypes = Array.from(new Set([...registeredProviders]));

        for (const providerType of allProviderTypes) {
            if (this.providerStatus[providerType]) {
                const { getProviderModels } = await import('../providers/provider-models');
                let models = getProviderModels(providerType);
                
                // Если список моделей пустой, пытаемся получить из сервиса (точь-в-точь как в оригинале)
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
                        
                        if (typeof serviceAdapter.listModels === 'function') {
                            const nativeModels = await serviceAdapter.listModels();
                            const { convertData } = await import('../convert/convert');
                            const convertedData = convertData(nativeModels, 'modelList', providerType, 'openai-custom');
                            
                            if (convertedData && Array.isArray(convertedData.data)) {
                                const fetchedModels = convertedData.data.map((m: any) => m.id);
                                if (fetchedModels.length > 0) {
                                    models = fetchedModels;
                                }
                            }
                        }
                    } catch (err: any) {
                        this._log('debug', `Failed to fetch model list for ${providerType} from service: ${err.message}`);
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
        
        // Если не указан endpointType, возвращаем сырой массив (точь-в-точь как в оригинале)
        if (!endpointType) {
            return allModels;
        }
        
        // Конвертируем в формат endpoint (точь-в-точь как в оригинале)
        const { ENDPOINT_TYPE } = await import('../utils/common');
        
        if (endpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
            return {
                object: 'list',
                data: allModels.map(m => ({
                    id: m.id,
                    object: 'model',
                    created: Math.floor(Date.now() / 1000),
                    owned_by: m.provider
                }))
            };
        } else if (endpointType === ENDPOINT_TYPE.GEMINI_MODEL_LIST) {
            return {
                models: allModels.map(m => ({
                    name: `models/${m.id}`,
                    baseModelId: m.model,
                    version: 'v1',
                    displayName: `${m.model} (${m.provider})`,
                    description: `Model ${m.model} provided by ${m.provider}`,
                    supportedGenerationMethods: ['generateContent', 'countTokens']
                }))
            };
        }
        
        return { data: [] };
    }

    /**
     * Release concurrency slot (точь-в-точь как в оригинале)
     */
    releaseSlot(providerType: string, uuid: string): void {
        if (!providerType || !uuid) return;
        
        const provider = this._findProvider(providerType, uuid);
        if (!provider) return;

        const state = provider.config as any;
        if (state.activeCount > 0) {
            state.activeCount--;
        }

        // Если в очереди есть ожидающие задачи, освобождаем следующую (точь-в-точь как в оригинале)
        if (state.queue && state.queue.length > 0) {
            const next = state.queue.shift();
            if (next) {
                setImmediate(next);
            }
        }
    }

    /**
     * Получить все типы провайдеров
     */
    getProviderTypes(): string[] {
        return Object.keys(this.providerPools);
    }
}

// Singleton instance
let poolManagerInstance: ProviderPoolManager | null = null;

/**
 * Получить singleton instance ProviderPoolManager
 */
export async function getProviderPoolManager(): Promise<ProviderPoolManager> {
    if (!poolManagerInstance) {
        const pools = await loadProviderPools();
        const globalConfig = await loadConfig();
        poolManagerInstance = new ProviderPoolManager(pools, { globalConfig });
    }
    return poolManagerInstance;
}

/**
 * Сбросить singleton instance (для тестов)
 */
export function resetProviderPoolManager() {
    poolManagerInstance = null;
}
