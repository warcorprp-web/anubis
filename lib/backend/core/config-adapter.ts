
import path from 'path';
import { loadConfig } from '@/lib/storage';


const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIGS_DIR = path.join(DATA_DIR, 'configs');


export const CONFIG = {
  
  GEMINI_CLI_OAUTH_CREDS_DIR: path.join(CONFIGS_DIR, 'gemini'),
  GEMINI_ANTIGRAVITY_OAUTH_CREDS_DIR: path.join(CONFIGS_DIR, 'antigravity'),
  QWEN_OAUTH_CREDS_DIR: path.join(CONFIGS_DIR, 'qwen'),
  KIRO_OAUTH_CREDS_DIR: path.join(CONFIGS_DIR, 'kiro'),
  IFLOW_OAUTH_CREDS_DIR: path.join(CONFIGS_DIR, 'iflow'),
  CODEX_OAUTH_CREDS_DIR: path.join(CONFIGS_DIR, 'codex'),
  
  
  GEMINI_CLI_OAUTH_CALLBACK_PORT: 1453,
  GEMINI_ANTIGRAVITY_OAUTH_CALLBACK_PORT: 1454,
  QWEN_OAUTH_CALLBACK_PORT: 1456,
  KIRO_OAUTH_CALLBACK_PORT: 1457,
  IFLOW_OAUTH_CALLBACK_PORT: 1458,
  CODEX_OAUTH_CALLBACK_PORT: 1455,
};


export async function getConfig() {
  return await loadConfig();
}
