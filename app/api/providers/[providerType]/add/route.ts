import { NextRequest, NextResponse } from 'next/server';
import { loadProviderPools, saveProviderPools } from '@/lib/storage';
import { v4 as uuidv4 } from 'uuid';
import logger from '@/lib/backend/utils/logger';

export async function POST(
    request: NextRequest,
    context: { params: Promise<{ providerType: string }> }
) {
    try {
        const { providerType } = await context.params;
        const body = await request.json();
        
        logger.info(`[Provider Add] Adding manual provider: ${providerType}`);
        
        const pools = await loadProviderPools();
        
        if (!pools[providerType]) {
            pools[providerType] = [];
        }
        
        
        const newProvider: any = {
            uuid: uuidv4(),
            isHealthy: true,
            isDisabled: false,
            usageCount: 0,
            errorCount: 0,
            refreshCount: 0,
            lastRefreshTime: Date.now(),
            ...body
        };
        
        pools[providerType].push(newProvider);
        await saveProviderPools(pools);
        
        logger.info(`[Provider Add] Successfully added ${providerType}/${newProvider.uuid}`);
        
        return NextResponse.json({ success: true, uuid: newProvider.uuid });
    } catch (error: any) {
        logger.error('[Provider Add] Error:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
