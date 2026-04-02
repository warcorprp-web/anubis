import { NextResponse } from 'next/server';

export async function GET() {
  try {
    // Получаем список поддерживаемых провайдеров
    const supportedResponse = await fetch('http://localhost:5083/api/providers/supported');
    const supportedProviders = await supportedResponse.json();

    const routes = [
      {
        provider: 'claude-kiro-oauth',
        name: 'Claude Kiro OAuth',
        paths: {
          openai: '/claude-kiro-oauth/v1/chat/completions',
          claude: '/claude-kiro-oauth/v1/messages'
        },
        description: 'Триал доступ',
        badge: 'Триал',
        badgeClass: 'oauth',
        icon: 'simple-icons:anthropic',
        defaultModel: 'claude-sonnet-4-6'
      },
      {
        provider: 'openai-qwen-oauth',
        name: 'Qwen OAuth',
        paths: {
          openai: '/openai-qwen-oauth/v1/chat/completions',
          claude: '/openai-qwen-oauth/v1/messages'
        },
        description: 'Qwen Code Plus',
        badge: 'OAuth',
        badgeClass: 'oauth',
        icon: 'hugeicons:qwen',
        defaultModel: 'qwen3-coder-plus'
      },
      {
        provider: 'gemini-cli-oauth',
        name: 'Gemini CLI OAuth',
        paths: {
          openai: '/gemini-cli-oauth/v1/chat/completions',
          claude: '/gemini-cli-oauth/v1/messages'
        },
        description: 'OAuth',
        badge: 'OAuth',
        badgeClass: 'oauth',
        icon: 'simple-icons:googlegemini',
        defaultModel: 'gemini-3-flash-preview'
      },
      {
        provider: 'openai-custom',
        name: 'OpenAI Custom',
        paths: {
          openai: '/openai-custom/v1/chat/completions',
          claude: '/openai-custom/v1/messages'
        },
        description: 'Официальный',
        badge: 'Официальный',
        badgeClass: 'official',
        icon: 'simple-icons:openai',
        defaultModel: 'gpt-4o'
      },
      {
        provider: 'claude-custom',
        name: 'Claude Custom',
        paths: {
          openai: '/claude-custom/v1/chat/completions',
          claude: '/claude-custom/v1/messages'
        },
        description: 'Официальный',
        badge: 'Официальный',
        badgeClass: 'official',
        icon: 'simple-icons:anthropic',
        defaultModel: 'claude-sonnet-4-6'
      },
      {
        provider: 'openai-codex-oauth',
        name: 'OpenAI Codex OAuth',
        paths: {
          openai: '/openai-codex-oauth/v1/chat/completions',
          claude: '/openai-codex-oauth/v1/messages'
        },
        description: 'OAuth',
        badge: 'OAuth',
        badgeClass: 'oauth',
        icon: 'simple-icons:openai',
        defaultModel: 'gpt-5'
      },
      {
        provider: 'gemini-antigravity',
        name: 'Gemini Antigravity',
        paths: {
          openai: '/gemini-antigravity/v1/chat/completions',
          claude: '/gemini-antigravity/v1/messages'
        },
        description: 'Экспериментальный',
        badge: 'Экспериментальный',
        badgeClass: 'oauth',
        icon: 'simple-icons:googlegemini',
        defaultModel: 'gemini-3-flash-preview'
      },
      {
        provider: 'openai-iflow',
        name: 'iFlow OAuth',
        paths: {
          openai: '/openai-iflow/v1/chat/completions',
          claude: '/openai-iflow/v1/messages'
        },
        description: 'OAuth',
        badge: 'OAuth',
        badgeClass: 'oauth',
        icon: 'simple-icons:openai',
        defaultModel: 'qwen3-max'
      },
      {
        provider: 'grok-custom',
        name: 'Grok Reverse',
        paths: {
          openai: '/grok-custom/v1/chat/completions',
          claude: '/grok-custom/v1/messages'
        },
        description: 'Триал доступ',
        badge: 'Триал',
        badgeClass: 'oauth',
        icon: 'simple-icons:x',
        defaultModel: 'grok-3'
      },
      {
        provider: 'openaiResponses-custom',
        name: 'OpenAI Responses',
        paths: {
          openai: '/openaiResponses-custom/v1/responses',
          claude: '/openaiResponses-custom/v1/messages'
        },
        description: 'Структурированный диалог API',
        badge: 'Responses',
        badgeClass: 'responses',
        icon: 'simple-icons:openai',
        defaultModel: 'gpt-4o'
      },
      {
        provider: 'forward-api',
        name: 'Прокси (OpenAI-совместимые API)',
        paths: {
          openai: '/forward-api/v1/chat/completions',
          claude: '/forward-api/v1/messages'
        },
        description: 'Универсальный прокси для сторонних API',
        badge: 'Прокси',
        badgeClass: 'official',
        icon: 'simple-icons:fastapi',
        defaultModel: 'gpt-4o-mini'
      }
    ];

    // Фильтруем только поддерживаемые провайдеры
    const visibleRoutes = routes.filter(route => 
      supportedProviders.includes(route.provider)
    );

    return NextResponse.json(visibleRoutes);
  } catch (error) {
    console.error('Ошибка загрузки routing examples:', error);
    return NextResponse.json([], { status: 500 });
  }
}
