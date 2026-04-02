

import { NextRequest } from 'next/server';
import { handleContentGenerationRequest } from '@/lib/backend/handlers/content-generation-handler';
import { ENDPOINT_TYPE } from '@/lib/backend/utils/common';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


export async function POST(request: NextRequest) {
    
    
    const pathname = request.nextUrl.pathname;
    const match = pathname.match(/\/models\/([^:]+):(generateContent|streamGenerateContent)/);
    
    if (!match) {
        return new Response(
            JSON.stringify({ error: { message: 'Invalid Gemini API path format' } }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
    }

    const [, model, action] = match;

    
    const body = await request.json();
    if (!body.model) {
        body.model = model;
    }

    
    const modifiedRequest = new Request(request.url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(body)
    });

    return handleContentGenerationRequest(modifiedRequest as NextRequest, ENDPOINT_TYPE.GEMINI_CONTENT);
}
