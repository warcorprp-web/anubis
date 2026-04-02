

import { NextRequest } from 'next/server';
import { handleContentGenerationRequest } from '@/lib/backend/handlers/content-generation-handler';
import { ENDPOINT_TYPE } from '@/lib/backend/utils/common';
import logger from '@/lib/backend/utils/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ provider: string }> }
) {
    const { provider } = await params;
    
    logger.info(`[Provider Route] Selected provider from path: ${provider}`);
    
    return handleContentGenerationRequest(request, ENDPOINT_TYPE.OPENAI_CHAT, provider);
}
