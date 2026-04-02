
import { startTokenRefreshCron } from './token-refresh-manager';
import { loadConfig } from '@/lib/storage';

let initialized = false;

export function initializeBackgroundJobs() {
  if (initialized) {
    console.log('[Background Jobs] Already initialized');
    return;
  }

  console.log('[Background Jobs] Starting...');

  if (!process.env.REQUIRED_API_KEY || process.env.REQUIRED_API_KEY === 'change-me') {
    const config = loadConfig();
    if (config.REQUIRED_API_KEY) {
      process.env.REQUIRED_API_KEY = config.REQUIRED_API_KEY;
      console.log('[Background Jobs] API key loaded from config');
    }
  }

  startTokenRefreshCron(30);

  initialized = true;
  console.log('[Background Jobs] Initialized successfully');
}


if (typeof window === 'undefined') {
  
  setTimeout(() => {
    initializeBackgroundJobs();
  }, 5000);
}
