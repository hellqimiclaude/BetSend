import type { ServerEvent } from '../types';

type Listener = (event: ServerEvent) => void;
type StatusListener = (connected: boolean) => void;

/**
 * Auto-reconnecting WebSocket. Notifications must survive the server being
 * restarted mid-day, so we back off but never give up.
 */
export class LiveConnection {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private retryDelay = 1000;
  private retryTimer: number | null = null;
  private closedByUs = false;
  private user: string;

  constructor(user: string) {
    this.user = user;
  }

  connect(): void {
    this.closedByUs = false;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocol}://${window.location.host}/ws?user=${encodeURIComponent(this.user)}`;

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.retryDelay = 1000;
      this.emitStatus(true);
    };

    socket.onmessage = (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(event);
    };

    socket.onclose = () => {
      this.emitStatus(false);
      if (!this.closedByUs) this.scheduleReconnect();
    };

    socket.onerror = () => socket.close();
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== null) return;
    const delay = this.retryDelay;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
  }

  private emitStatus(connected: boolean): void {
    for (const listener of this.statusListeners) listener(connected);
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.closedByUs = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
