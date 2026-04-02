
export type ProviderType = 
  | 'gemini-cli-oauth'
  | 'gemini-antigravity'
  | 'openai-custom'
  | 'claude-custom'
  | 'claude-kiro-oauth'
  | 'openai-qwen-oauth'
  | 'openai-iflow'
  | 'openai-codex-oauth'
  | 'openaiResponses-custom'
  | 'forward-api';


export interface ProviderConfig {
  uuid: string;
  checkModelName?: string;
  checkHealth?: boolean;
  isHealthy: boolean;
  isDisabled: boolean;
  lastUsed?: string | null;
  usageCount: number;
  errorCount: number;
  lastErrorTime?: string | null;
  lastHealthCheckTime?: string | null;
  lastHealthCheckModel?: string | null;
  lastErrorMessage?: string | null;
  
  
  refreshCount?: number;
  lastRefreshTime?: number;
  needsRefresh?: boolean;
  scheduledRecoveryTime?: string;
  notSupportedModels?: string[];
  _lastSelectionSeq?: number;
  
  
  GEMINI_OAUTH_CREDS_FILE_PATH?: string;
  ANTIGRAVITY_OAUTH_CREDS_FILE_PATH?: string;
  KIRO_OAUTH_CREDS_FILE_PATH?: string;
  QWEN_OAUTH_CREDS_FILE_PATH?: string;
  CODEX_OAUTH_CREDS_FILE_PATH?: string;
  IFLOW_OAUTH_CREDS_FILE_PATH?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  CLAUDE_API_KEY?: string;
  CLAUDE_BASE_URL?: string;
  FORWARD_API_KEY?: string;
  FORWARD_BASE_URL?: string;
}


export interface ProviderPools {
  [key: string]: ProviderConfig[];
}


export interface AppConfig {
  REQUIRED_API_KEY: string;
  SERVER_PORT: number;
  HOST: string;
  MODEL_PROVIDER: string;
  SYSTEM_PROMPT_FILE_PATH: string;
  SYSTEM_PROMPT_MODE: 'append' | 'overwrite';
  SYSTEM_PROMPT_CONTENT?: string;
  PROMPT_LOG_BASE_NAME: string;
  PROMPT_LOG_MODE: string;
  REQUEST_MAX_RETRIES: number;
  REQUEST_BASE_DELAY: number;
  CREDENTIAL_SWITCH_MAX_RETRIES: number;
  CRON_NEAR_MINUTES: number;
  CRON_REFRESH_TOKEN: boolean;
  LOGIN_EXPIRY: number;
  PROVIDER_POOLS_FILE_PATH: string;
  MAX_ERROR_COUNT: number;
  WARMUP_TARGET: number;
  REFRESH_CONCURRENCY_PER_PROVIDER: number;
  providerFallbackChain: Record<string, string[]>;
  modelFallbackMapping: Record<string, string>;
  PROXY_URL: string | null;
  PROXY_ENABLED_PROVIDERS: string[];
  LOG_ENABLED: boolean;
  LOG_OUTPUT_MODE: string;
  LOG_LEVEL: string;
  LOG_DIR: string;
  LOG_INCLUDE_REQUEST_ID: boolean;
  LOG_INCLUDE_TIMESTAMP: boolean;
  LOG_MAX_FILE_SIZE: number;
  LOG_MAX_FILES: number;
  TLS_SIDECAR_ENABLED: boolean;
  TLS_SIDECAR_ENABLED_PROVIDERS: string[];
  TLS_SIDECAR_PORT: number;
  TLS_SIDECAR_PROXY_URL: string | null;
}


export interface UsageStats {
  totalRequests: number;
  totalTokens: number;
  providerStats: Record<string, {
    requests: number;
    tokens: number;
    errors: number;
  }>;
}


export interface OAuthCredentials {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
  scope?: string;
}


export interface ApiResponse<T = any> {
  success?: boolean;
  data?: T;
  error?: {
    message: string;
    code: string;
  };
}
