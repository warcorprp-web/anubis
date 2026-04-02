

import { NextRequest } from 'next/server';

export function isAuthorized(request: NextRequest, requiredApiKey: string): boolean {
    
    const authHeader = request.headers.get('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === requiredApiKey) {
            return true;
        }
    }
    
    
    const claudeApiKey = request.headers.get('x-api-key');
    if (claudeApiKey === requiredApiKey) {
        return true;
    }
    
    
    const googApiKey = request.headers.get('x-goog-api-key');
    if (googApiKey === requiredApiKey) {
        return true;
    }
    
    
    const url = new URL(request.url);
    const queryKey = url.searchParams.get('key');
    if (queryKey === requiredApiKey) {
        return true;
    }
    
    return false;
}
