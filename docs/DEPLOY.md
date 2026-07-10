# Deploying to Oracle Cloud Always Free (Ampere A1)

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
npm test                       # 123 tests should pass on the VM too
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
- **Bandwidth**: JSON snapshots ≈ 30 KB/s per client in a 4-player match ≈
  0.4 GB/hour for a full room. Always Free egress is 10 TB/month — not a
  concern until the game is popular enough to deserve binary encoding.
- **Backups**: there is no persistent state (rooms are in-memory). Back up
  the repo, nothing else.
- **Security posture**: inputs sanitized server-side (NaN/Infinity/garbage
  bits), 4 KB ws payload cap, names stripped to printable ASCII, room codes
  unguessable enough at this scale. No accounts, no PII, nothing to leak.
