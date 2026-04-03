import { NextRequest, NextResponse } from 'next/server';

const SUPPORTED_PROVIDERS = [
  'gemini-cli-oauth',
  'gemini-antigravity',
  'openai-custom',
  'claude-custom',
  'claude-kiro-oauth',
  'openai-qwen-oauth',
  'openai-iflow',
  'openai-codex-oauth',
  'openaiResponses-custom',
  'forward-api',
  'grok-custom',
  'gigachat-api',
];

export async function GET(request: NextRequest) {
  return NextResponse.json(SUPPORTED_PROVIDERS);
}
