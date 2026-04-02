# ANUBIS AI Proxy

Универсальный AI прокси для управления множественными провайдерами (OpenAI, Claude, Gemini, Qwen, Grok).

## 🚀 Быстрый старт

### Docker (рекомендуется)

```bash
# Клонируйте репозиторий
git clone <your-repo-url>
cd anubis-ui

# Создайте .env файл
cp .env.example .env
# Отредактируйте .env и укажите свои значения

# Запустите
docker-compose up -d

# Откройте http://localhost:5000
```

### Ручная установка

```bash
# Установите зависимости
npm install

# Создайте .env файл
cp .env.example .env

# Соберите проект
npm run build

# Запустите
npm start
```

## ⚙️ Конфигурация

### Переменные окружения

- `PORT` - Порт веб-интерфейса (по умолчанию: 5000)
- `REQUIRED_API_KEY` - API ключ для доступа к прокси (можно изменить в панели)

### Первый запуск

1. Откройте http://localhost:5000/login
2. Войдите с паролем **123456**
3. Перейдите в **Настройки** и измените пароль администратора
4. Сгенерируйте API ключ для доступа к прокси
5. Перейдите в **Провайдеры** и добавьте OAuth аккаунты
6. Готово! Используйте `/v1/chat/completions` для запросов

## 📖 Использование

### OpenAI формат

```bash
curl http://localhost:5000/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-plus",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

### Claude формат

```bash
curl http://localhost:5000/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_tokens": 1000
  }'
```

### Прямой доступ к провайдеру

```bash
curl http://localhost:5000/openai-qwen-oauth/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-plus",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## 🔧 Возможности

- ✅ Единый API для всех провайдеров
- ✅ Автоматическая конвертация протоколов (OpenAI ↔ Claude ↔ Gemini)
- ✅ Балансировка нагрузки между аккаунтами
- ✅ Автообновление OAuth токенов
- ✅ Health checks и автовосстановление
- ✅ Retry механизм с экспоненциальной задержкой
- ✅ Streaming для всех провайдеров
- ✅ Системный промпт (append/overwrite)
- ✅ Веб-интерфейс для управления

## 🔐 Безопасность

- Все данные хранятся локально в `./data` и `./configs`
- API ключ требуется для всех запросов
- OAuth токены шифруются
- Нет отправки данных на внешние серверы

## 📊 Мониторинг

- Health endpoint: `GET /api/health`
- Статус провайдеров: `GET /api/providers`
- Системная информация: `GET /api/system`

## 🛠️ Разработка

```bash
# Dev режим с hot reload
npm run dev

# Линтинг
npm run lint

# Сборка
npm run build
```

## 📝 Лицензия

MIT

## 🤝 Поддержка

Создано силами [trovu.tech](https://trovu.tech)
