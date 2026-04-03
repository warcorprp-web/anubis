# ANUBIS AI Proxy

<div align="center">
  <img src="public/favicon.svg" width="120" height="120" alt="ANUBIS Logo">
  
  **Универсальный self-hosted прокси для доступа к различным AI провайдерам**
  
  [Установка](#установка) • [Использование](#использование) • [Документация](#документация)
  
  <br>
  
  <a href="https://pay.cloudtips.ru/p/555c83ec">
    <img src="https://img.shields.io/badge/💰_Поддержать_проект-FF6B35?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTEyIDJMMTUuMDkgOC4yNkwyMiA5LjI3TDE3IDEzLjE0TDE4LjE4IDIyTDEyIDE4LjI3TDUuODIgMjJMNyAxMy4xNEwyIDkuMjdMOC45MSA4LjI2TDEyIDJaIiBmaWxsPSJ3aGl0ZSIvPgo8L3N2Zz4=" alt="Поддержать проект">
  </a>
  
  **ANUBIS бесплатен и всегда будет бесплатным. Ваша поддержка помогает развитию проекта.**
</div>

---

## Что это?

**ANUBIS** — это self-hosted прокси-сервер, который объединяет доступ к различным AI провайдерам (OpenAI, Claude, Gemini, Qwen, GigaChat, Grok) через единый API. Вы можете использовать один endpoint для всех моделей, а система автоматически выберет здоровый провайдер и конвертирует протоколы.

Все данные остаются на вашем сервере — никакой отправки информации третьим лицам.

## Зачем это нужно?

### Единый интерфейс
Один API для всех провайдеров — не нужно переписывать код при смене модели.

### CLI инструменты как API
Используйте доступ к AI от CLI инструментов (gcloud, aws-cli) в качестве обычного REST API.

### Автоматический фейловер
Если один провайдер недоступен, система переключится на другой.

### Конвертация протоколов
Отправляйте запросы в формате OpenAI, получайте ответы от Claude/Gemini.

### Управление токенами
Автоматическое обновление OAuth токенов и мониторинг здоровья.

### Балансировка нагрузки
Распределение запросов между несколькими аккаунтами одного провайдера.

## Как это работает?

1. **Добавьте провайдеров**  
   Подключите OAuth аккаунты (Gemini, Claude, Qwen, GigaChat) или укажите API ключи (OpenAI, Claude Custom)

2. **Отправьте запрос**  
   Используйте универсальные endpoints `/v1/chat/completions` (OpenAI) или `/v1/messages` (Claude)

3. **Автовыбор провайдера**  
   По названию модели определяется нужный провайдер:
   - `qwen3-coder-plus` → Qwen
   - `claude-sonnet-4-5` → Claude
   - `gemini-2.5-flash` → Gemini
   - `GigaChat` → Сбер ГигаЧат

4. **Балансировка**  
   Система выбирает здоровый аккаунт с наименьшей нагрузкой

5. **Конвертация протокола**  
   Запрос автоматически преобразуется в нужный формат провайдера

6. **Получите ответ**  
   Ответ конвертируется обратно в запрошенный формат

## Установка

### Автоматическая установка (рекомендуется)

```bash
# Клонируйте репозиторий
git clone https://github.com/warcorprp-web/anubis.git
cd anubis

# Запустите установку (автоматически установит Docker если нужно)
chmod +x install.sh
./install.sh
```

Скрипт автоматически:
- Установит Docker и Docker Compose (если не установлены)
- Создаст конфигурационные файлы
- Сгенерирует случайный API ключ
- Соберет и запустит контейнер

### Ручная установка

```bash
# Установите зависимости
npm install

# Соберите проект
npm run build

# Запустите
npm start
```

## Использование

### Первая настройка

1. Откройте веб-интерфейс: `http://localhost:5000`
2. Войдите с паролем по умолчанию: `123456`
3. Перейдите в **Настройки** → Измените пароль
4. Сгенерируйте API ключ для доступа к прокси
5. Перейдите в **Провайдеры** → Добавьте OAuth аккаунты или API ключи

### Примеры запросов

#### OpenAI формат

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

#### Claude формат

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

#### Прямой доступ к провайдеру

```bash
curl http://localhost:5000/openai-qwen-oauth/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-plus",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Возможности

| Функция | Описание |
|---------|----------|
| **Автообновление токенов** | OAuth токены обновляются автоматически |
| **Health checks** | Мониторинг состояния провайдеров |
| **Retry механизм** | Автоматические повторные попытки при ошибках |
| **Системный промпт** | Глобальный промпт для всех запросов |
| **Fallback цепочки** | Переключение между провайдерами при сбоях |
| **Статистика** | Отслеживание использования и ошибок |

## Документация

Полная документация доступна в веб-интерфейсе: `http://localhost:5000/docs`

### Управление Docker

```bash
# Просмотр логов
docker-compose logs -f

# Остановка
docker-compose stop

# Перезапуск
docker-compose restart

# Удаление контейнера
docker-compose down
```

### Конфигурация

Все настройки управляются через веб-интерфейс:
- **Настройки** — API ключ, пароль, системный промпт
- **Провайдеры** — Добавление и управление провайдерами
- **Документация** — Примеры использования и API reference

## Поддерживаемые провайдеры

- **OpenAI** (через API ключ или OAuth)
- **Claude** (Anthropic API или Kiro OAuth)
- **Gemini** (Google Cloud OAuth)
- **Qwen** (Alibaba Cloud OAuth)
- **Grok** (xAI API)
- **Forward API** (универсальный форвардинг)

## Безопасность

- Все данные хранятся локально в `./data` и `./configs`
- API ключ требуется для всех запросов
- OAuth токены шифруются
- Нет отправки данных на внешние серверы

## Лицензия

MIT

---

<div align="center">
  <sub>Создано силами <a href="https://trovu.tech"><strong style="color: #de610d">trovu</strong>.tech</a></sub>
</div>
