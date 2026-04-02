
import logger from '../utils/logger.js';
import { loadProviderPools, saveProviderPools } from '@/lib/storage';

const MAX_ERROR_COUNT = 10; 
const ERROR_WINDOW_MS = 10000; 


export async function markProviderUnhealthy(
  providerType: string,
  uuid: string,
  errorMessage: string | null = null
) {
  try {
    const pools = await loadProviderPools();
    const providers = pools[providerType] || [];
    const provider = providers.find(p => p.uuid === uuid);

    if (!provider) {
      logger.error(`[Health Check] Provider not found: ${providerType}/${uuid}`);
      return;
    }

    const wasHealthy = provider.isHealthy;
    const now = Date.now();
    const lastErrorTime = provider.lastErrorTime ? new Date(provider.lastErrorTime).getTime() : 0;

    
    if (now - lastErrorTime > ERROR_WINDOW_MS) {
      provider.errorCount = 1;
    } else {
      provider.errorCount = (provider.errorCount || 0) + 1;
    }

    provider.lastErrorTime = new Date().toISOString();
    provider.lastUsed = new Date().toISOString();

    
    if (errorMessage) {
      provider.lastErrorMessage = errorMessage;
    }

    
    if (provider.errorCount >= MAX_ERROR_COUNT) {
      provider.isHealthy = false;

      if (wasHealthy) {
        logger.warn(
          `[Health Check] Provider marked as UNHEALTHY: ${providerType}/${uuid} ` +
          `(errors: ${provider.errorCount}, message: ${errorMessage})`
        );
      }
    }

    await saveProviderPools(pools);
  } catch (error: any) {
    logger.error(`[Health Check] Error marking provider unhealthy: ${error.message}`);
  }
}


export async function markProviderUnhealthyImmediately(
  providerType: string,
  uuid: string,
  errorMessage: string | null = null
) {
  try {
    const pools = await loadProviderPools();
    const providers = pools[providerType] || [];
    const provider = providers.find(p => p.uuid === uuid);

    if (!provider) {
      logger.error(`[Health Check] Provider not found: ${providerType}/${uuid}`);
      return;
    }

    const wasHealthy = provider.isHealthy;
    provider.isHealthy = false;
    provider.errorCount = MAX_ERROR_COUNT; 
    provider.lastErrorTime = new Date().toISOString();
    provider.lastUsed = new Date().toISOString();

    if (errorMessage) {
      provider.lastErrorMessage = errorMessage;
    }

    if (wasHealthy) {
      logger.error(
        `[Health Check] Provider marked as UNHEALTHY IMMEDIATELY: ${providerType}/${uuid} ` +
        `(reason: ${errorMessage})`
      );
    }

    await saveProviderPools(pools);
  } catch (error: any) {
    logger.error(`[Health Check] Error marking provider unhealthy immediately: ${error.message}`);
  }
}


export async function resetProviderHealth(providerType: string, uuid: string) {
  try {
    const pools = await loadProviderPools();
    const providers = pools[providerType] || [];
    const provider = providers.find(p => p.uuid === uuid);

    if (!provider) {
      logger.error(`[Health Check] Provider not found: ${providerType}/${uuid}`);
      return;
    }

    provider.isHealthy = true;
    provider.errorCount = 0;
    provider.lastErrorMessage = null;
    provider.lastErrorTime = null;

    logger.info(`[Health Check] Provider health reset: ${providerType}/${uuid}`);

    await saveProviderPools(pools);
  } catch (error: any) {
    logger.error(`[Health Check] Error resetting provider health: ${error.message}`);
  }
}


export async function incrementProviderUsage(providerType: string, uuid: string) {
  try {
    const pools = await loadProviderPools();
    const providers = pools[providerType] || [];
    const provider = providers.find(p => p.uuid === uuid);

    if (!provider) return;

    provider.usageCount = (provider.usageCount || 0) + 1;
    provider.lastUsed = new Date().toISOString();

    await saveProviderPools(pools);
  } catch (error: any) {
    logger.error(`[Health Check] Error incrementing usage: ${error.message}`);
  }
}
