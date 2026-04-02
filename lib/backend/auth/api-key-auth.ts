/**
 * API Key authorization check (ported from aiclient-2-api)
 * Supports multiple auth methods like original:
 * 1. Authorization: Bearer <key>
 * 2. x-api-key: <key> (Claude style)
 * 3. x-goog-api-key: <key> (Gemini style)
 * 4. ?key=<key> (URL query)
 */

import { NextRequest } from 'next/server';

export function isAuthorized(request: NextRequest, requiredApiKey: string): boolean {
    // 1. Authorization: Bearer <key> (OpenAI style)
    const authHeader = request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === requiredApiKey) {
            return true;
        }
    }
    
    // 2. x-api-key: <key> (Claude style)
    const claudeApiKey = request.headers.get('x-api-key');
    if (claudeApiKey === requiredApiKey) {
        return true;
    }
    
    // 3. x-goog-api-key: <key> (Gemini style)
    const googApiKey = request.headers.get('x-goog-api-key');
    if (googApiKey === requiredApiKey) {
        return true;
    }
    
    // 4. ?key=<key> (URL query)
    const url = new URL(request.url);
    const queryKey = url.searchParams.get('key');
    if (queryKey === requiredApiKey) {
        return true;
    }
    
    return false;
}
