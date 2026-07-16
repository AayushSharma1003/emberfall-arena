/**
 * HTTP + WebSocket plumbing for the single-origin deploy (Render, or any host
 * that serves the client bundle and the game server from one process).
 *
 *  - GET /health            → 200 "ok"           (platform health check)
 *  - WS  /ws                → upgraded to the game socket (origin-checked)
 *  - everything else        → static client/dist with SPA fallback
 *
 * The game logic is NOT here: the caller attaches `wss.on("connection", …)`.
 * This module only wires transport + static serving, so it can be tested with
 * a throwaway client dir and no sim. `perMessageDeflate` is deliberately OFF —
 * frames are tiny latency-sensitive JSON; compression would only add jitter.
 *
 * Security posture (public URL):
 *  - /ws upgrades are rejected unless the Origin is our own host or localhost
 *    (dev). Non-browser clients send no Origin and pass — the check exists to
 *    stop a random web page from opening sockets with a visitor's browser.
 *  - CSP/HSTS/nosniff/frame-ancestors on every response; connect-src is
 *    pinned to self + our own ws(s) origin.
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

export interface AppServerOpts {
  clientDir: string;
  /** Override the default origin policy (tests, unusual proxies). */
  isOriginAllowed?: (origin: string | undefined, host: string | undefined) => boolean;
}

/**
 * Default origin policy for /ws: no Origin header passes (curl, ws lib, native
 * clients — they can lie anyway, so blocking them buys nothing), our own host
 * passes, localhost/127.0.0.1 on any port passes (vite dev on :5173 talking to
 * :8080). Every other web origin is refused.
 */
export function defaultOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  return host !== undefined && url.host === host;
}

export function createAppServer(opts: AppServerOpts): AppServer {
  const app = express();
  app.disable("x-powered-by");
  app.use(compression()); // gzip/brotli the static bundle; ~180 KB → consistently fast first load

  // security headers on every response (the HTML is what matters, but blanket is simpler and safe)
  app.use((req, res, next) => {
    const host = req.headers.host ?? "";
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'", // index.html carries a tiny layout <style>
        "img-src 'self' data:",
        `connect-src 'self' wss://${host} ws://${host}`,
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    // invite URLs carry ?room=CODE — never leak it in a Referer
    res.setHeader("Referrer-Policy", "same-origin");
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

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

  const isOriginAllowed = opts.isOriginAllowed ?? defaultOriginAllowed;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws") {
      socket.destroy(); // reject WebSocket upgrades on any other path
      return;
    }
    if (!isOriginAllowed(req.headers.origin, req.headers.host)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  return { server, wss };
}

/**
 * Graceful shutdown: broadcast a serverRestart notice (the client shows its
 * reconnecting banner instead of a dead screen), stop taking new sockets,
 * close live ones with 1001 ("going away"), then close the HTTP server.
 * `hardExitMs` arms a backstop `process.exit(0)` so a stuck socket can't hang
 * past the platform's SIGTERM grace window; omit it in tests.
 */
export function shutdown(
  app: AppServer,
  opts: { hardExitMs?: number; onClosed?: () => void; reason?: string } = {},
): void {
  const notice = JSON.stringify({ t: "serverRestart", reason: opts.reason ?? "server restarting" });
  for (const client of app.wss.clients) {
    try {
      if (client.readyState === client.OPEN) client.send(notice);
      client.close(1001, "server shutting down");
    } catch { /* already closing */ }
  }
  app.wss.close();
  app.server.close(() => opts.onClosed?.());
  if (opts.hardExitMs != null) {
    const t = setTimeout(() => process.exit(0), opts.hardExitMs);
    t.unref?.(); // don't keep the loop alive just for the backstop
  }
}
