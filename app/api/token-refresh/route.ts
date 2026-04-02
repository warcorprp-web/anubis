import { NextResponse } from 'next/server';
import { startTokenRefreshCron, stopTokenRefreshCron } from '@/lib/backend/services/token-refresh-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { action, intervalMinutes } = await request.json();

    if (action === 'start') {
      startTokenRefreshCron(intervalMinutes || 30);
      return NextResponse.json({ success: true, message: 'Token refresh cron started' });
    } else if (action === 'stop') {
      stopTokenRefreshCron();
      return NextResponse.json({ success: true, message: 'Token refresh cron stopped' });
    } else {
      return NextResponse.json(
        { success: false, error: 'Invalid action. Use "start" or "stop"' },
        { status: 400 }
      );
    }
  } catch (error: any) {
    console.error('[Token Refresh API] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
