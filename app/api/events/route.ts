import { addSSEClient, removeSSEClient } from '@/lib/backend/services/ui-adapter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const encoder = new TextEncoder();
  
  const stream = new ReadableStream({
    start(controller) {
      // Создаем клиента для SSE
      const client = {
        write: (data: string) => {
          controller.enqueue(encoder.encode(data));
        },
        closed: false,
      };

      // Добавляем клиента в список
      addSSEClient(client);

      // Отправляем начальное сообщение
      client.write(`: connected\n\n`);

      // Обработка закрытия соединения
      const cleanup = () => {
        client.closed = true;
        removeSSEClient(client);
      };

      // Очистка при закрытии
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
