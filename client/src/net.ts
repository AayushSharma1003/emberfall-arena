/**
 * Thin WebSocket wrapper: JSON in/out, typed callbacks, ping keepalive.
 * Reconnect flow (Phase D) stores token+room in sessionStorage.
 */
import type { ClientMsg, ServerMsg } from "@emberfall/shared";

export class NetClient {
  private ws: WebSocket;
  onMessage: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};
  onOpen: () => void = () => {};
  private pinger: ReturnType<typeof setInterval> | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.pinger = setInterval(() => this.send({ t: "ping", ts: Date.now() }), 2000);
      this.onOpen();
    };
    this.ws.onmessage = (ev) => {
      try {
        this.onMessage(JSON.parse(String(ev.data)) as ServerMsg);
      } catch {
        /* ignore malformed */
      }
    };
    this.ws.onclose = () => {
      if (this.pinger) clearInterval(this.pinger);
      this.onClose();
    };
  }

  send(m: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close(): void {
    this.ws.close();
  }
}
