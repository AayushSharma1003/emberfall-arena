/**
 * Test-only WebSocket helpers: a gateway on an ephemeral port and a tiny
 * promise-based client with a message queue, so the gateway/integration
 * suites read as scripts instead of callback pyramids.
 */
import { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { ServerMsg } from "@emberfall/shared";
import { attachGateway, type GatewayOpts } from "./gateway.js";
import { RoomRegistry } from "./registry.js";

export interface TestGateway {
  wss: WebSocketServer;
  registry: RoomRegistry;
  port: number;
  close(): Promise<void>;
}

export async function startGateway(
  gw: GatewayOpts = {},
  reg: { maxRooms?: number; graceMs?: number } = {},
): Promise<TestGateway> {
  const wss = new WebSocketServer({ port: 0, maxPayload: 4096, perMessageDeflate: false });
  await new Promise<void>((res) => wss.once("listening", res));
  const registry = new RoomRegistry(reg);
  attachGateway(wss, registry, { log: () => {}, ...gw });
  const port = (wss.address() as AddressInfo).port;
  return {
    wss, registry, port,
    close: () => new Promise((res) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => res());
    }),
  };
}

export interface Cli {
  ws: WebSocket;
  /** Resolve the next message matching pred (scanning anything already queued). */
  next<T extends ServerMsg = ServerMsg>(pred?: (m: ServerMsg) => boolean, timeoutMs?: number): Promise<T>;
  send(o: unknown): void;
  sendRaw(data: string): void;
  closed: Promise<number>; // close code
  isOpen(): boolean;
}

export async function connectClient(port: number, opts: { autoPong?: boolean } = {}): Promise<Cli> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: opts.autoPong ?? true });
  const queue: ServerMsg[] = [];
  const waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString()) as ServerMsg;
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0].res(m);
    else queue.push(m);
  });
  const closed = new Promise<number>((res) => ws.on("close", (code) => res(code)));
  await new Promise<void>((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  return {
    ws,
    next<T extends ServerMsg = ServerMsg>(pred: (m: ServerMsg) => boolean = () => true, timeoutMs = 2000): Promise<T> {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0] as T);
      return new Promise<T>((res, rej) => {
        const t = setTimeout(() => rej(new Error("timed out waiting for message")), timeoutMs);
        waiters.push({
          pred,
          res: (m) => {
            clearTimeout(t);
            res(m as T);
          },
        });
      });
    },
    send: (o) => ws.send(JSON.stringify(o)),
    sendRaw: (data) => ws.send(data),
    closed,
    isOpen: () => ws.readyState === WebSocket.OPEN,
  };
}

export const is = (t: ServerMsg["t"]) => (m: ServerMsg): boolean => m.t === t;
export const isPong = (m: ServerMsg): boolean => m.t === "pong" && m.ts >= 0;
