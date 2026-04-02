/**
 * POST /api/providers/[providerType]/[uuid]/refresh - Refresh provider token
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProviderPoolManager } from '@/lib/backend/services/provider-pool-manager';
import { getServiceAdapter } from '@/lib/backend/providers/adapter';
import { loadProviderPools } from '@/lib/storage';
import logger from '@/lib/backend/utils/logger';

export async function POST(
    request: NextRequest,
    context: { params: Promise<{ providerType: string; uuid: string }> }
) {
    try {
        const { providerType, uuid } = await context.params;
        
        logger.info(`[Provider Refresh] Refreshing token for ${providerType}/${uuid}`);
        
        // Загружаем пулы
        const pools = await loadProviderPools();
        
        if (!pools[providerType]) {
            return NextResponse.json(
                { error: 'Provider type not found' },
                { status: 404 }
            );
        }
        
        // Находим провайдера
        const provider = pools[providerType].find((p: any) => p.uuid === uuid);
        
        if (!provider) {
            return NextResponse.json(
                { error: 'Provider not found' },
                { status: 404 }
            );
        }
        
        // Создаем конфиг для адаптера
        const config = {
            ...provider,
            MODEL_PROVIDER: providerType
        };
        
        // Получаем адаптер и обновляем токен
        const adapter = getServiceAdapter(config);
        
        if (typeof adapter.forceRefreshToken === 'function') {
            await adapter.forceRefreshToken();
            logger.info(`[Provider Refresh] Successfully refreshed token for ${providerType}/${uuid}`);
            
            // Mark provider healthy and reset error count
            const poolManager = await getProviderPoolManager();
            await poolManager.markProviderHealthy(providerType, uuid, false, null);
            
            return NextResponse.json({ 
                success: true,
                message: 'Token refreshed successfully'
            });
        } else {
            return NextResponse.json(
                { error: 'Provider does not support token refresh' },
                { status: 400 }
            );
        }
    } catch (error: any) {
        logger.error('[Provider Refresh] Error:', error.message);
        return NextResponse.json(
            { error: error.message },
            { status: 500 }
        );
    }
}
