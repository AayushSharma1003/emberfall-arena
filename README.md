# EMBERFALL 2: The Arena

Browser-based platform fighter. A full painterly single-player flow —
animated main menu, character select, live-thumbnail map select,
quick-match vs bots, and a results screen — over a server-authoritative
netcode core with client-side prediction. Nine hand-rigged fighters,
four maps, items, stage hazards. No external art: every fighter, arena,
and effect is coded (primitives, gradients, procedural rigs).

**Status:** single-player flow complete on top of the verified Phase-H
combat baseline. 257 headless tests green. Needs human playtesting for
feel/balance (see `docs/BUILD_LOG.md`).

## Run it

```bash
npm install
npm test           # full headless suite (sim, characters, bots, netcode, lobby, items, balance, flow, stats)
npm run dev        # client → http://localhost:5173  (main menu → quick match vs bots)
npm run dev:server # game server on :8080 (for online play)
```

Default boot is the **main menu**: Play walks you through character select
(pick yourself + a bot ally in 2v2) → map select (difficulty Easy/Normal/
Hard) → a quick match against bots → results (rematch or menu).

**`?hotseat`** boots the old two-player local sandbox (URL: `?hotseat&stage=molten_span`).

Online (dev): open `http://localhost:5173/?server` in one tab (creates a
room, shows the 4-letter code), `http://localhost:5173/?room=CODE` in
another. Optional params: `&char=goblin&name=Zed&stage=molten_span`.
Pick characters with 1-9, Space to ready up. 2-4 players (teams alternate
by join order: P1+P3 vs P2+P4).

## Deploy

Live target is **Render free tier** — one Web Service serves the client bundle
and the WebSocket game server on a single origin (so `wss://<host>/ws` needs no
client config). Blueprint: [`render.yaml`](render.yaml); runbook + build-failure
notes: [`docs/DEPLOY.md`](docs/DEPLOY.md).

```bash
npm run build                              # client/dist + server/dist/main.js
PORT=8099 node server/dist/main.js         # prod server: / client, /ws game, /health
```

<!-- deployed at: filled in after the first Render deploy -->

## Controls

**Menu / screens:** mouse or arrows/WASD to navigate · Enter/Space select ·
ESC back.
**In match (you're player 1):** WASD move · **mouse aims** · LMB light ·
RMB heavy · F special · Q ultimate · Shift dash · C crosshair · H hitbox
overlay · ESC bail to menu
**Hotseat P2:** Arrows move + 8-way aim · `,` light · `.` heavy ·
Right-Shift special · `/` dash · `'` ultimate
**Gamepad:** left stick move · right stick aim · A jump · X light · B
heavy · Y special · LB/RB dash · RT ultimate

## The roster

Each fighter has a **primary-attack class**: *melee* fighters swing a
short-range hitbox; *ranged* fighters fire a projectile on every primary
press (and keep a melee "get off me" heavy). Plus one signature mechanic
each.

| Character | Identity | Primary | Signature |
|---|---|---|---|
| Aldric (Knight) | balanced duelist | melee | Oath of Embers — parry/riposte ult |
| Maelis (Mage) | floaty zoner | ranged (bolt) | chargeable homing star |
| Wren (Ranger) | fast trapper | ranged (piercing arrow) | Embersnare proximity mines |
| Snik (Goblin) | rushdown, 3 jumps | melee | lobbed firecrackers |
| Gorvash (Ogre) | superheavy bruiser | melee | Kilnbreaker's Verdict, spike aerial |
| Vexis (Demon Queen) | elementalist | ranged (fire glob) | burn DoT + cinder zones |
| Sable | trickster | melee | Ash-step teleport + detonating clones |
| Hessa | forgewright | ranged (homing wisp) | deployable Little Kiln turrets |
| Pyre | wildcard | melee | kindle scaling, all-in Supernova |

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
shared/src/characters.ts ← frame data / stats / attackType for all 9 fighters
shared/src/stages.ts     ← 4 maps as plain platform data (+ hazards, blast zones)
shared/src/bot.ts        ← BotController: reads sim, emits InputFrames like a
                           human hand; attackType-aware; difficulty = BotParams
shared/src/matchstats.ts ← MatchStatsTracker: KOs/damage/MVP from the event stream
shared/src/netcode.ts    ← Predictor (reconciliation) + Interpolator
shared/src/snapshot.ts   ← full sim-state serialization (the wire format)
server/src/room.ts       ← authoritative room: input buffers, lag-comp hit
                           rewind, snapshots @20Hz, lobby, AFK forfeit
client/src/paint/rig.ts  ← procedural painterly fighter rigs (no sprites)
client/src/scenes/       ← per-theme parallax arenas (match + menu + thumbnails)
client/src/render.ts     ← all Pixi match rendering; draw states + sim events
client/src/ui/flow.ts    ← ScreenFlow state machine + ScreenHost fade host
client/src/ui/*.ts       ← menu / charselect / mapselect / match / results screens
client/src/main.ts       ← menu flow (default) + hotseat (?hotseat) + online
```

Netcode: sim at 60 Hz both sides; inputs batched at 30 packets/s with 2
redundant ticks vs loss; snapshots at 20 Hz; remote players interpolate
~133 ms in the past; melee hits are lag-compensated (victim hurtbox rewound
by attacker latency, capped 200 ms). Verified under simulated 80–150 ms
latency with 5–10% loss — see `server/src/netcode.test.ts`.

All feel-tuning lives in `TUNING` (sim.ts) and per-character frame data
(characters.ts). Build log with per-phase risk notes: `docs/BUILD_LOG.md`.
