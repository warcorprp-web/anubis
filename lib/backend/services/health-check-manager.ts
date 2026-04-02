// Health check система (портировано из provider-pool-manager.js)
import logger from '../utils/logger.js';
import { loadProviderPools, saveProviderPools } from '@/lib/storage';

const MAX_ERROR_COUNT = 10; // Максимум ошибок перед пометкой как unhealthy
const ERROR_WINDOW_MS = 10000; // 10 секунд окно для подсчета ошибок

/**
 * Mark provider as unhealthy (accumulating errors)
 * Портировано из provider-pool-manager.js:1329
 */
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

    // Если距离последней ошибки > 10 секунд, сбрасываем счетчик
    if (now - lastErrorTime > ERROR_WINDOW_MS) {
      provider.errorCount = 1;
    } else {
      provider.errorCount = (provider.errorCount || 0) + 1;
    }

    provider.lastErrorTime = new Date().toISOString();
    provider.lastUsed = new Date().toISOString();

    // Сохраняем сообщение об ошибке
    if (errorMessage) {
      provider.lastErrorMessage = errorMessage;
    }

    // Если достигли максимума ошибок - помечаем как unhealthy
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

/**
 * Mark provider as unhealthy immediately (for auth errors like 401/403)
 * Портировано из provider-pool-manager.js:1384
 */
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
    provider.errorCount = MAX_ERROR_COUNT; // Сразу максимум
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

/**
 * Reset provider health status
 * Портировано из provider-pool-manager.js
 */
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

/**
 * Increment usage count for provider
 */
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
