import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { provider, callbackUrl } = body;

    if (!provider || !callbackUrl) {
      return NextResponse.json(
        { success: false, error: 'provider and callbackUrl are required' },
        { status: 400 }
      );
    }

    // Парсим URL и делаем fetch напрямую на localhost callback сервер
    const url = new URL(callbackUrl);
    url.hostname = 'localhost';
    url.protocol = 'http:';

    try {
      const response = await fetch(url.href);
      
      if (response.ok) {
        return NextResponse.json({
          success: true,
          message: 'OAuth callback processed successfully'
        });
      } else {
        return NextResponse.json(
          { success: false, error: `Callback processing failed: ${response.status}` },
          { status: 500 }
        );
      }
    } catch (fetchError: any) {
      return NextResponse.json(
        { success: false, error: `Failed to process callback: ${fetchError.message}` },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('[OAuth Manual Callback] Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
