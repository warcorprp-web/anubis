import { NextRequest, NextResponse } from 'next/server';
import { loadProviderPools, saveProviderPools } from '@/lib/storage';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'anubis-secret-key';

function verifyToken(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;
  
  const token = authHeader.substring(7);
  try {
    jwt.verify(token, JWT_SECRET);
    return true;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  if (!verifyToken(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
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
  if (!verifyToken(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  
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
