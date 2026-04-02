
import fs from 'fs/promises';
import path from 'path';
import { loadProviderPools, saveProviderPools } from '@/lib/storage';
import { v4 as uuidv4 } from 'uuid';

const PROVIDER_MAPPINGS = [
  { providerType: 'gemini-cli-oauth', dirName: 'gemini', credPathKey: 'GEMINI_OAUTH_CREDS_FILE_PATH' },
  { providerType: 'gemini-antigravity', dirName: 'antigravity', credPathKey: 'ANTIGRAVITY_OAUTH_CREDS_FILE_PATH' },
  { providerType: 'openai-qwen-oauth', dirName: 'qwen', credPathKey: 'QWEN_OAUTH_CREDS_FILE_PATH' },
  { providerType: 'claude-kiro-oauth', dirName: 'kiro', credPathKey: 'KIRO_OAUTH_CREDS_FILE_PATH' },
  { providerType: 'openai-iflow', dirName: 'iflow', credPathKey: 'IFLOW_TOKEN_FILE_PATH' },
  { providerType: 'openai-codex-oauth', dirName: 'codex', credPathKey: 'CODEX_OAUTH_CREDS_FILE_PATH' },
];

export async function autoLinkProviderConfigs(config?: any, options: any = {}) {
  try {
    const pools = await loadProviderPools();
    let updated = false;

    
    if (options.onlyCurrentCred && options.credPath) {
      const relativePath = options.credPath;
      
      
      for (const mapping of PROVIDER_MAPPINGS) {
        if (relativePath.includes(`configs/${mapping.dirName}/`)) {
          if (!pools[mapping.providerType]) {
            pools[mapping.providerType] = [];
          }

          
          const exists = pools[mapping.providerType].some(
            (p: any) => p[mapping.credPathKey] === relativePath
          );

          if (!exists) {
            const newProvider = {
              uuid: uuidv4(),
              [mapping.credPathKey]: relativePath,
              isHealthy: true,
              isDisabled: false,
              usageCount: 0,
              errorCount: 0,
            };

            pools[mapping.providerType].push(newProvider);
            updated = true;
            console.log(`[AutoLink] Added ${mapping.providerType}: ${relativePath}`);
          }
          break;
        }
      }
    }

    if (updated) {
      await saveProviderPools(pools);
      
      const { getProviderPoolManager } = await import('./provider-pool-manager');
      const poolManager = await getProviderPoolManager();
      await poolManager.initializeProviderStatus();
      console.log('[AutoLink] Provider status reinitialized');
    }

    return pools;
  } catch (error) {
    console.error('[AutoLink] Error:', error);
    return {};
  }
}

export function getProxyConfigForProvider(provider: string) {
  return null;
}

export function getGoogleAuthProxyConfig() {
  return null;
}
