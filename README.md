# EMBERFALL 2: The Arena

Browser-based 2v2 platform fighter. Server-authoritative netcode with
client-side prediction, six characters, items, two maps — all rendered as
colored boxes (deliberate: $0 art budget, the feel IS the game).

**Status:** feature-complete through Phase G. 123 headless tests green.
Needs human playtesting for feel/balance (see `docs/BUILD_LOG.md`).

## Run it

```bash
npm install
npm test           # full headless suite (sim, characters, netcode, lobby, items, balance)
npm run dev        # client → http://localhost:5173  (local hotseat 1v1)
npm run dev:server # game server on :8080 (for online play)
```

Online (dev): open `http://localhost:5173/?server` in one tab (creates a
room, shows the 4-letter code), `http://localhost:5173/?room=CODE` in
another. Optional params: `&char=goblin&name=Zed&stage=molten_span`.
Pick characters with 1-6, Space to ready up. 2-4 players (teams alternate
by join order: P1+P3 vs P2+P4).

Deploying to Oracle Cloud Always Free: `docs/DEPLOY.md`.

## Controls

**P1 (hotseat + online):** WASD move · **mouse aims** · LMB light · RMB
heavy · F special · Shift dash · C crosshair · H hitbox overlay
**P2 (hotseat):** Arrows move + 8-way aim · `,` light · `.` heavy ·
Right-Shift special · `/` dash
**Gamepad:** left stick move · right stick aim · A jump · X light · B
heavy · Y special · LB/RB dash
**Hotseat extras:** 1-6 P1 character · 9/0 cycle P2 · R reset match

## The roster

| Character | Identity | Weight | Speed | Special |
|---|---|---|---|---|
| Knight | balanced sword-and-board | 1.05 | 1.0 | Shield Charge (lunge, no projectile) |
| Mage | floaty zoner | 0.85 | 0.88 | Ember Bolt (straight) |
| Ranger | fast skirmisher | 0.9 | 1.15 | Longshot Arrow (arcs) |
| Goblin | rushdown, 3 jumps | 0.7 | 1.3 | Firecracker (lobbed) |
| Ogre | superheavy, spike aerial | 1.5 | 0.75 | Boulder Toss |
| Demon Queen | power all-rounder | 1.15 | 1.0 | Soulfire (fast bolt) |

Items (every 10s, deterministic rotation): **Heart** heals 35% · **Wings**
refresh jumps + speed boost · **Bomb** auto-throws a heavy arc.

## Mechanics

- **360° combat:** attacks fire along your aim, locked at press. Knockback
  `(base_kb + damage% × growth) / weight`; some moves launch at fixed
  angles instead (Ogre's slam, spikes). Downward hits on grounded targets
  bounce up.
- **Movement feel:** coyote time, jump buffering, attack buffering (~130ms),
  variable jump height, fast-fall, dash with one air-dash per airtime.
- **2v2:** friendly fire off (teammates still body-push), individual
  stocks, team eliminated when all members are out.

## Architecture

```
shared/src/sim.ts        ← THE fixed-tick sim (60Hz). One module, imported by
                           client (prediction) AND server (authority) —
                           determinism is structural, and tested.
shared/src/characters.ts ← frame data / stats for all six characters
shared/src/stages.ts     ← maps as plain platform data
shared/src/netcode.ts    ← Predictor (reconciliation) + Interpolator
shared/src/snapshot.ts   ← full sim-state serialization (the wire format)
server/src/room.ts       ← authoritative room: input buffers, lag-comp hit
                           rewind, snapshots @20Hz, lobby, AFK forfeit
client/src/render.ts     ← all Pixi; consumes draw states + sim events
client/src/main.ts       ← local hotseat mode + online mode
```

Netcode: sim at 60 Hz both sides; inputs batched at 30 packets/s with 2
redundant ticks vs loss; snapshots at 20 Hz; remote players interpolate
~133 ms in the past; melee hits are lag-compensated (victim hurtbox rewound
by attacker latency, capped 200 ms). Verified under simulated 80–150 ms
latency with 5–10% loss — see `server/src/netcode.test.ts`.

All feel-tuning lives in `TUNING` (sim.ts) and per-character frame data
(characters.ts). Build log with per-phase risk notes: `docs/BUILD_LOG.md`.
