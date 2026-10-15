import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { touchLastSeen, type UserRow } from '../repos/users.js';
import { unreadCount } from '../repos/transfers.js';
import { resolveSessionFromHeaders } from '../routes/auth.js';

/**
 * Presence + push notifications.
 *
 * A user is "online" while they hold at least one live socket. Sockets are
 * keyed by the lowercased user name so a person with several tabs open counts
 * once and receives every event in each tab.
 */

export type ServerEvent =
  | { type: 'hello'; user: string; unread: number }
  | { type: 'presence'; online: string[] }
  | { type: 'transfer:new'; transferId: string; from: string; fileCount: number; totalSize: number; note: string | null; unread: number }
  | { type: 'transfer:revoked'; transferId: string; from: string; unread: number }
  | { type: 'transfer:expired'; transferId: string; unread: number }
  | { type: 'transfer:downloaded'; transferId: string; by: string }
  | { type: 'transfer:seen'; transferId: string; by: string }
  | { type: 'inbox:changed'; unread: number };

interface Client {
  socket: WebSocket;
  userKey: string;
  userId: number;
  alive: boolean;
}

const clients = new Set<Client>();
const byUserKey = new Map<string, Set<Client>>();

let presenceTimer: NodeJS.Timeout | null = null;

function schedulePresenceBroadcast(): void {
  // Coalesce bursts (a page reload closes and reopens a socket immediately).
  if (presenceTimer) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    broadcastAll({ type: 'presence', online: onlineUserNames() });
  }, 150);
}

export function onlineUserNames(): string[] {
  return [...byUserKey.keys()];
}

export function isOnline(userName: string): boolean {
  return byUserKey.has(userName.toLocaleLowerCase());
}

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(event));
  }
}

export function sendToUser(userName: string, event: ServerEvent): void {
  const set = byUserKey.get(userName.toLocaleLowerCase());
  if (!set) return;
  for (const client of set) send(client.socket, event);
}

export function sendToUserId(userId: number, event: ServerEvent): void {
  for (const client of clients) {
    if (client.userId === userId) send(client.socket, event);
  }
}

export function broadcastAll(event: ServerEvent): void {
  for (const client of clients) send(client.socket, event);
}

function register(client: Client): void {
  clients.add(client);
  let set = byUserKey.get(client.userKey);
  if (!set) {
    set = new Set();
    byUserKey.set(client.userKey, set);
  }
  set.add(client);
  schedulePresenceBroadcast();
}

function unregister(client: Client): void {
  clients.delete(client);
  const set = byUserKey.get(client.userKey);
  if (set) {
    set.delete(client);
    if (set.size === 0) byUserKey.delete(client.userKey);
  }
  schedulePresenceBroadcast();
}

export function attachWebSocket(server: HttpServer, log: { info: (o: unknown, m?: string) => void }): () => void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') return; // let other upgrade handlers (vite hmr in dev) have it

    // The socket is authenticated by the same session cookie as the REST API —
    // never by a name in the query string, which anyone could type.
    const user: UserRow | null = resolveSessionFromHeaders(req.headers.cookie);
    if (!user || !user.active) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: Client = { socket: ws, userKey: user.name.toLocaleLowerCase(), userId: user.id, alive: true };
      register(client);
      touchLastSeen(user.id);

      send(ws, { type: 'hello', user: user.name, unread: unreadCount(user.id) });
      send(ws, { type: 'presence', online: onlineUserNames() });

      ws.on('pong', () => {
        client.alive = true;
        touchLastSeen(client.userId);
      });
      ws.on('message', (raw) => {
        // The only client->server message is a keepalive ping.
        if (String(raw) === 'ping') ws.send('pong');
      });
      ws.on('close', () => unregister(client));
      ws.on('error', () => unregister(client));
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        client.socket.terminate();
        unregister(client);
        continue;
      }
      client.alive = false;
      try {
        client.socket.ping();
      } catch {
        unregister(client);
      }
    }
  }, 30_000);

  log.info({ path: '/ws' }, 'websocket hub ready');

  return () => {
    clearInterval(heartbeat);
    if (presenceTimer) clearTimeout(presenceTimer);
    for (const client of clients) client.socket.terminate();
    clients.clear();
    byUserKey.clear();
    wss.close();
  };
}
