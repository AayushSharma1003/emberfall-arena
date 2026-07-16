/**
 * Bootstrap: wire the HTTP/WS plumbing (httpserver.ts), the room registry
 * (registry.ts) and the hardened connection handler (gateway.ts) together,
 * then drive room ticks on a drift-corrected 60 Hz loop.
 *
 * Single-origin deploy: the same process serves the client bundle and the
 * game socket (see httpserver.ts) so `wss://<host>/ws` needs no client config.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SIM_HZ } from "@emberfall/shared";
import { RoomRegistry } from "./registry.js";
import { attachGateway } from "./gateway.js";
import { createAppServer, shutdown } from "./httpserver.js";

const PORT = Number(process.env.PORT ?? 8080);

// client/dist relative to THIS file — works whether we run the esbuild bundle
// (server/dist/main.js) or tsx in dev (server/src/main.ts); never process.cwd().
const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");
const app = createAppServer({ clientDir });

const registry = new RoomRegistry();
attachGateway(app.wss, registry);

// drift-corrected 60 Hz loop for all rooms
const TICK_MS = 1000 / SIM_HZ;
let last = Date.now();
let acc = 0;
const tickTimer = setInterval(() => {
  const now = Date.now();
  acc += now - last;
  last = now;
  acc = Math.min(acc, 250); // don't spiral after a stall
  while (acc >= TICK_MS) {
    acc -= TICK_MS;
    registry.tickAll(now);
  }
}, 4);

app.server.listen(PORT, "0.0.0.0", () => {
  console.log(`[server] Emberfall Arena listening on :${PORT} (sim ${SIM_HZ}Hz) — /ws game, / client, /health`);
});

// SIGTERM (Render deploy/spin-down) + SIGINT (local Ctrl-C): stop ticking,
// tell every client we're going away (they show the reconnect banner), close
// sockets cleanly, exit.
function onSignal(sig: string): void {
  console.log(`[server] ${sig} received — shutting down`);
  clearInterval(tickTimer);
  shutdown(app, { hardExitMs: 2000, reason: "server restarting — deploy or spin-down" });
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
