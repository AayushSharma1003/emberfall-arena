# Deploying Emberfall Arena

**Live target: Render free tier** — one Web Service serving the client bundle
and the game socket on a single origin (§ Render below). The Oracle Cloud
section that follows is **reference only** (kept for a future self-hosted move),
not the current deployment path.

---

# Render (live runbook)

One free **Web Service** runs the compiled server, which serves both the static
client (`client/dist`) and the WebSocket game server on one origin. Single
origin means the client's default `wss://<host>/ws` derivation works with **zero
client config**. Config lives in [`render.yaml`](../render.yaml) (a Blueprint).

## How it works (architecture)

- **One process, one origin.** `server/dist/main.js` (esbuild bundle) runs an
  Express app: `GET /health` → `ok`, `/ws` → upgraded to the game socket
  (gated — upgrades on any other path are rejected), everything else → static
  `client/dist` with SPA fallback so deep links like `/?room=CODE` resolve.
- **Single instance, in-memory rooms.** Rooms/matches/reconnect-tokens live in
  memory (no DB). Render free tier is single-instance — which is *required*,
  since rooms on one instance are invisible to another. Do not scale out.
- **Prod runs compiled JS, not tsx.** `shared/` is inlined into the bundle by
  esbuild (`--external:ws,express,compression`), so `shared/package.json` stays
  pointed at `src` and the client build + test suite are untouched.

## First deploy

1. **Push `render.yaml` + this code to GitHub `main`.** (The push triggers the
   Blueprint pickup, so do it once you're ready.)
2. Render dashboard → **New +** → **Blueprint** → select the `emberfall-arena`
   repo. Render reads `render.yaml` and creates the Web Service.
3. **Build + deploy** runs `npm ci --include=dev && npm run build` then
   `npm start`. First build ≈ **3–5 min** (installs Pixi + esbuild, builds
   client + server). Watch the deploy logs.
4. When it goes **Live**, open the generated **`https://emberfall-arena.onrender.com`**
   (or whatever name Render assigns). The menu → quick-match-vs-bots flow works
   immediately; online multiplayer is `…/?server` (creates a room + code) and
   `…/?room=CODE` (joins) — see the online section in the README.
5. `autoDeploy: true` — every push to `main` redeploys automatically.

## Gotchas (things that will burn 30–60 min if you don't know)

1. **Strict CSP (`script-src 'self'`, no `unsafe-eval`) + Pixi v8 = blank
   page, no console errors.** Pixi v8's default shader/geometry paths call
   `new Function(...)` at boot, which the CSP blocks; the browser reports
   the rejection as an unhandled promise (`Current environment does not
   allow unsafe-eval, please use pixi.js/unsafe-eval module`) rather than a
   visible console error, and the canvas never mounts. **The fix is not to
   loosen the CSP.** Import the shim as the FIRST Pixi import in
   `client/src/main.ts`:
   ```ts
   import "pixi.js/unsafe-eval"; // must precede any other pixi.js import
   import { Application } from "pixi.js";
   ```
   The shim ships precompiled equivalents (~40 KB added to the bundle) and
   the strict CSP stays intact. If you ever see `script-src 'self'
   'unsafe-eval'` in [`server/src/httpserver.ts`](../server/src/httpserver.ts),
   somebody worked around this the wrong way — put the shim back and pull
   `unsafe-eval` out.

2. **`ws://` URLs from an https page get silently blocked by the browser
   before the client even sees an error.** The client refuses this on its
   own now (see `insecure_ws` in `session.ts`), and the CSP's `connect-src`
   pins the socket origin to `self` + our own `wss://<host>`. If you're
   diagnosing "connection just dies at open" on the deployed URL, verify
   the derived WS URL is `wss://`, not `ws://`.

3. **Invite deep link + `Referrer-Policy`.** Room codes ride in the URL
   (`/?room=CODE`). The default browser `Referer` policy would leak that
   URL to any outbound link the page follows. We set `Referrer-Policy:
   same-origin` for exactly this reason — don't relax it without moving the
   code out of the URL first.

## Cold starts (expected, not a bug)

Free-tier services **spin down after ~15 min idle**; the next request triggers a
**30–50 s cold start** while the instance boots. First visitor after a quiet
period waits; everyone after is instant until it idles again. We deliberately do
**not** run a keep-warm pinger. A live match that's idle long enough will also be
dropped on spin-down (in-memory state) — fine at this scale.

## If the build fails

The two most likely first-deploy failures, both already guarded in
`render.yaml` but worth knowing:

1. **`vite: not found` / `tsc: not found` / `esbuild: not found` during build.**
   Render sets `NODE_ENV=production`, which makes plain `npm ci` **skip
   devDependencies** — and `typescript`, `vite`, `esbuild` all live there. The
   fix is the `--include=dev` in `buildCommand: npm ci --include=dev && npm run
   build`. If you see this error, that flag was dropped from `render.yaml`.

2. **`Cannot find package '@emberfall/shared'` or a `.ts` import error at
   runtime.** The server is meant to run the **esbuild bundle** (`node
   dist/main.js`) with `shared/` inlined. This breaks if either: (a) the server
   `build` script reverted to `tsc --noEmit` (no `dist/main.js` emitted — the
   bundle step is the `esbuild …` half of the command), or (b) someone repointed
   `shared/package.json` `main` at `src/index.ts` *and* switched `start` back to
   `tsx`/`node src`. Runtime must be `node dist/main.js`; `shared` must be
   bundled, not resolved from `node_modules` at runtime. Verify locally with
   `npm run build && PORT=8099 node server/dist/main.js` then `curl
   localhost:8099/health`.

Other quick checks: `.nvmrc` pins Node 22 (Render honors it); `PORT` must **not**
be set in `render.yaml` (Render injects it, the server reads `process.env.PORT`).

---

# Oracle Cloud Always Free (Ampere A1) — REFERENCE ONLY

> Not the live target. Kept for a possible future self-hosted move. Predates the
> single-origin server refactor, so its Caddy-splits-static-from-`/ws` model and
> `npx tsx` start command differ from the current Render setup.

Target: one VM serving the static client (Caddy, auto-HTTPS) and the
WebSocket game server (Node, systemd). Total cost: $0.

## 1. Provision the VM

1. Oracle Cloud console → Compute → Create Instance.
   - Shape: **Ampere A1.Flex** (Always Free: up to 4 OCPU / 24 GB — 1 OCPU /
     6 GB is plenty for this game; a room costs microseconds per tick).
   - Image: **Ubuntu 24.04 (aarch64)**.
   - Add your SSH public key.
2. Networking (both layers are required — Oracle blocks by default):
   - **VCN Security List**: add ingress rules for TCP 80 and TCP 443 from
     0.0.0.0/0. (Port 8080 stays closed — Caddy proxies to it locally.)
   - **On the VM** (Ubuntu images ship iptables REJECT rules):
     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```

## 2. DNS

Point a domain/subdomain at the VM's public IP. No domain? Free options:
[DuckDNS](https://www.duckdns.org) (`yourname.duckdns.org`). HTTPS (and
therefore `wss:`) needs a hostname — browsers block mixed ws:// from
https:// pages.

## 3. Install runtime

```bash
sudo apt update && sudo apt install -y git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 4. Build

```bash
cd /opt && sudo mkdir emberfall && sudo chown $USER emberfall
git clone <your-repo-url> emberfall && cd emberfall   # or rsync the folder
npm ci
npm test                       # 264 tests should pass on the VM too
npm run build                  # client -> client/dist, server typecheck
```

## 5. Game server as a systemd service

`/etc/systemd/system/emberfall.service`:

```ini
[Unit]
Description=Emberfall Arena game server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/emberfall/server
Environment=PORT=8080
ExecStart=/usr/bin/npx tsx src/main.ts
Restart=always
RestartSec=3
# the sim is single-threaded; keep the box responsive
CPUQuota=200%
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now emberfall
journalctl -fu emberfall        # watch logs
```

## 6. Caddy: static client + /ws proxy + auto-HTTPS

`/etc/caddy/Caddyfile`:

```
yourname.duckdns.org {
    root * /opt/emberfall/client/dist
    file_server
    @ws path /ws
    reverse_proxy @ws localhost:8080
    encode gzip
}
```

```bash
sudo systemctl reload caddy
```

The client's default online URL is `wss://<host>/ws` when served over
HTTPS, so no client config is needed. Players visit:

- `https://yourname.duckdns.org/?server` → creates a room, shows the code
- `https://yourname.duckdns.org/?room=CODE` → joins it
- optional: `&char=goblin&name=Zed&stage=molten_span`

## 7. Verify under REAL network conditions (do not skip)

The netcode was verified under *simulated* latency/loss (Node-level link
with delay/jitter/drop — see `server/src/netcode.test.ts`). Before calling
it launched, verify on the wire:

1. Two machines on different networks (e.g., one on phone hotspot), play a
   full 2v2. Watch for rubber-banding, late hits, teleporting remotes.
2. Add artificial degradation on the server and play again:
   ```bash
   # 80ms ±20ms delay + 5% loss on the public interface
   sudo tc qdisc add dev enp0s6 root netem delay 80ms 20ms loss 5%
   # remove when done
   sudo tc qdisc del dev enp0s6 root
   ```
3. Kill a client mid-match (close tab) → the other players should see
   "PLAYER DISCONNECTED"; reopening `?room=CODE` within 30s reattaches;
   staying gone 30s forfeits the stocks.

## 8. Ops notes

- **Updates**: `git pull && npm ci && npm run build && sudo systemctl restart emberfall`.
  Restart kills live matches — do it when the server is empty
  (`journalctl -u emberfall | tail` shows joins/leaves).
- **Bandwidth** (measured, not estimated): JSON snapshots average ~4 KB at
  20 Hz ≈ **~81 KB/s down per client**; a full 4-player room ≈ **~324 KB/s ≈
  1.15 GB/hour** of egress (input up is ~5–6 KB/s per client). Oracle Always
  Free egress is 10 TB/month, so this is a non-concern there; on a metered host
  it's the first thing binary encoding would cut. (An earlier draft of this doc
  said ~30 KB/s — that was wrong; the real figure is ~2.7× higher.)
- **Backups**: there is no persistent state (rooms are in-memory). Back up
  the repo, nothing else.
- **Security posture**: inputs sanitized server-side (NaN/Infinity/garbage
  bits), 4 KB ws payload cap, names stripped to printable ASCII, room codes
  unguessable enough at this scale. No accounts, no PII, nothing to leak.
