import { NextRequest, NextResponse } from 'next/server';
import { loadProviderPools, saveProviderPools } from '@/lib/storage';
import { v4 as uuidv4 } from 'uuid';
import logger from '@/lib/backend/utils/logger';
import fs from 'fs';
import path from 'path';

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
        };

        // Special handling for gigachat-api: save credentials to file
        if (providerType === 'gigachat-api') {
            const { authorizationKey, scope } = body;
            
            // Create credentials file
            const configDir = path.join(process.cwd(), 'configs', 'gigachat');
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }
            
            const credsFileName = `gigachat_${newProvider.uuid}_creds.json`;
            const credsFilePath = path.join(configDir, credsFileName);
            
            const credsData = {
                authKey: authorizationKey,
                scope: scope || 'GIGACHAT_API_PERS'
            };
            
            fs.writeFileSync(credsFilePath, JSON.stringify(credsData, null, 2));
            
            // Store only the path in provider config
            newProvider.GIGACHAT_CREDS_FILE_PATH = `configs/gigachat/${credsFileName}`;
            
            logger.info(`[Provider Add] Created GigaChat credentials file: ${credsFileName}`);
        } else if (providerType === 'deepseek') {
            // DeepSeek: store auth token directly
            const { DEEPSEEK_AUTH_TOKEN } = body;
            newProvider.DEEPSEEK_AUTH_TOKEN = DEEPSEEK_AUTH_TOKEN;
            newProvider.checkModelName = 'deepseek-chat';
            newProvider.checkHealth = true;
            
            logger.info(`[Provider Add] Added DeepSeek provider: ${newProvider.uuid}`);
        } else {
            // For other providers, store all body data
            Object.assign(newProvider, body);
        }
        
        pools[providerType].push(newProvider);
        await saveProviderPools(pools);
        
        // Update ProviderPoolManager in memory
        const { getProviderPoolManager } = await import('@/lib/backend/services/provider-pool-manager');
        const poolManager = await getProviderPoolManager();
        poolManager.providerPools = pools;
        await poolManager.initializeProviderStatus();
        logger.info(`[Provider Add] Provider status reinitialized`);
        
        logger.info(`[Provider Add] Successfully added ${providerType}/${newProvider.uuid}`);
        
        return NextResponse.json({ success: true, uuid: newProvider.uuid });
    } catch (error: any) {
        logger.error('[Provider Add] Error:', error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
