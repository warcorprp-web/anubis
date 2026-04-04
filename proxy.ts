import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAuthorized } from '@/lib/backend/auth/api-key-auth';
import { loadConfig } from '@/lib/storage';

const REGISTERED_PROVIDERS = [
  'claude-kiro-oauth',
  'gemini-cli-oauth',
  'openai-qwen-oauth',
  'openai-custom',
  'claude-custom',
  'forward-api',
  'grok-custom',
  'openai-codex-oauth',
  'openai-iflow',
  'gemini-antigravity',
  'openaiResponses-custom',
  'deepseek',
  'auto'
];

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const config = loadConfig();
  const REQUIRED_API_KEY = config.REQUIRED_API_KEY || '123456';
  
  
  if (pathname.startsWith('/api/') || 
      pathname.startsWith('/dashboard') || 
      pathname.startsWith('/login') ||
      pathname.startsWith('/_next')) {
    return NextResponse.next();
  }
  
  
  const pathSegments = pathname.split('/').filter(segment => segment.length > 0);
  
  if (pathSegments.length > 0) {
    const firstSegment = pathSegments[0];
    
    
    if (REGISTERED_PROVIDERS.includes(firstSegment)) {
      
      if (!isAuthorized(request, REQUIRED_API_KEY)) {
        return NextResponse.json(
          { error: { message: 'Unauthorized', code: 'INVALID_API_KEY' } },
          { status: 401 }
        );
      }
      
      
      const provider = firstSegment;
      pathSegments.shift();
      const newPath = '/' + pathSegments.join('/');
      
      
      const url = request.nextUrl.clone();
      url.pathname = `/api${newPath}`;
      
      
      const response = NextResponse.rewrite(url);
      response.headers.set('x-provider-override', provider);
      
      return response;
    }
    
    
    if (firstSegment === 'v1' || firstSegment === 'v1beta') {
      
      if (!isAuthorized(request, REQUIRED_API_KEY)) {
        return NextResponse.json(
          { error: { message: 'Unauthorized', code: 'INVALID_API_KEY' } },
          { status: 401 }
        );
      }
      
      
      const url = request.nextUrl.clone();
      url.pathname = `/api${pathname}`;
      return NextResponse.rewrite(url);
    }
  }
  
  return NextResponse.next();
}


export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
