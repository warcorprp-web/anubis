import fs from 'fs';
import path from 'path';
import { AppConfig, ProviderPools } from './types';

const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PROVIDERS_FILE = path.join(DATA_DIR, 'provider_pools.json');
const PWD_FILE = path.join(DATA_DIR, 'pwd');


if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}


const DEFAULT_CONFIG: AppConfig = {
  REQUIRED_API_KEY: '123456',
  SERVER_PORT: 5083,
  HOST: '0.0.0.0',
  MODEL_PROVIDER: 'gemini-cli-oauth',
  SYSTEM_PROMPT_FILE_PATH: 'data/input_system_prompt.txt',
  SYSTEM_PROMPT_MODE: 'append',
  PROMPT_LOG_BASE_NAME: '',
  PROMPT_LOG_MODE: '',
  REQUEST_MAX_RETRIES: 3,
  REQUEST_BASE_DELAY: 1000,
  CREDENTIAL_SWITCH_MAX_RETRIES: 5,
  CRON_NEAR_MINUTES: 1,
  CRON_REFRESH_TOKEN: false,
  LOGIN_EXPIRY: 3600,
  PROVIDER_POOLS_FILE_PATH: '',
  MAX_ERROR_COUNT: 10,
  WARMUP_TARGET: 0,
  REFRESH_CONCURRENCY_PER_PROVIDER: 1,
  providerFallbackChain: {},
  modelFallbackMapping: {},
  PROXY_URL: null,
  PROXY_ENABLED_PROVIDERS: [],
  LOG_ENABLED: true,
  LOG_OUTPUT_MODE: 'all',
  LOG_LEVEL: 'info',
  LOG_DIR: 'logs',
  LOG_INCLUDE_REQUEST_ID: true,
  LOG_INCLUDE_TIMESTAMP: true,
  LOG_MAX_FILE_SIZE: 10485760,
  LOG_MAX_FILES: 10,
  TLS_SIDECAR_ENABLED: false,
  TLS_SIDECAR_ENABLED_PROVIDERS: [],
  TLS_SIDECAR_PORT: 9090,
  TLS_SIDECAR_PROXY_URL: null,
};


export function loadConfig(): AppConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
  return DEFAULT_CONFIG;
}


export function saveConfig(config: AppConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}


export function loadProviderPools(): ProviderPools {
  try {
    if (fs.existsSync(PROVIDERS_FILE)) {
      const data = fs.readFileSync(PROVIDERS_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Failed to load provider pools:', error);
  }
  return {};
}


export function saveProviderPools(pools: ProviderPools): void {
  fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(pools, null, 2));
}


export function loadAdminPassword(): string {
  try {
    if (fs.existsSync(PWD_FILE)) {
      return fs.readFileSync(PWD_FILE, 'utf-8').trim();
    }
  } catch (error) {
    console.error('Failed to load password:', error);
  }
  return '123456';
}


export function saveAdminPassword(password: string): void {
  fs.writeFileSync(PWD_FILE, password);
}
