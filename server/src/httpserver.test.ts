/**
 * HTTP + WS plumbing (httpserver.ts): /health, SPA fallback, /ws upgrade
 * gating, and graceful shutdown(). Spun on an ephemeral port with a throwaway
 * client dir — no sim, no real client build.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createAppServer, shutdown, type AppServer } from "./httpserver.js";

let dir: string;
let app: AppServer;
let port: number;

const INDEX_HTML = "<!doctype html><title>Emberfall</title><body>SPA_ROOT</body>";

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ember-client-"));
  writeFileSync(path.join(dir, "index.html"), INDEX_HTML);
  writeFileSync(path.join(dir, "app.js"), "console.log('bundle')");
  app = createAppServer({ clientDir: dir });
  await new Promise<void>((res) => app.server.listen(0, res));
  port = (app.server.address() as AddressInfo).port;
});

afterEach(() => {
  try { shutdown(app); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const base = (): string => `http://localhost:${port}`;

const wsProbe = (pathname: string, origin?: string): Promise<"open" | "rejected"> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}${pathname}`, origin ? { origin } : {});
    ws.on("open", () => { ws.close(); resolve("open"); });
    ws.on("error", () => resolve("rejected"));
  });

describe("createAppServer", () => {
  it("GET /health → 200 ok", async () => {
    const r = await fetch(`${base()}/health`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("ok");
  });

  it("serves the static bundle at its real path", async () => {
    const r = await fetch(`${base()}/app.js`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("bundle");
  });

  it("SPA fallback: unknown deep path → index.html (200)", async () => {
    const r = await fetch(`${base()}/some/deep/link`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("SPA_ROOT");
  });

  it("index.html is sent no-cache; hashed assets are cacheable", async () => {
    const idx = await fetch(`${base()}/`);
    expect(idx.headers.get("cache-control")).toContain("no-cache");
    const asset = await fetch(`${base()}/app.js`);
    expect(asset.headers.get("cache-control")).toContain("max-age=3600");
  });

  it("upgrades WebSocket on /ws, rejects it on every other path", async () => {
    expect(await wsProbe("/ws")).toBe("open");
    expect(await wsProbe("/")).toBe("rejected");
    expect(await wsProbe("/nope")).toBe("rejected");
    expect(await wsProbe("/health")).toBe("rejected");
  });

  it("does not enable per-message compression on the game socket", () => {
    // latency-sensitive tiny JSON frames — deflate must stay off
    expect((app.wss.options as { perMessageDeflate?: unknown }).perMessageDeflate).toBe(false);
  });
});

describe("origin policy on /ws", () => {
  it("same-host origin and localhost origins pass; foreign web origins are refused", async () => {
    expect(await wsProbe("/ws", `http://localhost:${port}`)).toBe("open"); // our own page
    expect(await wsProbe("/ws", "http://localhost:5173")).toBe("open"); // vite dev
    expect(await wsProbe("/ws", "http://127.0.0.1:4000")).toBe("open");
    expect(await wsProbe("/ws")).toBe("open"); // non-browser client, no Origin
    expect(await wsProbe("/ws", "https://evil.example")).toBe("rejected");
    expect(await wsProbe("/ws", "not a url")).toBe("rejected");
  });
});

describe("security headers", () => {
  it("CSP pins connect-src to self + own ws origin; script-src self; frames denied", async () => {
    const r = await fetch(`${base()}/`);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain(`connect-src 'self' wss://localhost:${port} ws://localhost:${port}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("same-origin"); // ?room=CODE never leaks in a Referer
  });

  it("HSTS only when the request came over TLS (Render sets x-forwarded-proto)", async () => {
    const plain = await fetch(`${base()}/health`);
    expect(plain.headers.get("strict-transport-security")).toBeNull();
    const forwarded = await fetch(`${base()}/health`, { headers: { "x-forwarded-proto": "https" } });
    expect(forwarded.headers.get("strict-transport-security")).toContain("max-age=");
  });
});

describe("shutdown", () => {
  it("broadcasts serverRestart, then closes live sockets (1001), without exiting the process", async () => {
    const live = new WebSocket(`ws://localhost:${port}/ws`);
    const notices: string[] = [];
    live.on("message", (raw) => notices.push(raw.toString()));
    const closeCode = await new Promise<number>((resolve) => {
      live.on("open", () => shutdown(app, { reason: "deploy" })); // no hardExitMs → never calls process.exit
      live.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(1001);
    expect(notices.map((n) => JSON.parse(n))).toContainEqual({ t: "serverRestart", reason: "deploy" });

    await new Promise((r) => setTimeout(r, 30));
    expect(app.server.listening).toBe(false);
    // the port is free again: a fresh connection is refused
    expect(await wsProbe("/ws")).toBe("rejected");
  });
});
