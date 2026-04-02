
import { startTokenRefreshCron } from './token-refresh-manager';

let initialized = false;

export function initializeBackgroundJobs() {
  if (initialized) {
    console.log('[Background Jobs] Already initialized');
    return;
  }

  console.log('[Background Jobs] Starting...');

  
  startTokenRefreshCron(30);

  initialized = true;
  console.log('[Background Jobs] Initialized successfully');
}


if (typeof window === 'undefined') {
  
  setTimeout(() => {
    initializeBackgroundJobs();
  }, 5000);
}
