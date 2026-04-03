#!/bin/bash
set -e

echo "========================================"
echo "  ANUBIS AI Proxy - Установка"
echo "========================================"
echo ""

# Проверка и установка Docker
if ! command -v docker &> /dev/null; then
    echo "[INFO] Docker не установлен. Устанавливаю..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    systemctl start docker
    systemctl enable docker
    echo "[OK] Docker успешно установлен"
    echo ""
fi

# Проверка и установка Docker Compose
if ! command -v docker-compose &> /dev/null; then
    echo "[INFO] Docker Compose не установлен. Устанавливаю..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo "[OK] Docker Compose успешно установлен"
    echo ""
fi

# Создание .env если не существует
if [ ! -f .env ]; then
    echo "[INFO] Creating .env file..."
    cp .env.example .env
    echo "[OK] .env file created"
    echo ""
fi

# Создание директорий
mkdir -p data configs
chown -R 1001:1001 data configs
chmod -R 755 data configs

# Создание дефолтного system prompt если не существует
if [ ! -f data/input_system_prompt.txt ]; then
    echo "[INFO] Creating default system prompt..."
    cp data/input_system_prompt.txt.example data/input_system_prompt.txt
    echo "[OK] System prompt created"
fi

# Сборка и запуск
echo "[BUILD] Сборка Docker образа..."
docker-compose build 2>&1 | grep -v "Turbopack build encountered" | grep -v "Encountered unexpected file in NFT list" | grep -v "Import trace:" | grep -v "Output asset trace:" | grep -v "filesystem operations" | grep -v "turbopackIgnore" | grep -v "very dynamic requires" || true

echo "[START] Запуск контейнера..."
docker-compose up -d

echo ""
echo "========================================"
echo "  ANUBIS AI Proxy запущен!"
echo "========================================"
echo ""
echo "  Веб-интерфейс: http://localhost:5000"
echo "  API ключ по умолчанию: 123456"
echo "  Пароль по умолчанию: 123456"
echo "  (Измените в панели Настройки)"
echo ""
echo "Команды управления:"
echo "  docker-compose logs -f    # Просмотр логов"
echo "  docker-compose stop       # Остановка"
echo "  docker-compose restart    # Перезапуск"
echo "  docker-compose down       # Удаление контейнера"
