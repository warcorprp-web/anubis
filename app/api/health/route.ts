import { NextResponse } from 'next/server';
import '@/lib/backend/services/background-jobs'; // Автоматически запускает cron

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Background jobs initialized',
    timestamp: new Date().toISOString(),
  });
}
