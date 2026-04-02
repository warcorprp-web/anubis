import { NextResponse } from 'next/server';
import { loadProviderPools } from '@/lib/storage';

export async function GET(
  request: Request,
  context: { params: Promise<{ providerType: string }> }
) {
  try {
    const { providerType } = await context.params;
    const pools = await loadProviderPools();
    const providers = pools[providerType] || [];

    const healthyCount = providers.filter(p => p.isHealthy && !p.isDisabled).length;

    return NextResponse.json({
      providerType: providerType,
      providers,
      totalCount: providers.length,
      healthyCount,
    });
  } catch (error) {
    console.error('Error loading provider details:', error);
    return NextResponse.json(
      { error: 'Failed to load provider details' },
      { status: 500 }
    );
  }
}
