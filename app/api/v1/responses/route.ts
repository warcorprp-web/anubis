/**
 * OpenAI Responses endpoint
 * Ported from aiclient-2-api/src/services/api-manager.js
 */

import { NextRequest } from 'next/server';
import { handleContentGenerationRequest } from '@/lib/backend/handlers/content-generation-handler';
import { ENDPOINT_TYPE } from '@/lib/backend/utils/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/responses
 * OpenAI Responses endpoint with provider rotation
 */
export async function POST(request: NextRequest) {
    return handleContentGenerationRequest(request, ENDPOINT_TYPE.OPENAI_RESPONSES);
}
