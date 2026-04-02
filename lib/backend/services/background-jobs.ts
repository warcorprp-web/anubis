// Инициализация background задач при старте приложения
import { startTokenRefreshCron } from './token-refresh-manager';

let initialized = false;

export function initializeBackgroundJobs() {
  if (initialized) {
    console.log('[Background Jobs] Already initialized');
    return;
  }

  console.log('[Background Jobs] Starting...');

  // Запускаем автообновление токенов каждые 30 минут
  startTokenRefreshCron(30);

  initialized = true;
  console.log('[Background Jobs] Initialized successfully');
}

// Автоматический запуск при импорте (только в Node.js окружении)
if (typeof window === 'undefined') {
  // Запускаем через небольшую задержку, чтобы дать Next.js время инициализироваться
  setTimeout(() => {
    initializeBackgroundJobs();
  }, 5000);
}
