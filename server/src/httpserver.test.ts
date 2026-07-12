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

const wsProbe = (pathname: string): Promise<"open" | "rejected"> =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}${pathname}`);
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

describe("shutdown", () => {
  it("stops listening and closes live sockets (1001), without exiting the process", async () => {
    const live = new WebSocket(`ws://localhost:${port}/ws`);
    const closeCode = await new Promise<number>((resolve) => {
      live.on("open", () => shutdown(app)); // no hardExitMs → never calls process.exit
      live.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(1001);

    await new Promise((r) => setTimeout(r, 30));
    expect(app.server.listening).toBe(false);
    // the port is free again: a fresh connection is refused
    expect(await wsProbe("/ws")).toBe("rejected");
  });
});
