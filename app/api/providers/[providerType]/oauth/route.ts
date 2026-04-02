import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ providerType: string }> }
) {
  try {
    const { providerType } = await context.params;
    const body = await request.json();
    const config = await loadConfig();

    // Маппинг провайдеров на директории
    const providerDirMap: Record<string, string> = {
      'gemini-cli-oauth': 'gemini',
      'gemini-antigravity': 'antigravity',
      'openai-qwen-oauth': 'qwen',
      'claude-kiro-oauth': 'kiro',
      'openai-iflow': 'iflow',
      'openai-codex-oauth': 'codex',
    };

    // Добавляем providerDir в options
    const options = {
      ...body,
      providerDir: providerDirMap[providerType] || providerType,
    };

    // Импортируем OAuth handlers из портированного backend
    const { 
      handleGeminiCliOAuth,
      handleGeminiAntigravityOAuth,
      handleQwenOAuth,
      handleKiroOAuth,
      handleIFlowOAuth,
      handleCodexOAuth,
    } = await import('@/lib/backend/auth/index.js');

    let result: { authUrl: string; authInfo: any } | undefined;

    switch (providerType) {
      case 'gemini-cli-oauth':
        result = await handleGeminiCliOAuth(config, options);
        break;
      case 'gemini-antigravity':
        result = await handleGeminiAntigravityOAuth(config, options);
        break;
      case 'openai-qwen-oauth':
        result = await handleQwenOAuth(config, options);
        break;
      case 'claude-kiro-oauth':
        result = await handleKiroOAuth(config, options);
        break;
      case 'openai-iflow':
        result = await handleIFlowOAuth(config, options);
        break;
      case 'openai-codex-oauth':
        result = await handleCodexOAuth(config, options);
        break;
      default:
        return NextResponse.json(
          { success: false, error: `Unsupported provider: ${providerType}` },
          { status: 400 }
        );
    }

    return NextResponse.json({
      success: true,
      authUrl: result?.authUrl || '',
      authInfo: result?.authInfo || {},
    });
  } catch (error: any) {
    console.error('[OAuth] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'OAuth generation failed' },
      { status: 500 }
    );
  }
}
