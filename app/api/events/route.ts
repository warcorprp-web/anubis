import { addSSEClient, removeSSEClient } from '@/lib/backend/services/ui-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    start(controller) {
      
      const client = {
        write: (data: string) => {
          controller.enqueue(encoder.encode(data));
        },
        closed: false,
      };

      
      addSSEClient(client);

      
      client.write(`: connected\n\n`);

      
      const cleanup = () => {
        client.closed = true;
        removeSSEClient(client);
      };

      
      return cleanup;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
