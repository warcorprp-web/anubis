import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { isAuthorized } from '@/lib/backend/auth/api-key-auth';

// Список зарегистрированных провайдеров
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
  'auto'
];

// API ключ загружается из переменной окружения для Edge Runtime
const REQUIRED_API_KEY = process.env.REQUIRED_API_KEY || '123456';

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  
  // Skip API routes, dashboard, login, static files
  if (pathname.startsWith('/api/') || 
      pathname.startsWith('/dashboard') || 
      pathname.startsWith('/login') ||
      pathname.startsWith('/_next')) {
    return NextResponse.next();
  }
  
  // Парсим путь
  const pathSegments = pathname.split('/').filter(segment => segment.length > 0);
  
  if (pathSegments.length > 0) {
    const firstSegment = pathSegments[0];
    
    // Проверяем что первый сегмент - валидный провайдер
    if (REGISTERED_PROVIDERS.includes(firstSegment)) {
      // Check API key authorization
      if (!isAuthorized(request, REQUIRED_API_KEY)) {
        return NextResponse.json(
          { error: { message: 'Unauthorized', code: 'INVALID_API_KEY' } },
          { status: 401 }
        );
      }
      
      // Извлекаем провайдер и переписываем путь
      const provider = firstSegment;
      pathSegments.shift();
      const newPath = '/' + pathSegments.join('/');
      
      // Создаем новый URL с переписанным путем
      const url = request.nextUrl.clone();
      url.pathname = `/api${newPath}`;
      
      // Передаем провайдер через header
      const response = NextResponse.rewrite(url);
      response.headers.set('x-provider-override', provider);
      
      return response;
    }
    
    // Direct API calls: /v1/... or /v1beta/...
    if (firstSegment === 'v1' || firstSegment === 'v1beta') {
      // Check API key authorization
      if (!isAuthorized(request, REQUIRED_API_KEY)) {
        return NextResponse.json(
          { error: { message: 'Unauthorized', code: 'INVALID_API_KEY' } },
          { status: 401 }
        );
      }
      
      // Rewrite to /api/v1/...
      const url = request.nextUrl.clone();
      url.pathname = `/api${pathname}`;
      return NextResponse.rewrite(url);
    }
  }
  
  return NextResponse.next();
}

// Применяем middleware ко всем путям кроме статики
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
