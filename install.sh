#!/bin/bash
set -e

echo "🚀 ANUBIS AI Proxy - Установка"
echo "================================"

# Проверка Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker не установлен. Установите Docker: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose не установлен. Установите Docker Compose: https://docs.docker.com/compose/install/"
    exit 1
fi

# Создание .env если не существует
if [ ! -f .env ]; then
    echo "📝 Создание .env файла..."
    cp .env.example .env
    
    # Генерация случайного API ключа
    API_KEY="anubis-$(openssl rand -hex 24)"
    sed -i "s/your-secret-key-here/$API_KEY/" .env
    
    echo "✅ .env файл создан"
    echo "🔑 Ваш API ключ: $API_KEY"
fi

# Создание директорий
mkdir -p data configs

# Сборка и запуск
echo "🔨 Сборка Docker образа..."
docker-compose build

echo "🚀 Запуск контейнера..."
docker-compose up -d

echo ""
echo "✅ ANUBIS AI Proxy запущен!"
echo ""
echo "📍 Веб-интерфейс: http://localhost:5000"
echo "🔐 Пароль по умолчанию: 123456 (измените в панели Настройки)"
echo ""
echo "Команды управления:"
echo "  docker-compose logs -f    # Просмотр логов"
echo "  docker-compose stop       # Остановка"
echo "  docker-compose restart    # Перезапуск"
echo "  docker-compose down       # Удаление контейнера"
