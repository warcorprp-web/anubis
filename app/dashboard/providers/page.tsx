'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@iconify-icon/react';

interface Provider {
  uuid: string;
  isHealthy: boolean;
  isDisabled: boolean;
  usageCount: number;
  errorCount: number;
}

interface ProviderPools {
  [key: string]: Provider[];
}

interface ProviderConfig {
  id: string;
  name: string;
  icon: string;
}

const providerConfigs: ProviderConfig[] = [
  { id: 'claude-kiro-oauth', name: 'Claude Kiro OAuth', icon: 'simple-icons:anthropic' },
  { id: 'openai-qwen-oauth', name: 'Qwen OAuth', icon: 'hugeicons:qwen' },
  { id: 'gemini-cli-oauth', name: 'Gemini CLI OAuth', icon: 'simple-icons:googlegemini' },
  { id: 'openai-custom', name: 'OpenAI Custom', icon: 'simple-icons:openai' },
  { id: 'claude-custom', name: 'Claude Custom', icon: 'simple-icons:anthropic' },
  { id: 'openai-codex-oauth', name: 'OpenAI Codex OAuth', icon: 'simple-icons:openai' },
  { id: 'gemini-antigravity', name: 'Gemini Antigravity', icon: 'simple-icons:googlegemini' },
  { id: 'openai-iflow', name: 'iFlow OAuth', icon: 'simple-icons:openai' },
  { id: 'grok-custom', name: 'Grok Reverse', icon: 'simple-icons:x' },
  { id: 'openaiResponses-custom', name: 'OpenAI Responses', icon: 'simple-icons:openai' },
  { id: 'forward-api', name: 'Прокси API', icon: 'simple-icons:fastapi' },
];

export default function ProvidersPage() {
  const [providers, setProviders] = useState<ProviderPools>({});
  const [supportedProviders, setSupportedProviders] = useState<string[]>([]);
  const [stats, setStats] = useState({
    total: 0,
    healthy: 0,
    active: 0,
  });
  const [showOAuthModal, setShowOAuthModal] = useState(false);
  const [oauthData, setOAuthData] = useState<{ url: string; provider: string; name: string } | null>(null);
  const [loadingOAuth, setLoadingOAuth] = useState<string | null>(null);
  const [oauthSuccess, setOAuthSuccess] = useState(false);
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<any>(null);
  const [confirmingAction, setConfirmingAction] = useState<{ uuid: string; action: 'refresh' | 'delete' } | null>(null);
  const [loadingAction, setLoadingAction] = useState<{ uuid: string; action: 'refresh' | 'delete' } | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addProviderType, setAddProviderType] = useState<string>('');
  const [addFormData, setAddFormData] = useState<any>({});

  useEffect(() => {
    loadProviders();
    loadSupported();

    
    fetch('/api/health').catch(console.error);

    
    const eventSource = new EventSource('/api/events');

    eventSource.addEventListener('oauth_success', (event) => {
      const data = JSON.parse(event.data);
      console.log('[OAuth Success]', data);
      
      
      setOAuthSuccess(true);
      
      
      loadProviders();
      
      
      setTimeout(() => {
        setShowOAuthModal(false);
        setOAuthSuccess(false);
      }, 2000);
    });

    eventSource.addEventListener('oauth_error', (event) => {
      const data = JSON.parse(event.data);
      
      if (data.error === '轮询任务已被取消') return;
      console.error('[OAuth Error]', data);
    });

    return () => {
      eventSource.close();
    };
  }, []);

  const loadProviders = async () => {
    const res = await fetch('/api/providers');
    const data = await res.json();
    setProviders(data);

    
    const allProviders = Object.values(data).flat() as Provider[];
    setStats({
      total: allProviders.length,
      healthy: allProviders.filter(p => p.isHealthy && !p.isDisabled).length,
      active: allProviders.filter(p => !p.isDisabled).length,
    });
  };

  const loadSupported = async () => {
    const res = await fetch('/api/providers/supported');
    const data = await res.json();
    setSupportedProviders(data);
  };

  const visibleProviders = providerConfigs.filter(config =>
    supportedProviders.includes(config.id)
  );

  const handleOAuthAuth = async (providerId: string, providerName: string, authMethod?: string) => {
    setLoadingOAuth(providerId);
    try {
      const body: any = { saveToConfigs: true };
      if (authMethod) body.authMethod = authMethod;
      
      const res = await fetch(`/api/providers/${providerId}/oauth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      
      if (data.success && data.authUrl) {
        setOAuthData({ url: data.authUrl, provider: providerId, name: providerName });
        setShowOAuthModal(true);
      }
    } catch (error) {
      console.error('Ошибка генерации OAuth URL:', error);
    } finally {
      setLoadingOAuth(null);
    }
  };

  const handleAddCustom = (providerId: string, providerName: string) => {
    setAddProviderType(providerId);
    
    
    const fields: any = { customName: '' };
    
    if (providerId === 'openai-custom') {
      fields.OPENAI_API_KEY = '';
      fields.OPENAI_BASE_URL = 'https://api.openai.com';
    } else if (providerId === 'claude-custom') {
      fields.CLAUDE_API_KEY = '';
      fields.CLAUDE_BASE_URL = 'https://api.anthropic.com';
    } else if (providerId === 'forward-api') {
      fields.FORWARD_API_KEY = '';
      fields.FORWARD_BASE_URL = '';
      fields.FORWARD_HEADER_NAME = 'Authorization';
      fields.FORWARD_HEADER_VALUE_PREFIX = 'Bearer ';
    } else if (providerId === 'grok-custom') {
      fields.GROK_COOKIE_TOKEN = '';
      fields.GROK_CF_CLEARANCE = '';
      fields.GROK_USER_AGENT = '';
      fields.GROK_BASE_URL = 'https://api.x.ai';
    }
    
    setAddFormData(fields);
    setShowAddModal(true);
  };

  const handleSaveProvider = async () => {
    try {
      const res = await fetch(`/api/providers/${addProviderType}/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addFormData),
      });
      
      if (res.ok) {
        setShowAddModal(false);
        loadProviders();
      }
    } catch (error) {
      console.error('Failed to add provider:', error);
    }
  };

  const handleProviderClick = async (providerId: string) => {
    try {
      const res = await fetch(`/api/providers/${providerId}`);
      const data = await res.json();
      setSelectedProvider(data);
      setShowDetailsModal(true);
    } catch (error) {
      console.error('Ошибка загрузки деталей провайдера:', error);
    }
  };

  const handleManualCallback = async (callbackUrl: string) => {
    if (!oauthData) return;
    
    try {
      const res = await fetch('/api/oauth/manual-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: oauthData.provider,
          callbackUrl,
        }),
      });
      
      const data = await res.json();
      
      if (data.success) {
        setOAuthSuccess(true);
        loadProviders();
        setTimeout(() => {
          setShowOAuthModal(false);
          setOAuthSuccess(false);
        }, 2000);
      }
    } catch (error) {
      console.error('Manual callback error:', error);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="space-y-8">
        {}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Icon icon="pixelarticons:users" width="24" style={{ color: '#de610d' }} />
            <span className="text-2xl font-bold text-black">ПРОВАЙДЕРЫ</span>
          </div>
          <p className="text-black/70">Управление AI провайдерами и их аккаунтами</p>
        </div>

        {}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-2xl p-6">
            <div className="flex items-center gap-4">
              <Icon icon="pixelarticons:users" width="32" style={{ color: '#de610d' }} />
              <div>
                <div className="text-3xl font-bold text-black">{stats.total}</div>
                <div className="text-sm text-black/70">Всего провайдеров</div>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-2xl p-6">
            <div className="flex items-center gap-4">
              <Icon icon="pixelarticons:heart" width="32" style={{ color: '#10b981' }} />
              <div>
                <div className="text-3xl font-bold text-black">{stats.healthy}</div>
                <div className="text-sm text-black/70">Здоровых</div>
              </div>
            </div>
          </div>
        </div>

        {}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {visibleProviders.map(config => {
            const accounts = providers[config.id] || [];
            const healthyCount = accounts.filter(p => p.isHealthy && !p.isDisabled).length;
            const totalCount = accounts.length;
            const usageCount = accounts.reduce((sum, p) => sum + (p.usageCount || 0), 0);
            const errorCount = accounts.reduce((sum, p) => sum + (p.errorCount || 0), 0);
            const isEmpty = totalCount === 0;

            return (
              <div 
                key={config.id} 
                className="bg-white rounded-2xl p-6 space-y-4"
              >
                {}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Icon icon={config.icon} width="24" style={{ color: '#de610d' }} />
                    <span className="font-bold text-black">{config.name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {isEmpty ? (
                      <span className="text-xs text-black/50 flex items-center gap-1">
                        <Icon icon="pixelarticons:info" width="14" />
                        Нет данных
                      </span>
                    ) : healthyCount === totalCount ? (
                      <span className="text-xs text-green-600 flex items-center gap-1 font-bold">
                        <Icon icon="pixelarticons:check" width="14" />
                        {healthyCount}/{totalCount}
                      </span>
                    ) : (
                      <span className="text-xs text-orange-600 flex items-center gap-1 font-bold">
                        <Icon icon="pixelarticons:alert" width="14" />
                        {healthyCount}/{totalCount}
                      </span>
                    )}
                  </div>
                </div>

                {}
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-black/50">Всего аккаунтов</span>
                    <span className="text-sm font-bold text-black">{totalCount}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-black/50">Здоровых</span>
                    <span className="text-sm font-bold text-black">{healthyCount}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-black/50">Использований</span>
                    <span className="text-sm font-bold text-black">{usageCount}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-black/50">Ошибок</span>
                    <span className="text-sm font-bold text-black">{errorCount}</span>
                  </div>
                </div>

                {}
                <div className="flex gap-2 pt-2">
                  {['gemini-cli-oauth', 'gemini-antigravity', 'openai-qwen-oauth', 'claude-kiro-oauth', 'openai-iflow', 'openai-codex-oauth'].includes(config.id) ? (
                    <>
                      <button 
                        onClick={() => handleOAuthAuth(config.id, config.name, config.id === 'claude-kiro-oauth' ? 'builder-id' : undefined)}
                        disabled={loadingOAuth === config.id}
                        className="flex-1 bg-[#de610d] hover:bg-[#c55a0b] disabled:bg-gray-400 disabled:cursor-not-allowed text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2"
                      >
                        {loadingOAuth === config.id ? (
                          <>
                            <Icon icon="pixelarticons:sync" width="16" className="animate-spin" />
                            Загрузка...
                          </>
                        ) : (
                          <>
                            <Icon icon="pixelarticons:key" width="16" />
                            Создать авторизацию
                          </>
                        )}
                      </button>
                      <button 
                        onClick={() => handleProviderClick(config.id)}
                        className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-xl text-sm font-bold transition-colors flex items-center justify-center"
                      >
                        <Icon icon="pixelarticons:list" width="16" style={{ color: '#de610d' }} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button 
                        onClick={() => handleAddCustom(config.id, config.name)}
                        className="flex-1 bg-[#de610d] hover:bg-[#c55a0b] text-white px-4 py-2 rounded-xl text-sm font-bold transition-colors flex items-center justify-center gap-2"
                      >
                        <Icon icon="pixelarticons:plus" width="16" />
                        Добавить
                      </button>
                      <button 
                        onClick={() => handleProviderClick(config.id)}
                        className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-xl text-sm font-bold transition-colors flex items-center justify-center"
                      >
                        <Icon icon="pixelarticons:list" width="16" style={{ color: '#de610d' }} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {}
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-black flex items-center gap-2">
            <Icon icon="pixelarticons:info" width="24" style={{ color: '#de610d' }} />
            Советы по использованию
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Icon icon="pixelarticons:key" width="20" style={{ color: '#de610d' }} />
                <span className="font-bold text-black">OAuth авторизация</span>
              </div>
              <p className="text-sm text-black/70">Нажмите "Добавить" для автоматического получения токенов доступа через OAuth.</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Icon icon="pixelarticons:upload" width="20" style={{ color: '#de610d' }} />
                <span className="font-bold text-black">Импорт токенов</span>
              </div>
              <p className="text-sm text-black/70">Используйте импорт для загрузки существующих файлов авторизации.</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Icon icon="pixelarticons:heart" width="20" style={{ color: '#de610d' }} />
                <span className="font-bold text-black">Проверка здоровья</span>
              </div>
              <p className="text-sm text-black/70">Система автоматически проверяет доступность провайдеров и отключает неработающие.</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Icon icon="pixelarticons:reload" width="20" style={{ color: '#de610d' }} />
                <span className="font-bold text-black">Балансировка нагрузки</span>
              </div>
              <p className="text-sm text-black/70">При наличии нескольких аккаунтов система автоматически распределяет запросы между ними.</p>
            </div>
          </div>
        </div>
      </div>

      {}
      {showOAuthModal && oauthData && (
        <div 
          className="fixed inset-0 bg-black/50 z-50 flex items-end md:items-center justify-center p-0 md:p-4"
          onClick={() => !oauthSuccess && setShowOAuthModal(false)}
        >
          <div 
            className="bg-white w-full md:max-w-lg md:rounded-2xl rounded-t-2xl max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {}
            {oauthSuccess && (
              <div className="absolute inset-0 bg-white z-10 flex items-center justify-center">
                <div className="text-center space-y-4">
                  <Icon icon="pixelarticons:check" width="64" style={{ color: '#10b981' }} className="mx-auto" />
                  <div>
                    <h3 className="text-2xl font-bold text-black">Успешно!</h3>
                    <p className="text-black/70 mt-2">Провайдер добавлен</p>
                  </div>
                </div>
              </div>
            )}

            {}
            <div className="sticky top-0 bg-white border-b border-gray-200 p-4 md:p-6 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Icon icon="pixelarticons:key" width="24" style={{ color: '#de610d' }} />
                <div>
                  <h3 className="font-bold text-black">OAuth авторизация</h3>
                  <p className="text-sm text-black/50">{oauthData.name}</p>
                </div>
              </div>
              <button 
                onClick={() => setShowOAuthModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Icon icon="pixelarticons:close" width="20" />
              </button>
            </div>

            {}
            <div className="p-4 md:p-6 space-y-6">
              {}
              <div className="flex flex-col items-center gap-3 p-6 bg-gray-50 rounded-xl">
                <img 
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(oauthData.url)}`}
                  alt="QR код"
                  className="w-48 h-48 rounded-lg"
                />
                <p className="text-sm text-black/70 text-center">Отсканируйте QR-код камерой телефона</p>
              </div>

              {}
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-[#de610d] text-white flex items-center justify-center text-sm font-bold flex-shrink-0">1</div>
                  <div>
                    <p className="text-sm text-black font-medium">Откройте ссылку</p>
                    <p className="text-xs text-black/50">Отсканируйте QR-код или нажмите кнопку ниже</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-[#de610d] text-white flex items-center justify-center text-sm font-bold flex-shrink-0">2</div>
                  <div>
                    <p className="text-sm text-black font-medium">Авторизуйтесь</p>
                    <p className="text-xs text-black/50">Войдите в свой аккаунт и разрешите доступ</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-[#de610d] text-white flex items-center justify-center text-sm font-bold flex-shrink-0">3</div>
                  <div>
                    <p className="text-sm text-black font-medium">Готово</p>
                    <p className="text-xs text-black/50">Токены будут автоматически сохранены</p>
                  </div>
                </div>
              </div>

              {}
              <a
                href={oauthData.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full bg-[#de610d] hover:bg-[#c55a0b] text-white py-3 rounded-xl font-bold text-center transition-colors"
              >
                Открыть ссылку авторизации
              </a>

              {}
              <div className="space-y-2">
                <label className="text-xs text-black/50">Ссылка для авторизации</label>
                <div className="bg-gray-100 rounded-xl p-3 break-all">
                  <code className="text-xs text-black">{oauthData.url}</code>
                </div>
              </div>

              {}
              <div className="space-y-2 p-4 bg-yellow-50 border border-yellow-200 rounded-xl">
                <div className="flex items-start gap-2">
                  <Icon icon="pixelarticons:info" width="16" className="mt-0.5 flex-shrink-0" style={{ color: '#f59e0b' }} />
                  <div className="space-y-2 flex-1">
                    <p className="text-xs text-black/70">
                      Если после авторизации появится ошибка "Не удается получить доступ к сайту", скопируйте <strong>полный URL</strong> из адресной строки браузера и вставьте ниже:
                    </p>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder="Вставьте URL с code=..."
                        className="flex-1 px-3 py-2 text-sm border border-yellow-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#de610d]"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const url = (e.target as HTMLInputElement).value;
                            if (url) handleManualCallback(url);
                          }
                        }}
                      />
                      <button
                        onClick={(e) => {
                          const input = e.currentTarget.previousElementSibling as HTMLInputElement;
                          if (input?.value) handleManualCallback(input.value);
                        }}
                        className="px-4 py-2 bg-[#de610d] hover:bg-[#c55a0b] text-white rounded-lg text-sm font-bold transition-colors"
                      >
                        Отправить
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {}
      {showDetailsModal && selectedProvider && (
        <div 
          className="fixed inset-0 bg-black/50 z-50 flex items-end md:items-center justify-center p-0 md:p-4"
          onClick={() => setShowDetailsModal(false)}
        >
          <div 
            className="bg-white w-full md:max-w-3xl md:rounded-2xl rounded-t-3xl max-h-[85vh] md:max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {}
            <div className="bg-white border-b border-gray-200 p-4 md:p-6 flex items-center justify-between flex-shrink-0">
              <div className="flex-1">
                <h3 className="font-bold text-lg md:text-xl text-black">{selectedProvider.providerType}</h3>
                <p className="text-xs md:text-sm text-black/50 mt-1">
                  Всего: {selectedProvider.totalCount} | Здоровых: {selectedProvider.healthyCount}
                </p>
              </div>
              <button 
                onClick={() => setShowDetailsModal(false)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors flex-shrink-0"
              >
                <Icon icon="pixelarticons:close" width="20" />
              </button>
            </div>

            {}
            <div className="p-4 md:p-6 space-y-3 overflow-y-auto flex-1">
              {selectedProvider.providers.length === 0 ? (
                <div className="text-center py-12 text-black/50">
                  <Icon icon="pixelarticons:inbox" width="48" className="mx-auto mb-4" />
                  <p>Нет аккаунтов</p>
                </div>
              ) : (
                selectedProvider.providers.map((account: any, idx: number) => (
                  <div key={account.uuid || idx} className="bg-gray-50 rounded-xl p-3 md:p-4 space-y-3">
                    {}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Icon 
                          icon={account.isHealthy && !account.isDisabled ? "pixelarticons:check" : "pixelarticons:close"} 
                          width="16" 
                          style={{ color: account.isHealthy && !account.isDisabled ? '#10b981' : '#ef4444' }} 
                        />
                        <span className="text-xs md:text-sm font-mono text-black font-bold">
                          {account.customName || account.uuid?.substring(0, 8) || `Account ${idx + 1}`}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {account.isDisabled && (
                          <span className="text-[10px] md:text-xs px-2 py-1 bg-gray-200 text-black/70 rounded">
                            Отключен
                          </span>
                        )}
                        {!account.isHealthy && !account.isDisabled && (
                          <span className="text-[10px] md:text-xs px-2 py-1 bg-red-100 text-red-700 rounded">
                            Нездоров
                          </span>
                        )}
                      </div>
                    </div>

                    {}
                    <div className="grid grid-cols-2 gap-2 text-[10px] md:text-xs">
                      <div className="flex justify-between">
                        <span className="text-black/50">Использований:</span>
                        <span className="font-bold text-black">{account.usageCount || 0}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-black/50">Ошибок:</span>
                        <span className="font-bold text-black">{account.errorCount || 0}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-black/50">Последнее использование:</span>
                        <span className="font-bold text-black text-[9px] md:text-[10px]">
                          {account.lastUsed ? new Date(account.lastUsed).toLocaleString('ru-RU', { 
                            day: '2-digit', 
                            month: '2-digit', 
                            hour: '2-digit', 
                            minute: '2-digit' 
                          }) : 'Никогда'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-black/50">Последняя проверка:</span>
                        <span className="font-bold text-black text-[9px] md:text-[10px]">
                          {account.lastHealthCheckTime ? new Date(account.lastHealthCheckTime).toLocaleString('ru-RU', { 
                            day: '2-digit', 
                            month: '2-digit', 
                            hour: '2-digit', 
                            minute: '2-digit' 
                          }) : 'Никогда'}
                        </span>
                      </div>
                    </div>

                    {}
                    {!account.isHealthy && account.lastErrorMessage && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-[10px] md:text-xs">
                        <div className="flex items-start gap-2">
                          <Icon icon="pixelarticons:alert" width="14" className="flex-shrink-0 mt-0.5" style={{ color: '#ef4444' }} />
                          <div className="flex-1">
                            <span className="font-bold text-red-700">Последняя ошибка:</span>
                            <p className="text-red-600 mt-1 break-words">{account.lastErrorMessage}</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {}
                    <div className="border-t border-gray-200 pt-2">
                      <div className="text-[9px] md:text-[10px] text-black/50">Путь к конфигурации:</div>
                      <div className="mt-1 font-mono text-black/70 text-[9px] md:text-[10px] break-all bg-white rounded px-2 py-1">
                        {(Object.values(account).find(v => typeof v === 'string' && v.includes('configs/')) as string | undefined) || 'N/A'}
                      </div>
                    </div>

                    {}
                    {account.uuid && (
                      <div className="text-[9px] md:text-[10px] text-black/40 font-mono">
                        UUID: {account.uuid}
                      </div>
                    )}

                    {}
                    <div className="flex gap-2 pt-2 border-t border-gray-200">
                      {}
                      {confirmingAction?.uuid === account.uuid && confirmingAction?.action === 'refresh' ? (
                        <div className="flex-1 flex gap-2">
                          <button
                            onClick={async () => {
                              setLoadingAction({ uuid: account.uuid, action: 'refresh' });
                              setConfirmingAction(null);
                              try {
                                const res = await fetch(`/api/providers/${selectedProvider.providerType}/${account.uuid}/refresh`, {
                                  method: 'POST',
                                });
                                if (res.ok) {
                                  const detailsRes = await fetch(`/api/providers/${selectedProvider.providerType}`);
                                  const data = await detailsRes.json();
                                  setSelectedProvider(data);
                                  loadProviders();
                                }
                              } catch (error) {
                                console.error('Refresh error:', error);
                              } finally {
                                setLoadingAction(null);
                              }
                            }}
                            className="flex-1 bg-[#de610d] hover:bg-[#c55a0b] text-white px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2"
                          >
                            <Icon icon="pixelarticons:check" width="14" />
                            Да
                          </button>
                          <button
                            onClick={() => setConfirmingAction(null)}
                            className="flex-1 bg-white hover:bg-gray-50 border-2 border-gray-200 text-black px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2"
                          >
                            <Icon icon="pixelarticons:close" width="14" />
                            Нет
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmingAction({ uuid: account.uuid, action: 'refresh' })}
                          disabled={loadingAction?.uuid === account.uuid}
                          className="flex-1 bg-white hover:bg-gray-50 border-2 border-gray-200 hover:border-[#de610d] text-black px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {loadingAction?.uuid === account.uuid && loadingAction?.action === 'refresh' ? (
                            <>
                              <Icon icon="pixelarticons:sync" width="14" style={{ color: '#de610d' }} className="animate-spin" />
                              Обновление...
                            </>
                          ) : (
                            <>
                              <Icon icon="pixelarticons:sync" width="14" style={{ color: '#de610d' }} />
                              Обновить токен
                            </>
                          )}
                        </button>
                      )}

                      {}
                      {confirmingAction?.uuid === account.uuid && confirmingAction?.action === 'delete' ? (
                        <div className="flex-1 flex gap-2">
                          <button
                            onClick={async () => {
                              setLoadingAction({ uuid: account.uuid, action: 'delete' });
                              setConfirmingAction(null);
                              try {
                                const res = await fetch(`/api/providers/${selectedProvider.providerType}/${account.uuid}`, {
                                  method: 'DELETE',
                                });
                                if (res.ok) {
                                  const detailsRes = await fetch(`/api/providers/${selectedProvider.providerType}`);
                                  const data = await detailsRes.json();
                                  setSelectedProvider(data);
                                  loadProviders();
                                }
                              } catch (error) {
                                console.error('Delete error:', error);
                              } finally {
                                setLoadingAction(null);
                              }
                            }}
                            className="flex-1 bg-red-500 hover:bg-red-600 text-white px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2"
                          >
                            <Icon icon="pixelarticons:check" width="14" />
                            Да
                          </button>
                          <button
                            onClick={() => setConfirmingAction(null)}
                            className="flex-1 bg-white hover:bg-gray-50 border-2 border-gray-200 text-black px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2"
                          >
                            <Icon icon="pixelarticons:close" width="14" />
                            Нет
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmingAction({ uuid: account.uuid, action: 'delete' })}
                          disabled={loadingAction?.uuid === account.uuid}
                          className="flex-1 bg-white hover:bg-gray-50 border-2 border-gray-200 hover:border-red-500 text-black hover:text-red-600 px-3 py-2 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {loadingAction?.uuid === account.uuid && loadingAction?.action === 'delete' ? (
                            <>
                              <Icon icon="pixelarticons:sync" width="14" className="animate-spin" />
                              Удаление...
                            </>
                          ) : (
                            <>
                              <Icon icon="pixelarticons:trash" width="14" />
                              Удалить
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {}
      {showAddModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Icon icon="pixelarticons:plus" width={24} style={{ color: '#de610d' }} />
                  <h2 className="text-xl font-bold">Добавить провайдер</h2>
                </div>
                <button
                  onClick={() => setShowAddModal(false)}
                  className="text-black/50 hover:text-black transition-colors"
                >
                  <Icon icon="pixelarticons:close" width={24} />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              {}
              <div>
                <label className="block text-sm font-bold mb-2">Название (опционально)</label>
                <input
                  type="text"
                  value={addFormData.customName || ''}
                  onChange={(e) => setAddFormData({ ...addFormData, customName: e.target.value })}
                  placeholder="Мой провайдер"
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
                />
              </div>

              {}
              {Object.keys(addFormData).filter(k => k !== 'customName').map(key => (
                <div key={key}>
                  <label className="block text-sm font-bold mb-2">
                    {key.replace(/_/g, ' ')}
                  </label>
                  <input
                    type={key.includes('KEY') || key.includes('TOKEN') ? 'password' : 'text'}
                    value={addFormData[key] || ''}
                    onChange={(e) => setAddFormData({ ...addFormData, [key]: e.target.value })}
                    placeholder={addFormData[key] || ''}
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
                  />
                </div>
              ))}
            </div>

            <div className="p-6 border-t border-gray-200 flex gap-3">
              <button
                onClick={handleSaveProvider}
                className="flex-1 bg-[#de610d] hover:bg-[#c55a0b] text-white px-6 py-3 rounded-xl font-bold transition-all flex items-center justify-center gap-2"
              >
                <Icon icon="pixelarticons:save" width={20} />
                Сохранить
              </button>
              <button
                onClick={() => setShowAddModal(false)}
                className="flex-1 bg-white hover:bg-gray-50 border-2 border-gray-200 text-black px-6 py-3 rounded-xl font-bold transition-all"
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
