'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@iconify-icon/react';

interface RoutingExample {
  provider: string;
  name: string;
  paths: {
    openai: string;
    claude: string;
  };
  description: string;
  badge: string;
  badgeClass: string;
  icon: string;
  defaultModel: string;
}

function RoutingCard({ route }: { route: RoutingExample }) {
  const [activeProtocol, setActiveProtocol] = useState<'openai' | 'claude'>('openai');
  const hostname = typeof window !== 'undefined' ? 
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 
      `http://${window.location.host}` : 
      `${window.location.protocol}//${window.location.host}`) : '';

  const badgeColors = {
    official: 'text-green-600',
    oauth: 'text-[#de610d]',
    responses: 'text-blue-600',
  };

  return (
    <div className="bg-white rounded-xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon icon={route.icon} width="20" style={{ color: '#de610d' }} />
          <span className="font-bold text-black">{route.name}</span>
        </div>
        <span className={`text-xs font-bold ${badgeColors[route.badgeClass as keyof typeof badgeColors] || badgeColors.oauth}`}>
          {route.badge}
        </span>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setActiveProtocol('openai')}
          className={`px-3 py-1 text-sm rounded-xl transition-colors ${
            activeProtocol === 'openai' 
              ? 'bg-[#de610d] text-white' 
              : 'bg-gray-100 text-black/70 hover:bg-gray-200'
          }`}
        >
          OpenAI
        </button>
        <button
          onClick={() => setActiveProtocol('claude')}
          className={`px-3 py-1 text-sm rounded-xl transition-colors ${
            activeProtocol === 'claude' 
              ? 'bg-[#de610d] text-white' 
              : 'bg-gray-100 text-black/70 hover:bg-gray-200'
          }`}
        >
          Claude
        </button>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-black/50">Endpoint</label>
        <div className="bg-[#1f2937] rounded-xl p-3">
          <code className="text-xs text-white break-all">
            {route.paths[activeProtocol]}
          </code>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs text-black/50">
          {activeProtocol === 'openai' ? 'Пример OpenAI' : 'Пример Claude'}
        </label>
        <div className="bg-[#1f2937] rounded-xl p-3 overflow-x-auto">
          <pre className="text-xs text-white">
            <code>{`curl ${hostname}${route.paths[activeProtocol]} \\
  -H "Content-Type: application/json" \\
  -H "${activeProtocol === 'openai' ? 'Authorization: Bearer YOUR_API_KEY' : 'X-API-Key: YOUR_API_KEY'}" \\
  -d '{
    "model": "${route.defaultModel}",
    ${activeProtocol === 'claude' ? '"max_tokens": 1000,\n    ' : ''}"messages": [{"role": "user", "content": "Hello!"}]${activeProtocol === 'openai' ? ',\n    "max_tokens": 1000' : ''}
  }'`}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState({
    totalProviders: 0,
    activeProviders: 0,
  });

  const [systemInfo, setSystemInfo] = useState({
    memory: '--',
    cpu: '--',
    uptime: '--',
    serverTime: '--',
  });

  const [routingExamples, setRoutingExamples] = useState<RoutingExample[]>([]);

  useEffect(() => {
    
    fetch('/api/providers')
      .then(res => res.json())
      .then(data => {
        const providers = Object.values(data).flat() as any[];
        setStats({
          totalProviders: providers.length,
          activeProviders: providers.filter((p: any) => !p.isDisabled && p.isHealthy).length,
        });
      });

    
    const loadSystemInfo = () => {
      fetch('/api/system')
        .then(res => res.json())
        .then(data => setSystemInfo(data));
    };
    
    loadSystemInfo();
    const interval = setInterval(loadSystemInfo, 5000);

    
    fetch('/api/routing-examples')
      .then(res => res.json())
      .then(data => setRoutingExamples(data));

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="space-y-8">
        {}
        <div className="space-y-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <Icon icon="pixelarticons:zap" width="24" style={{ color: '#de610d' }} />
              <span className="text-2xl font-bold text-black">Дашборд</span>
            </div>
            <a 
              href="/docs" 
              className="flex items-center gap-2 px-4 py-2 bg-white rounded-xl hover:bg-gray-50 transition-colors"
            >
              <Icon icon="pixelarticons:book" width="20" style={{ color: '#de610d' }} />
              <span className="font-bold text-sm">Документация</span>
            </a>
          </div>
          <p className="text-lg lg:text-xl text-black/70 max-w-2xl leading-relaxed">
            Централизованное управление AI провайдерами.
            <span className="block mt-2 text-black/50 text-base">
              Claude • Qwen • ГигаЧат • OpenAI
            </span>
          </p>
        </div>

        {}
        <div className="bg-white rounded-2xl p-4 lg:p-6">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4">
            <div className="space-y-1">
              <h3 className="text-lg lg:text-xl font-bold text-black flex items-center gap-2">
                <Icon icon="pixelarticons:heart" width="20" style={{ color: '#de610d' }} />
                Поддержать проект ANUBIS
              </h3>
              <p className="text-sm text-black/70">Ваша поддержка помогает развивать проект и добавлять новые функции</p>
            </div>
            <div className="flex items-center gap-3 lg:gap-4">
              {}
              <div className="hidden lg:flex flex-col items-center gap-1">
                <img 
                  src="https://api.qrserver.com/v1/create-qr-code/?size=70x70&data=https://pay.cloudtips.ru/p/555c83ec&bgcolor=ffffff&color=de610d" 
                  alt="QR код для доната"
                  className="rounded"
                />
                <span className="text-xs text-black/50">Сканируйте</span>
              </div>
              {}
              <a 
                href="https://pay.cloudtips.ru/p/555c83ec" 
                target="_blank" 
                rel="noopener noreferrer"
                className="bg-[#de610d] hover:bg-[#c55a0b] text-white px-5 py-2.5 rounded-xl font-bold transition-colors flex items-center gap-2 text-sm lg:text-base whitespace-nowrap"
              >
                <Icon icon="pixelarticons:coin" width="18" />
                Поддержать
              </a>
            </div>
          </div>
        </div>

        {}
        <div className="space-y-4">
          <h3 className="text-xl font-bold text-black flex items-center gap-2">
            <Icon icon="pixelarticons:device-desktop" width="24" />
            Системная информация
          </h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-black/70">
                <Icon icon="pixelarticons:frame-minus" width="16" />
                <span>ОЗУ</span>
              </div>
              <div className="text-xl font-bold text-black">{systemInfo.memory}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-black/70">
                <Icon icon="pixelarticons:cpu" width="16" />
                <span>ЦПУ</span>
              </div>
              <div className="text-xl font-bold text-black">{systemInfo.cpu}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-black/70">
                <Icon icon="pixelarticons:clock" width="16" />
                <span>Uptime</span>
              </div>
              <div className="text-xl font-bold text-black">{systemInfo.uptime}</div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-black/70">
                <Icon icon="pixelarticons:calendar" width="16" />
                <span>Время</span>
              </div>
              <div className="text-base font-bold text-black">{systemInfo.serverTime}</div>
            </div>
          </div>
        </div>

        {}
        <div className="space-y-4">
          <h3 className="text-2xl font-bold text-black flex items-center gap-2">
            <Icon icon="pixelarticons:route" width="24" style={{ color: '#de610d' }} />
            Примеры API маршрутов
          </h3>
          <p className="text-black/70">Доступ к различным AI провайдерам через разные пути API</p>
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {routingExamples.length === 0 ? (
              <div className="col-span-2 text-center py-8 text-black/50">
                <Icon icon="pixelarticons:loading" width="24" className="animate-spin mx-auto mb-2" />
                Загрузка...
              </div>
            ) : (
              routingExamples.map((route) => (
                <RoutingCard key={route.provider} route={route} />
              ))
            )}
          </div>
        </div>

        {}
        <div className="space-y-6">
          <h3 className="text-2xl font-bold text-black flex items-center gap-2">
            <Icon icon="pixelarticons:lightbulb" width="24" style={{ color: '#de610d' }} />
            Советы
          </h3>
          <ul className="space-y-4 text-black/70">
            <li className="flex items-start gap-3">
              <Icon icon="pixelarticons:check" width="20" className="mt-1 flex-shrink-0" style={{ color: '#de610d' }} />
              <div className="space-y-1">
                <div className="font-bold text-black">Быстрое переключение</div>
                <div>Измените путь URL для переключения между провайдерами</div>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <Icon icon="pixelarticons:check" width="20" className="mt-1 flex-shrink-0" style={{ color: '#de610d' }} />
              <div className="space-y-1">
                <div className="font-bold text-black">Настройка клиентов</div>
                <div>Укажите соответствующий путь в Cherry-Studio, NextChat, Cline</div>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <Icon icon="pixelarticons:check" width="20" className="mt-1 flex-shrink-0" style={{ color: '#de610d' }} />
              <div className="space-y-1">
                <div className="font-bold text-black">Кросс-протокол</div>
                <div>Поддержка вызова Claude через OpenAI API и наоборот</div>
              </div>
            </li>
          </ul>
        </div>

        {}
        <div className="bg-white rounded-2xl p-8 text-center space-y-3">
          <p className="text-gray-600 flex items-center justify-center gap-2">
            Создано силами 
            <a href="https://trovu.tech/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:opacity-80 transition-opacity">
              <Icon icon="streamline-pixel:technology-robot-ai" width="20" style={{ color: '#de610d' }} />
              <span className="font-bold" style={{ color: '#de610d' }}>trovu</span><span className="font-bold">.tech</span>
            </a>
          </p>
          <p className="text-sm text-gray-500">
            Универсальный AI прокси для управления множественными провайдерами
          </p>
        </div>
      </div>
    </div>
  );
}
