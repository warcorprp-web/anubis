/**
 * Gemini-compatible content generation endpoint
 * Ported from aiclient-2-api/src/services/api-manager.js
 * Handles: /v1beta/models/{model}:generateContent and :streamGenerateContent
 */

import { NextRequest } from 'next/server';
import { handleContentGenerationRequest } from '@/lib/backend/handlers/content-generation-handler';
import { ENDPOINT_TYPE } from '@/lib/backend/utils/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1beta/models/*
 * Gemini-compatible endpoint with provider rotation
 */
export async function POST(request: NextRequest) {
    // Parse path to extract model and action
    // Format: /api/v1beta/models/{model}:{action}
    const pathname = request.nextUrl.pathname;
    const match = pathname.match(/\/models\/([^:]+):(generateContent|streamGenerateContent)/);
    
    if (!match) {
        return new Response(
            JSON.stringify({ error: { message: 'Invalid Gemini API path format' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const [, model, action] = match;

    // Add model to request body if not present
    const body = await request.json();
    if (!body.model) {
        body.model = model;
    }

    // Create new request with modified body
    const modifiedRequest = new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(body)
    });

    return handleContentGenerationRequest(modifiedRequest as NextRequest, ENDPOINT_TYPE.GEMINI_CONTENT);
}
