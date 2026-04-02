'use client';

import { Icon } from '@iconify-icon/react';

export default function DocsPage() {
  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="space-y-8">
        {}
        <div className="space-y-6">
          <div className="flex items-center gap-3 mb-2">
            <Icon icon="pixelarticons:book" width="24" style={{ color: '#de610d' }} />
            <span className="text-2xl font-bold text-black">Документация</span>
          </div>
          <p className="text-black/50">
            Универсальный AI прокси для управления множественными провайдерами
          </p>
        </div>

        {}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <Icon icon="pixelarticons:question" width="24" style={{ color: '#de610d' }} />
            <h2 className="text-xl font-bold">Что это?</h2>
          </div>
          <p className="text-gray-700 leading-relaxed">
            ANUBIS — это прокси-сервер, который объединяет доступ к различным AI провайдерам (OpenAI, Claude, Gemini, Qwen, Grok) 
            через единый API. Вы можете использовать один endpoint для всех моделей, а система автоматически выберет 
            здоровый провайдер и конвертирует протоколы.
          </p>
        </section>

        {}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <Icon icon="pixelarticons:lightbulb" width="24" style={{ color: '#de610d' }} />
            <h2 className="text-xl font-bold">Зачем это нужно?</h2>
          </div>
          <ul className="space-y-3 text-gray-700">
            <li className="flex items-start gap-3">
              <Icon icon="pixelarticons:check" width="20" className="mt-1 flex-shrink-0" style={{ color: '#10b981' }} />
              <div>
                <div className="font-bold">Единый интерфейс</div>
                <div>Один API для всех провайдеров — не нужно переписывать код при смене модели</div>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <Icon icon="pixelarticons:check" width="20" className="mt-1 flex-shrink-0" style={{ color: '#10b981' }} />
              <div>
                <div className="font-bold">CLI инструменты как API</div>
                <div>Используйте доступ к AI от CLI инструментов (gcloud, aws-cli) в качестве обычного REST API</div>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <Icon icon="pixelarticons:check" width="20" className="mt-1 flex-shrink-0" style={{ color: '#10b981' }} />
              <div>
                <div className="font-bold">Автоматический фейловер</div>
                <div>Если один провайдер недоступен, система переключится на другой</div>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <Icon icon="pixelarticons:check" width="20" className="mt-1 flex-shrink-0" style={{ color: '#10b981' }} />
              <div>
                <div className="font-bold">Конвертация протоколов</div>
                <div>Отправляйте запросы в формате OpenAI, получайте ответы от Claude/Gemini</div>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <Icon icon="pixelarticons:check" width="20" className="mt-1 flex-shrink-0" style={{ color: '#10b981' }} />
              <div>
                <div className="font-bold">Управление токенами</div>
                <div>Автоматическое обновление OAuth токенов и мониторинг здоровья</div>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <Icon icon="pixelarticons:check" width="20" className="mt-1 flex-shrink-0" style={{ color: '#10b981' }} />
              <div>
                <div className="font-bold">Балансировка нагрузки</div>
                <div>Распределение запросов между несколькими аккаунтами одного провайдера</div>
              </div>
            </li>
          </ul>
        </section>

        {}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <Icon icon="pixelarticons:cpu" width="24" style={{ color: '#de610d' }} />
            <h2 className="text-xl font-bold">Как это работает?</h2>
          </div>
          <ol className="space-y-3 text-gray-700">
            <li className="flex items-start gap-3">
              <span className="font-bold text-[#de610d]">1.</span>
              <div>
                <strong>Добавьте провайдеров:</strong> Подключите OAuth аккаунты (Gemini, Claude, Qwen) или укажите API ключи (OpenAI, Claude Custom)
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="font-bold text-[#de610d]">2.</span>
              <div>
                <strong>Отправьте запрос:</strong> Используйте универсальные endpoints <code className="bg-gray-200 px-2 py-1 rounded text-sm">/v1/chat/completions</code> (OpenAI) или <code className="bg-gray-200 px-2 py-1 rounded text-sm">/v1/messages</code> (Claude) — система автоматически выберет провайдера по модели
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="font-bold text-[#de610d]">3.</span>
              <div>
                <strong>Автовыбор провайдера:</strong> По названию модели определяется нужный провайдер (qwen3-coder-plus → Qwen, claude-sonnet → Claude, gemini-flash → Gemini)
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="font-bold text-[#de610d]">4.</span>
              <div>
                <strong>Балансировка:</strong> Система выбирает здоровый аккаунт с наименьшей нагрузкой
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="font-bold text-[#de610d]">5.</span>
              <div>
                <strong>Конвертация протокола:</strong> Запрос автоматически преобразуется в нужный формат провайдера
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="font-bold text-[#de610d]">6.</span>
              <div>
                <strong>Получите ответ:</strong> Ответ конвертируется обратно в запрошенный формат
              </div>
            </li>
          </ol>
        </section>

        {}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <Icon icon="pixelarticons:zap" width="24" style={{ color: '#de610d' }} />
            <h2 className="text-xl font-bold">Быстрый старт</h2>
          </div>
          <div className="space-y-4 text-gray-700">
            <p>
              <strong>1. Добавьте провайдера:</strong> Перейдите в <a href="/dashboard/providers" className="text-[#de610d] hover:underline">Провайдеры</a> и нажмите "Авторизоваться"
            </p>
            <p>
              <strong>2. Настройте API ключ:</strong> В <a href="/dashboard/config" className="text-[#de610d] hover:underline">Настройках</a> сгенерируйте API ключ
            </p>
            <p>
              <strong>3. Отправьте запрос (OpenAI формат):</strong>
            </p>
            <div className="bg-[#1f2937] rounded-xl p-4 overflow-x-auto">
              <pre className="text-sm text-white">
                <code>{`curl http://your-server:port/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "qwen3-coder-plus",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'`}</code>
              </pre>
            </div>
            <p>
              <strong>Или используйте Claude формат:</strong>
            </p>
            <div className="bg-[#1f2937] rounded-xl p-4 overflow-x-auto">
              <pre className="text-sm text-white">
                <code>{`curl http://your-server:port/v1/messages \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1000
  }'`}</code>
              </pre>
            </div>
            <p className="text-sm text-gray-600">
              <Icon icon="pixelarticons:info" width="16" className="inline" style={{ color: '#de610d' }} /> Можно также использовать прямые endpoints: <code className="bg-gray-200 px-2 py-1 rounded text-sm">/провайдер/v1/chat/completions</code>
            </p>
          </div>
        </section>

        {}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <Icon icon="pixelarticons:star" width="24" style={{ color: '#de610d' }} />
            <h2 className="text-xl font-bold">Возможности</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-gray-700">
            <div className="flex items-start gap-2">
              <Icon icon="pixelarticons:sync" width="20" className="mt-1 flex-shrink-0" style={{ color: '#de610d' }} />
              <span><strong>Автообновление токенов</strong> — OAuth токены обновляются автоматически</span>
            </div>
            <div className="flex items-start gap-2">
              <Icon icon="pixelarticons:heart" width="20" className="mt-1 flex-shrink-0" style={{ color: '#de610d' }} />
              <span><strong>Health checks</strong> — Мониторинг состояния провайдеров</span>
            </div>
            <div className="flex items-start gap-2">
              <Icon icon="pixelarticons:reload" width="20" className="mt-1 flex-shrink-0" style={{ color: '#de610d' }} />
              <span><strong>Retry механизм</strong> — Автоматические повторные попытки при ошибках</span>
            </div>
            <div className="flex items-start gap-2">
              <Icon icon="pixelarticons:message-text" width="20" className="mt-1 flex-shrink-0" style={{ color: '#de610d' }} />
              <span><strong>Системный промпт</strong> — Глобальный промпт для всех запросов</span>
            </div>
            <div className="flex items-start gap-2">
              <Icon icon="pixelarticons:switch" width="20" className="mt-1 flex-shrink-0" style={{ color: '#de610d' }} />
              <span><strong>Fallback цепочки</strong> — Переключение между провайдерами при сбоях</span>
            </div>
            <div className="flex items-start gap-2">
              <Icon icon="pixelarticons:chart-bar" width="20" className="mt-1 flex-shrink-0" style={{ color: '#de610d' }} />
              <span><strong>Статистика</strong> — Отслеживание использования и ошибок</span>
            </div>
          </div>
        </section>

        {}
        <div className="text-center pt-8">
          <p className="text-gray-600 flex items-center justify-center gap-2">
            Создано силами 
            <a href="https://trovu.tech/" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:opacity-80 transition-opacity">
              <Icon icon="streamline-pixel:technology-robot-ai" width="20" style={{ color: '#de610d' }} />
              <span className="font-bold" style={{ color: '#de610d' }}>trovu</span><span className="font-bold">.tech</span>
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
