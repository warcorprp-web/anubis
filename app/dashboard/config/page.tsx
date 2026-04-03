'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@iconify-icon/react';

export default function ConfigPage() {
  const [apiKey, setApiKey] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [requestMaxRetries, setRequestMaxRetries] = useState(3);
  const [requestBaseDelay, setRequestBaseDelay] = useState(1000);
  const [credentialSwitchMaxRetries, setCredentialSwitchMaxRetries] = useState(5);
  const [maxErrorCount, setMaxErrorCount] = useState(10);
  const [systemPromptContent, setSystemPromptContent] = useState('');
  const [systemPromptMode, setSystemPromptMode] = useState<'append' | 'overwrite'>('append');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const generateApiKey = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = 'anubis-';
    for (let i = 0; i < 48; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setApiKey(key);
  };

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/config', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      const data = await res.json();
      setApiKey(data.apiKey || '');
      setAdminPassword(data.adminPassword || '');
      setRequestMaxRetries(data.requestMaxRetries || 3);
      setRequestBaseDelay(data.requestBaseDelay || 1000);
      setCredentialSwitchMaxRetries(data.credentialSwitchMaxRetries || 5);
      setMaxErrorCount(data.maxErrorCount || 10);
      setSystemPromptContent(data.systemPromptContent || '');
      setSystemPromptMode(data.systemPromptMode || 'append');
    } catch (error) {
      console.error('Failed to load config:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ 
          apiKey, 
          adminPassword,
          requestMaxRetries,
          requestBaseDelay,
          credentialSwitchMaxRetries,
          maxErrorCount,
          systemPromptContent,
          systemPromptMode
        }),
      });
      if (res.ok) {
        
      }
    } catch (error) {
      console.error('Failed to save config:', error);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Icon icon="pixelarticons:sync" width={32} className="animate-spin" style={{ color: '#de610d' }} />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="space-y-8">
        {}
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <Icon icon="pixelarticons:sliders" width={24} style={{ color: '#de610d' }} />
            <h1 className="text-2xl font-bold">Настройки</h1>
          </div>
          <p className="text-black/50 text-sm">
            Управление ключом API и паролем администратора
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {}
          <div className="bg-white rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Icon icon="pixelarticons:coin" width={20} style={{ color: '#de610d' }} />
              <h2 className="font-bold">API ключ</h2>
            </div>
            <p className="text-black/50 text-sm">
              Ключ для авторизации запросов к API серверу
            </p>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Введите API ключ"
                className="w-full px-4 py-3 pr-24 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2 flex gap-1">
                <div
                  onClick={generateApiKey}
                  onMouseDown={(e) => e.preventDefault()}
                  className="p-2 cursor-pointer hover:opacity-70 select-none"
                  style={{ zIndex: 999, userSelect: 'none' }}
                  title="Генерировать ключ"
                >
                  <Icon
                    icon="pixelarticons:reload"
                    width={20}
                    style={{ color: '#de610d', pointerEvents: 'none' }}
                  />
                </div>
                <div
                  onClick={() => setShowApiKey(!showApiKey)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="p-2 cursor-pointer hover:opacity-70 select-none"
                  style={{ zIndex: 999, userSelect: 'none' }}
                >
                  <Icon
                    icon={showApiKey ? 'pixelarticons:eye-closed' : 'pixelarticons:eye'}
                    width={20}
                    style={{ color: '#6b7280', pointerEvents: 'none' }}
                  />
                </div>
              </div>
            </div>
          </div>

          {}
          <div className="bg-white rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <Icon icon="pixelarticons:lock" width={20} style={{ color: '#de610d' }} />
              <h2 className="font-bold">Пароль администратора</h2>
            </div>
            <p className="text-black/50 text-sm">
              Пароль для входа в панель управления
            </p>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder="Введите пароль"
                className="w-full px-4 py-3 pr-12 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
              />
              <div
                onClick={() => setShowPassword(!showPassword)}
                onMouseDown={(e) => e.preventDefault()}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-2 cursor-pointer hover:opacity-70 select-none"
                style={{ zIndex: 999, userSelect: 'none' }}
              >
                <Icon
                  icon={showPassword ? 'pixelarticons:eye-closed' : 'pixelarticons:eye'}
                  width={20}
                  style={{ color: '#6b7280', pointerEvents: 'none' }}
                />
              </div>
            </div>
          </div>
        </div>

        {}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Icon icon="pixelarticons:sliders" width={20} style={{ color: '#de610d' }} />
            <h2 className="font-bold">Настройки повторных попыток</h2>
          </div>
          <p className="text-black/50 text-sm">
            Управление поведением системы при ошибках и переключении провайдеров
          </p>
        </div>

        {}
        <div className="lg:hidden bg-white rounded-xl p-6 space-y-6">
          <div className="space-y-4">
            <h3 className="font-bold text-sm">Максимальное количество повторных попыток провайдера</h3>
            <input
              type="number"
              value={requestMaxRetries}
              onChange={(e) => setRequestMaxRetries(parseInt(e.target.value) || 3)}
              min="0"
              max="10"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-4">
            <h3 className="font-bold text-sm">Базовая задержка повторной попытки (мс)</h3>
            <input
              type="number"
              value={requestBaseDelay}
              onChange={(e) => setRequestBaseDelay(parseInt(e.target.value) || 1000)}
              min="100"
              max="10000"
              step="100"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-4">
            <h3 className="font-bold text-sm">Максимальное количество попыток переключения учетных данных</h3>
            <input
              type="number"
              value={credentialSwitchMaxRetries}
              onChange={(e) => setCredentialSwitchMaxRetries(parseInt(e.target.value) || 5)}
              min="0"
              max="20"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-4">
            <h3 className="font-bold text-sm">Максимальное количество ошибок провайдера</h3>
            <input
              type="number"
              value={maxErrorCount}
              onChange={(e) => setMaxErrorCount(parseInt(e.target.value) || 10)}
              min="1"
              max="100"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
            />
          </div>
        </div>

        {}
        <div className="hidden lg:grid grid-cols-2 gap-6">
          {}
          <div className="bg-white rounded-xl p-6 space-y-4">
            <h3 className="font-bold text-sm">Максимальное количество повторных попыток провайдера</h3>
            <input
              type="number"
              value={requestMaxRetries}
              onChange={(e) => setRequestMaxRetries(parseInt(e.target.value) || 3)}
              min="0"
              max="10"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
            />
          </div>

          {}
          <div className="bg-white rounded-xl p-6 space-y-4">
            <h3 className="font-bold text-sm">Базовая задержка повторной попытки (мс)</h3>
            <input
              type="number"
              value={requestBaseDelay}
              onChange={(e) => setRequestBaseDelay(parseInt(e.target.value) || 1000)}
              min="100"
              max="10000"
              step="100"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
            />
          </div>

          {}
          <div className="bg-white rounded-xl p-6 space-y-4">
            <h3 className="font-bold text-sm">Максимальное количество попыток переключения учетных данных</h3>
            <input
              type="number"
              value={credentialSwitchMaxRetries}
              onChange={(e) => setCredentialSwitchMaxRetries(parseInt(e.target.value) || 5)}
              min="0"
              max="20"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
            />
          </div>

          {}
          <div className="bg-white rounded-xl p-6 space-y-4">
            <h3 className="font-bold text-sm">Максимальное количество ошибок провайдера</h3>
            <input
              type="number"
              value={maxErrorCount}
              onChange={(e) => setMaxErrorCount(parseInt(e.target.value) || 10)}
              min="1"
              max="100"
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors"
            />
          </div>
        </div>

        {}
        <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
          <Icon icon="pixelarticons:message-text" width={24} style={{ color: '#de610d' }} />
          Системный промпт
        </h2>
        <p className="text-gray-600 mb-6">
          Настройте системный промпт, который будет автоматически добавляться к каждому запросу
        </p>

        <div className="grid grid-cols-1 gap-6 mb-8">
          {}
          <div className="bg-white rounded-xl p-6 space-y-4">
            <h3 className="font-bold text-sm">Содержимое системного промпта</h3>
            <textarea
              value={systemPromptContent}
              onChange={(e) => setSystemPromptContent(e.target.value)}
              placeholder="Введите системный промпт, который будет добавлен к каждому запросу..."
              rows={8}
              className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:border-[#de610d] focus:outline-none transition-colors resize-none text-base"
            />
          </div>

          {}
          <div className="bg-white rounded-xl p-6 space-y-4">
            <h3 className="font-bold text-sm">Режим применения</h3>
            <div className="flex gap-3">
              <button
                onClick={() => setSystemPromptMode('append')}
                className={`flex-1 px-4 py-3 rounded-xl font-bold transition-all ${
                  systemPromptMode === 'append'
                    ? 'bg-[#de610d] text-white'
                    : 'bg-white border-2 border-gray-200 hover:border-[#de610d]'
                }`}
              >
                Добавить
              </button>
              <button
                onClick={() => setSystemPromptMode('overwrite')}
                className={`flex-1 px-4 py-3 rounded-xl font-bold transition-all ${
                  systemPromptMode === 'overwrite'
                    ? 'bg-[#de610d] text-white'
                    : 'bg-white border-2 border-gray-200 hover:border-[#de610d]'
                }`}
              >
                Заменить
              </button>
            </div>
            <p className="text-xs text-gray-500">
              {systemPromptMode === 'append' 
                ? 'Добавить к существующему системному промпту в запросе'
                : 'Заменить системный промпт в запросе'}
            </p>
          </div>
        </div>

        {}
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-[#de610d] hover:bg-[#c55a0b] text-white px-6 py-3 rounded-xl font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? (
            <>
              <Icon icon="pixelarticons:sync" width={20} className="animate-spin" />
              Сохранение...
            </>
          ) : (
            <>
              <Icon icon="pixelarticons:save" width={20} />
              Сохранить настройки
            </>
          )}
        </button>
      </div>
    </div>
  );
}
