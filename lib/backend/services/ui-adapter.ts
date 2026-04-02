// Адаптация ui-manager для Next.js (SSE события)

// Глобальное хранилище SSE клиентов
const sseClients = new Set<any>();

export function addSSEClient(client: any) {
  sseClients.add(client);
}

export function removeSSEClient(client: any) {
  sseClients.delete(client);
}

export function broadcastEvent(eventType: string, data: any) {
  const message = JSON.stringify(data);
  const deadClients: any[] = [];
  
  sseClients.forEach(client => {
    try {
      if (!client.closed) {
        client.write(`event: ${eventType}\ndata: ${message}\n\n`);
      } else {
        deadClients.push(client);
      }
    } catch (error) {
      deadClients.push(client);
    }
  });
  
  // Удаляем мертвые клиенты
  deadClients.forEach(client => sseClients.delete(client));
  
  console.log(`[SSE] Broadcasted ${eventType} to ${sseClients.size} clients`);
}
