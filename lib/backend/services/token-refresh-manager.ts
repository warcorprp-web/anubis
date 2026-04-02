
import logger from '../utils/logger.js';
import { getProviderPoolManager } from './provider-pool-manager';

let refreshInterval: NodeJS.Timeout | null = null;
let isRefreshing = false;


export function initializeTokenRefresh() {
    return async function heartbeatAndRefreshToken() {
        if (isRefreshing) {
            logger.info('[Token Refresh] Already refreshing, skipping...');
            return;
        }

        isRefreshing = true;
        logger.info(`[Heartbeat] Server is running. Current time: ${new Date().toLocaleString()}`);

        try {
            
            const poolManager = await getProviderPoolManager();
            
            
            const providerTypes = poolManager.getProviderTypes();
            
            for (const providerType of providerTypes) {
                const providers = poolManager.getProviders(providerType);
                
                for (const provider of providers) {
                    if (provider.isDisabled) continue;

                    
                    
                    
                    try {
                        
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


export function startTokenRefreshCron(intervalMinutes: number = 30) {
    if (refreshInterval) {
        logger.warn('[Token Refresh] Cron already running');
        return;
    }

    const refreshFn = initializeTokenRefresh();
    
    
    refreshFn();
    
    
    refreshInterval = setInterval(refreshFn, intervalMinutes * 60 * 1000);
    
    logger.info(`[Token Refresh] Cron started (interval: ${intervalMinutes} minutes)`);
}


export function stopTokenRefreshCron() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
        logger.info('[Token Refresh] Cron stopped');
    }
}
