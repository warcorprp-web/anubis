/**
 * GET /v1beta/models - Gemini model list endpoint
 * Ported from aiclient-2-api
 */

import { NextRequest, NextResponse } from 'next/server';
import { getProviderPoolManager } from '@/lib/backend/services/provider-pool-manager';
import { ENDPOINT_TYPE } from '@/lib/backend/utils/common';
import logger from '@/lib/backend/utils/logger';

export async function GET(request: NextRequest) {
    try {
        logger.info('[Model List] Gemini format request');
        
        const poolManager = await getProviderPoolManager();
        const modelList = await poolManager.getAllAvailableModels(ENDPOINT_TYPE.GEMINI_MODEL_LIST);
        
        return NextResponse.json(modelList);
    } catch (error: any) {
        logger.error('[Model List] Error:', error.message);
        return NextResponse.json(
            { error: { message: error.message || 'Failed to fetch models' } },
            { status: 500 }
        );
    }
}
