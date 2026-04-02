/**
 * DELETE /api/providers/[providerType]/[uuid] - Delete provider
 * POST /api/providers/[providerType]/[uuid]/refresh - Refresh token
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProviderPoolManager } from '@/lib/backend/services/provider-pool-manager';
import { loadProviderPools, saveProviderPools } from '@/lib/storage';
import logger from '@/lib/backend/utils/logger';

export async function DELETE(
    request: NextRequest,
    context: { params: Promise<{ providerType: string; uuid: string }> }
) {
    try {
        const { providerType, uuid } = await context.params;
        
        logger.info(`[Provider Delete] Deleting ${providerType}/${uuid}`);
        
        // Загружаем пулы
        const pools = await loadProviderPools();
        
        if (!pools[providerType]) {
            return NextResponse.json(
                { error: 'Provider type not found' },
                { status: 404 }
            );
        }
        
        // Находим и удаляем провайдера
        const index = pools[providerType].findIndex((p: any) => p.uuid === uuid);
        
        if (index === -1) {
            return NextResponse.json(
                { error: 'Provider not found' },
                { status: 404 }
            );
        }
        
        pools[providerType].splice(index, 1);
        
        // Сохраняем
        await saveProviderPools(pools);
        
        logger.info(`[Provider Delete] Successfully deleted ${providerType}/${uuid}`);
        
        return NextResponse.json({ success: true });
    } catch (error: any) {
        logger.error('[Provider Delete] Error:', error.message);
        return NextResponse.json(
            { error: error.message },
            { status: 500 }
        );
    }
}
