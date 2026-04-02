import { NextRequest, NextResponse } from 'next/server';
import { loadProviderPools, saveProviderPools } from '@/lib/storage';

export async function GET(request: NextRequest) {
  try {
    const pools = loadProviderPools();
    return NextResponse.json(pools);
  } catch (error) {
    return NextResponse.json(
      { error: { message: 'Failed to load providers', code: 'PROVIDER_ERROR' } },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const pools = loadProviderPools();
    
    const { providerType, config } = body;
    
    if (!pools[providerType]) {
      pools[providerType] = [];
    }
    
    pools[providerType].push({
      ...config,
      uuid: crypto.randomUUID(),
      isHealthy: true,
      isDisabled: false,
      usageCount: 0,
      errorCount: 0,
      lastUsed: null,
      lastErrorTime: null,
      lastHealthCheckTime: null,
      lastHealthCheckModel: null,
      lastErrorMessage: null,
      checkHealth: false,
    });
    
    saveProviderPools(pools);
    
    return NextResponse.json({
      success: true,
      message: 'Provider added successfully',
    });
  } catch (error) {
    return NextResponse.json(
      { error: { message: 'Failed to add provider', code: 'PROVIDER_ERROR' } },
      { status: 500 }
    );
  }
}
