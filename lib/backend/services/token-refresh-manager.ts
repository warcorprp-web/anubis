// Менеджер автообновления токенов (портировано из api-manager.js)
import logger from '../utils/logger.js';
import { getProviderPoolManager } from './provider-pool-manager';

let refreshInterval: NodeJS.Timeout | null = null;
let isRefreshing = false;

/**
 * Initialize API management features (ported from api-manager.js)
 * Использует ProviderPoolManager для управления refresh через очереди
 */
export function initializeTokenRefresh() {
    return async function heartbeatAndRefreshToken() {
        if (isRefreshing) {
            logger.info('[Token Refresh] Already refreshing, skipping...');
            return;
        }

        isRefreshing = true;
        logger.info(`[Heartbeat] Server is running. Current time: ${new Date().toLocaleString()}`);

        try {
            // Получаем ProviderPoolManager (точь-в-точь как в оригинале)
            const poolManager = await getProviderPoolManager();
            
            // Проходим по всем провайдерам и добавляем в очередь refresh
            const providerTypes = poolManager.getProviderTypes();
            
            for (const providerType of providerTypes) {
                const providers = poolManager.getProviders(providerType);
                
                for (const provider of providers) {
                    if (provider.isDisabled) continue;

                    // Используем ProviderPoolManager для refresh (точь-в-точь как в оригинале)
                    // В оригинале: poolManager._enqueueRefresh(providerType, { config: provider, uuid: provider.uuid })
                    // Но _enqueueRefresh - private, поэтому используем публичный метод через рефлексию
                    try {
                        // Вызываем приватный метод через any cast (как в оригинале)
                        const providerStatus = { uuid: provider.uuid, config: provider };
                        (poolManager as any)._enqueueRefresh(providerType, providerStatus, false);
                    } catch (error: any) {
                        logger.error(`[Token Refresh Error] Failed to enqueue refresh for ${providerType}/${provider.uuid}: ${error.message}`);
                    }
                }
            }
        } catch (error: any) {
            logger.error(`[Heartbeat Error] ${error.message}`);
        } finally {
            isRefreshing = false;
        }
    };
}

/**
 * Start token refresh cron job
 */
export function startTokenRefreshCron(intervalMinutes: number = 30) {
    if (refreshInterval) {
        logger.warn('[Token Refresh] Cron already running');
        return;
    }

    const refreshFn = initializeTokenRefresh();
    
    // Запускаем сразу
    refreshFn();
    
    // И потом каждые N минут
    refreshInterval = setInterval(refreshFn, intervalMinutes * 60 * 1000);
    
    logger.info(`[Token Refresh] Cron started (interval: ${intervalMinutes} minutes)`);
}

/**
 * Stop token refresh cron job
 */
export function stopTokenRefreshCron() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
        logger.info('[Token Refresh] Cron stopped');
    }
}
