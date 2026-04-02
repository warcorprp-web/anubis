import { NextRequest, NextResponse } from 'next/server';
import { loadConfig, saveConfig, loadAdminPassword, saveAdminPassword } from '@/lib/storage';

export async function GET() {
  const config = loadConfig();
  const adminPassword = loadAdminPassword();
  
  return NextResponse.json({
    apiKey: config.REQUIRED_API_KEY,
    adminPassword,
    requestMaxRetries: config.REQUEST_MAX_RETRIES,
    requestBaseDelay: config.REQUEST_BASE_DELAY,
    credentialSwitchMaxRetries: config.CREDENTIAL_SWITCH_MAX_RETRIES,
    maxErrorCount: config.MAX_ERROR_COUNT,
    systemPromptContent: config.SYSTEM_PROMPT_CONTENT,
    systemPromptMode: config.SYSTEM_PROMPT_MODE,
  });
}

export async function POST(request: NextRequest) {
  try {
    const { 
      apiKey, 
      adminPassword,
      requestMaxRetries,
      requestBaseDelay,
      credentialSwitchMaxRetries,
      maxErrorCount,
      systemPromptContent,
      systemPromptMode
    } = await request.json();
    
    const config = loadConfig();
    config.REQUIRED_API_KEY = apiKey;
    config.REQUEST_MAX_RETRIES = requestMaxRetries;
    config.REQUEST_BASE_DELAY = requestBaseDelay;
    config.CREDENTIAL_SWITCH_MAX_RETRIES = credentialSwitchMaxRetries;
    config.MAX_ERROR_COUNT = maxErrorCount;
    config.SYSTEM_PROMPT_CONTENT = systemPromptContent;
    config.SYSTEM_PROMPT_MODE = systemPromptMode;
    saveConfig(config);
    
    saveAdminPassword(adminPassword);
    
    
    process.env.REQUIRED_API_KEY = apiKey;
    
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
