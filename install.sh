#!/bin/bash
set -e

echo "========================================"
echo "  ANUBIS AI Proxy - Installation"
echo "========================================"
echo ""

# Проверка Docker
if ! command -v docker &> /dev/null; then
    echo "[ERROR] Docker is not installed."
    echo "        Install Docker: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! command -v docker-compose &> /dev/null; then
    echo "[ERROR] Docker Compose is not installed."
    echo "        Install Docker Compose: https://docs.docker.com/compose/install/"
    exit 1
fi

# Создание .env если не существует
if [ ! -f .env ]; then
    echo "[INFO] Creating .env file..."
    cp .env.example .env
    
    # Генерация случайного API ключа
    API_KEY="anubis-$(openssl rand -hex 24)"
    sed -i "s/your-secret-key-here/$API_KEY/" .env
    
    echo "[OK] .env file created"
    echo "[KEY] Your API key: $API_KEY"
    echo ""
fi

# Создание директорий
mkdir -p data configs

# Сборка и запуск
echo "[BUILD] Building Docker image..."
docker-compose build

echo "[START] Starting container..."
docker-compose up -d

echo ""
echo "========================================"
echo "  ANUBIS AI Proxy is running!"
echo "========================================"
echo ""
echo "  Web interface: http://localhost:5000"
echo "  Default password: 123456"
echo "  (Change it in Settings panel)"
echo ""
echo "Management commands:"
echo "  docker-compose logs -f    # View logs"
echo "  docker-compose stop       # Stop"
echo "  docker-compose restart    # Restart"
echo "  docker-compose down       # Удаление контейнера"
