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
    
    # Генерация случайного API ключа
    API_KEY="anubis-$(openssl rand -hex 24)"
    sed -i "s/your-secret-key-here/$API_KEY/" .env
    
    echo "[OK] .env file created"
    echo "[KEY] Your API key: $API_KEY"
    echo ""
fi

# Создание директорий
mkdir -p data configs
chmod -R 777 data configs

# Сборка и запуск
echo "[BUILD] Сборка Docker образа..."
docker-compose build

echo "[START] Запуск контейнера..."
docker-compose up -d

echo ""
echo "========================================"
echo "  ANUBIS AI Proxy запущен!"
echo "========================================"
echo ""
echo "  Веб-интерфейс: http://localhost:5000"
echo "  Пароль по умолчанию: 123456"
echo "  (Измените в панели Настройки)"
echo ""
echo "Команды управления:"
echo "  docker-compose logs -f    # Просмотр логов"
echo "  docker-compose stop       # Остановка"
echo "  docker-compose restart    # Перезапуск"
echo "  docker-compose down       # Удаление контейнера"
