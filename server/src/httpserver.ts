/**
 * HTTP + WebSocket plumbing for the single-origin deploy (Render, or any host
 * that serves the client bundle and the game server from one process).
 *
 *  - GET /health            → 200 "ok"           (platform health check)
 *  - WS  /ws                → upgraded to the game socket
 *  - everything else        → static client/dist with SPA fallback
 *
 * The game logic is NOT here: the caller attaches `wss.on("connection", …)`.
 * This module only wires transport + static serving, so it can be tested with
 * a throwaway client dir and no sim. `perMessageDeflate` is deliberately OFF —
 * frames are tiny latency-sensitive JSON; compression would only add jitter.
 */
import http from "node:http";
import path from "node:path";
import express from "express";
import compression from "compression";
import { WebSocketServer } from "ws";

export interface AppServer {
  server: http.Server;
  wss: WebSocketServer;
}

export function createAppServer(opts: { clientDir: string }): AppServer {
  const app = express();
  app.disable("x-powered-by");
  app.use(compression()); // gzip/brotli the static bundle; ~180 KB → consistently fast first load

  app.get("/health", (_req, res) => {
    res.status(200).type("text/plain").send("ok");
  });

  // hashed asset filenames are safe to cache hard; index.html must stay fresh
  app.use(express.static(opts.clientDir, {
    index: "index.html",
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
      else res.setHeader("Cache-Control", "public, max-age=3600");
    },
  }));

  // SPA fallback: any unknown non-/ws path returns index.html so client routing
  // (and deep links like /?room=CODE) resolve. /ws never reaches here — it's an
  // upgrade, handled below, not a normal request.
  app.get("*", (_req, res) => {
    res.sendFile(path.join(opts.clientDir, "index.html"), (err) => {
      if (err) res.status(404).type("text/plain").send("client bundle not built");
    });
  });

  const server = http.createServer(app);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy(); // reject WebSocket upgrades on any other path
    }
  });

  return { server, wss };
}

/**
 * Graceful shutdown: stop taking new sockets, close live ones with 1001
 * ("going away" — the client's onClose shows "reconnect"), then close the HTTP
 * server. `hardExitMs` arms a backstop `process.exit(0)` so a stuck socket
 * can't hang past the platform's SIGTERM grace window; omit it in tests.
 */
export function shutdown(
  app: AppServer,
  opts: { hardExitMs?: number; onClosed?: () => void } = {},
): void {
  for (const client of app.wss.clients) {
    try { client.close(1001, "server shutting down"); } catch { /* already closing */ }
  }
  app.wss.close();
  app.server.close(() => opts.onClosed?.());
  if (opts.hardExitMs != null) {
    const t = setTimeout(() => process.exit(0), opts.hardExitMs);
    t.unref?.(); // don't keep the loop alive just for the backstop
  }
}
