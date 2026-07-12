# EMBERFALL 2 — Build Log

Phase-by-phase record: what was built, what's risky/unverified, what needs
human playtesting vs. what tests prove.

---

## Phase A0 — Headless regression suite (pre-requisite, was missing)

**Discrepancy flagged:** the build brief described sim.ts as "covered by a
headless test suite" — no test suite existed anywhere in the repo (no test
files, no runner installed, no test scripts). Before touching any verified
mechanic, a vitest suite was written to lock Phase-0 behavior.

**Built**
- vitest at the monorepo root; `npm test` runs everything.
- `client/src/engine/sim.test.ts` — 29 tests locking: run cap/friction,
  jump/double-jump/jump-cut/coyote/jump-buffer/drop-through, fall caps +
  fast-fall, dash (speed, gravity suspension, cooldown, one air dash),
  the exact knockback formula `(base + dmg% × growth) / weight`, hitstun
  formula, hitstop world-freeze, ground bounce, single-hit rule, invuln,
  ring-out/stocks/respawn, body push cap + dash-through, projectile flight /
  platform blocking / owner immunity / cooldown, and a 240-tick determinism
  check (identical inputs ⇒ identical serialized state).

**Behavior quirks discovered and deliberately preserved (not bugs yet):**
1. Dash starts mid-tick, so gravity applies once on the press tick and the
   fighter keeps that small constant vy during the dash.
2. A buffered jump that fires after the jump button was already released is
   jump-cut on the same tick → buffered jumps become short hops. Revisit in
   Phase B input-buffer work.

---

## Phase A — Frame-data schema, 6 characters, hitbox overlay

**Built**
- `shared/src/characters.ts` — the frame-data schema (`MoveDef`: startup/
  active/recovery ticks, hitbox size + reach-along-aim or fixed offset,
  damage, base knockback + growth, angle policy, hitstop, hitstun bonus,
  lunge impulse, cooldown, optional `ProjectileDef`) and `CharacterDef`
  (weight, jump count, size, speed/jump/fall multipliers). Lives in shared/
  so the Phase-C server sim imports the same data. Plain JSON-compatible
  objects, no client imports.
- Sim integration (`client/src/engine/sim.ts`): move slots (Light →
  light/aerial by grounded state, Heavy → heavy, Special button → special
  with cooldown), fixed-launch-angle knockback (mirrored by facing) alongside
  the existing 360° aimed knockback, lunge specials, projectile specials that
  fire at the first active tick, per-character movement multipliers.
  **The knockback/hitstun/movement/dash/collision formulas are unchanged** —
  multipliers scale their inputs; the regression suite from A0 still passes
  against the Knight (reference stats).
- Roster (all box-rendered, permanently for now):
  - **Knight** — balanced, weight 1.05; the only character with **no
    projectile**; Shield Charge lunge special (90-tick cooldown).
  - **Mage** — floaty (fall ×0.8), light, slow; Nova Burst radial launcher
    (60° fixed); straight Ember Bolt.
  - **Ranger** — fast (×1.15), arcing Longshot Arrow (gravityScale 0.5),
    fastest special cooldown.
  - **Goblin** — 0.7 weight, ×1.3 speed, **3 jumps**, startup-2 light with
    bonus hitstun (combo tool), lobbed Firecracker (gravityScale 0.9).
  - **Ogre** — 1.5 weight, ×0.75 speed, startup-20 Seismic Slam launcher
    (85° fixed), the roster's only **spike** (aerial, −70°), huge Boulder.
  - **Demon Queen** — heavy all-rounder, strong everything, long recovery +
    long special cooldown.
- Dev hitbox overlay (key **H**): hurtboxes (green), active melee hitboxes
  (red), projectile radii. Hotseat character switching (1-6 for P1, 9/0
  cycles P2), match reset (R). HUD shows character names.
- `client/src/engine/characters.test.ts` — 47 tests: schema validation for
  every move; every melee move exercised end-to-end (startup respected, exact
  damage, **exact knockback vector** including fixed-angle math and ground-
  bounce); every projectile special (spawn timing, def carried, hit at range,
  cooldown); melee-special cooldown + lunge displacement; aerial slot wiring;
  roster-distinctness invariants (unique weights, speed ordering, goblin's
  triple jump, knight's projectile-lessness, projectile shape variety, frame
  speed spread, unique move ids); 36-matchup chaos smoke test.

**Test status: 76/76 green.** Client `tsc --noEmit` + vite build green,
server tsc green.

**Architecturally risky / unverified**
- Landing does not cancel an aerial attack; attacks continue through
  landing. Deliberate simplification — revisit if it feels wrong.
- Heavy is usable airborne (same grounded move data). Fine for now; flag
  for balance.
- `setCharacter` swaps stats mid-match (dev feature); lobby (Phase D) will
  construct fighters properly.
- Browser preview tooling in this session is broken (sandbox EPERM before
  any command runs), so the renderer changes were verified by typecheck +
  build only, not visually.

**Needs human playtesting (not provable by tests)**
- Whether the six characters *feel* distinct, not just measure distinct.
- Balance numbers (damage/knockback/cooldowns are first-pass guesses).
- Whether fixed-angle launchers (Ogre slam, Mage nova) read well with the
  aim-driven scheme.
- Goblin's 3 jumps + ×1.3 speed may be obnoxious; Ogre may be too slow to
  ever land Seismic Slam against a competent player.

---

## Phase B — Renderer & feel polish

**Sim-side (tested, 80/80 green)**
- **Fixed: buffered jumps short-hopped by accident.** A jump buffered before
  landing fired on the landing tick with `jumpHeld` set unconditionally; the
  jump-cut check then saw the button already released and multiplied vy by
  0.45 on the same tick. Now `jumpHeld` reflects the actual button state at
  fire time. (This was the one intentional change to a verified mechanic;
  bug explained above, covered by a regression test.)
- **New: 8-tick attack buffer.** Attack presses during recovery, hitstun, or
  a dash used to be silently dropped. They now buffer for ~130ms and fire on
  the first free tick, resolving light-vs-aerial and special cooldown at fire
  time. Cleared on ring-out so nothing fires after respawn. 4 new tests.

**Client-side (typecheck + build verified; NOT visually verified — the
session's browser preview tooling is broken at the sandbox level)**
- Camera: hard clamp to stage bounds (never frames the void), velocity
  look-ahead (leads fast movement, capped, gentler vertically), and a
  directional "kick" — every hit nudges the camera along the knockback
  vector on top of the existing random shake.
- HUD: bottom-center player cards (color stripe, character name, big
  damage% that pulses on change and lerps white→red, stock pips), replacing
  the top-left debug text. Win banner suggests R-to-rematch.
- Readability: short aim tick on every fighter showing current aim; rattle
  jitter while in hitstun/hitstop.
- SFX hook points: `engine/audio.ts` defines an `AudioBus` with typed ids
  (hit_light/hit_heavy/ko/jump/dash/land/shoot/…); every juicy event routes
  through it; `silentAudio` no-ops. Shipping audio = implement the interface,
  swap one constant.

**Needs human playtesting**
- All of it, frankly: kick/shake magnitudes, look-ahead strength, card
  layout, jitter amount. These are taste numbers set blind (preview tooling
  broken); they compile and the math is sane, but "reads responsive and
  intentional" is your call. The knobs: `LOOKAHEAD`/`KICK_DECAY` in
  camera.ts, `addKick`/`addShake` magnitudes in main.ts handleEvents,
  `attackBufferTicks` in sim.ts TUNING.

---

## Phase C — Netcode

**Two deliberate deviations from the brief (flagged, not hidden):**
1. *Sim moved to `shared/src/sim.ts` instead of being copied to
   `server/src/sim/`.* Client and server import the same module, so
   client/server determinism is structural — there is no second copy to
   drift. The brief's actual goal ("verify determinism, identical inputs →
   identical output") is still tested explicitly via snapshot round-trips.
2. *Sim stays 60 Hz on the server, not 30 Hz.* Every tuning constant,
   frame-data tick, and the whole test suite is expressed in 60 Hz ticks; a
   30 Hz sim would change game feel wholesale. The network rates are what
   the 30 Hz figure was really about: inputs ship at 30 packets/s (2 ticks
   batched + 2 redundant vs loss), snapshots broadcast at 20 Hz. A 60 Hz
   2-fighter sim tick costs microseconds; the Ampere VM won't notice.

**Architecture**
- `shared/src/snapshot.ts` — full sim-state serialization (every mutable
  field; a forgotten field = desync, and the round-trip test would catch it).
- `shared/src/netcode.ts` — `Predictor` (client runs the same sim `lead`
  ticks ahead, predicts own fighter, reconciles by loading each snapshot
  verbatim and re-simulating pending inputs; `lead` self-tunes from server
  starvation feedback) and `Interpolator` (remote fighters render
  ~133 ms in the past, lerped between snapshots; projectiles dead-reckoned).
- `server/src/room.ts` — transport-agnostic authoritative room: 60 Hz step,
  per-player input buffers with hold-last extrapolation, snapshots every 3rd
  tick with per-player input acks, position-history ring +
  **lag-compensated melee rewind** (victim hurtbox rewound by attacker's
  one-way latency, capped at 200 ms) via a sim hook that clients never set.
- `server/src/main.ts` — ws transport, room registry with 4-letter codes,
  ping→latency wiring, drift-corrected tick loop.
- Client: renderer extracted to `render.ts` (shared by both modes);
  `main.ts` has local hotseat (unchanged behavior) + online mode
  (`?server&room=CODE&char=id&name=x`): prediction + reconciliation with
  decaying visual smoothing (snaps if >220 px), interpolated remotes, own
  projectiles predicted / remote interpolated, own movement events played
  instantly / hit-KO events on server authority only. Reconnect tokens in
  sessionStorage.

**Verification (86/86 green)**
- Determinism: two sims through a JSON wire round-trip stay byte-identical
  over 400 ticks of scripted combat.
- **Latency/loss harness (Node-level netem equivalent, per ground rule 6):**
  a real `Room` and a real `Predictor` connected through a deterministic
  lossy link. 80 ms one-way + 5% loss + ±2 ticks jitter: median prediction
  error < 2 px, corrections bounded. 150 ms + 10% loss + ±3 ticks: still
  bounded/convergent. After the link drains and the server catches up on
  the inputs it missed, predicted and authoritative state agree to 1e-6.
- Lag comp: a hit that whiffs against live positions lands with rewind, at
  sim level and through the room's real history/latency wiring; the control
  run (same schedule, zero latency) correctly whiffs.
- E2E over real sockets: join → code → auto-begin → snapshots at exactly
  3-tick cadence → inputs move the authoritative fighter → token reconnect
  resumes the same slot mid-match.

**Architecturally risky / unverified — read this list before trusting it**
- **Not verified with a human on a real network.** The harness simulates
  delay/jitter/loss faithfully at the message level, but real-world TCP
  head-of-line blocking (WebSocket = TCP), wifi bursts, and browser timer
  throttling are different animals. Needs: two machines, real internet,
  ideally `tc netem` on the server (commands in the Phase G checklist).
- Remote players are simulated with NEUTRAL inputs inside the predictor
  between snapshots, so prediction of *interactions* (body push, trades) is
  weak; the authoritative correction absorbs it. Standard v1 tradeoff.
- Hitstop during reconciliation replay can make corrections feel "sticky"
  around trades at high ping — watch for it in playtests.
- JSON protocol (~1-2 KB/snapshot → ~30 KB/s/client). Fine for free-tier
  egress; binary encoding is the first optimization if bandwidth matters.
- Browser tab throttling (background tab = 1 Hz timers) will starve the
  server of inputs; hold-last covers seconds, not minutes.

**Needs human playtesting**
- Feel at 60-150 ms real ping: reconciliation smoothing constants
  (`exp(-12·dt)` decay, 220 px snap threshold), interpolation delay
  (`INTERP_DELAY_TICKS = 8`), input lead tuning aggressiveness.
- Whether server-authoritative hit events arriving ~1 RTT late read as
  "laggy hits" — if so, consider predicted hit VFX with server confirm.

---

## Phase D — Lobby, room codes, character select, reconnect

**Built**
- Server: real lobby flow in Room — `setChar` (lobby-only, un-readies you),
  `setReady`, auto-start when 2+ connected players are all ready; lobby
  state broadcast on every change; disconnect un-readies and tombstones the
  slot; reconnect (`join` with token) reattaches the same player id and, if
  the match is live, re-sends `begin` so the client rebuilds its predictor.
  Auto-start-on-full became a test-only flag.
- Client: `lobby.ts` — Pixi lobby screen (room code, roster with per-player
  character + ready status, share-URL hint). Keys: 1-6 pick character,
  Space/Enter toggles ready. `begin` tears it down and resets prediction
  state; `gameOver` shows VICTORY/DEFEAT. Reconnect token stored per-room in
  sessionStorage; refreshing the page mid-match auto-reattaches.
- Room-code matchmaking was already in the Phase C transport (4-letter
  codes, `?room=CODE` join, no-room → create).

**Tests: 92/92 green** (6 new lobby tests: broadcast flow, char select
locking after start, char-change clears ready, solo-ready doesn't start,
wrong-token rejection, reconnect slot restoration + snapshots resume,
full-room rejection). E2E over real sockets: full lobby → ready-up → play →
mid-match token reconnect with `begin` re-sent and snapshots flowing.

**Limitations / notes**
- Lobby slots are tombstoned on disconnect (ids are fighter indices);
  only that player's token can reclaim the slot. A 2-slot room where a
  stranger leaves pre-match therefore can't accept a replacement — create a
  new room. Fine at this scale; noted for later.
- No rematch flow: gameOver → refresh to re-lobby. Cheap to add later.
- Lobby UI is keyboard-only (no clickable buttons) — consistent with the
  box-art constraint; needs a human eye for layout sanity.

---

## Phase E — 2v2 mode

**Design decisions (flagged as requested)**
- **Stock pools: individual (3 each); a team is eliminated when all its
  members are out.** Chosen over a shared team pool because it needs no new
  state, reads clearly on per-player HUD cards, and matches Smash 2v2
  conventions. Switching to a shared pool later = a localized change in the
  ring-out/win-check path (decrement a team counter instead of a fighter
  counter). Easy to change.
- **Friendly fire: OFF by default** (`Sim.friendlyFire` flips it). Teammates
  still body-push each other (no stacking exploits).
- Teams alternate by join order (P1/P3 vs P2/P4). Player colors already
  read warm-vs-cool (red/yellow vs blue/purple).

**Built**
- Sim: `Fighter.team`, team-aware melee + projectile hit filtering, 4 spawn
  points on the stage, `addFighter(charId, team)`.
- Snapshot/netcode: team serialized (round-trip tested); `Predictor` takes a
  roster of `{charId, team}`.
- Room: MAX_PLAYERS = 4, teams assigned on join, win condition is now
  team-based (match continues while 2+ teams have stocks; `winners` =
  everyone on the surviving team; empty = draw/double-KO). A 3-player room
  starts an uneven 2v1 if everyone readies — allowed deliberately, noted.
- Client: roster/teams threaded through prediction and display fighters.
  Renderer/camera/HUD were already count-agnostic (4 cards fit ≥1024 px).

**Tests: 101/101 green.** New: 8 team tests (FF off for melee + projectiles
through teammates, FF flag, teammate body push, team snapshot round-trip,
4-fighter determinism/finiteness) + room-level team elimination test
(one member down ≠ team out; both down = gameOver with both winners) +
4-player E2E over real sockets (teams 0,1,0,1 in begin, 4 fighters with
teams in snapshots).

**Needs human playtesting**
- Camera at 4 players (it frames all live fighters and clamps to stage
  bounds; whether max zoom-out feels readable is a taste call).
- 2v2 balance: double-team juggling with no FF may need respawn-invuln or
  hitstun-decay tuning. Watch for it.

---

## Phase F — Items + 2 maps

**Design choices (flagged)**
- **Items are instant-effect on pickup** — "use" is folded into "pickup" so
  the input scheme stays untouched. Heart heals 35%; Wings refresh
  jumps/air-dash + 5s of +25% run speed; Bomb auto-throws a heavy arcing
  projectile (owned by the picker) up-forward along facing. If a held-item
  system is ever wanted, the Special-button path is where it would hook in.
- **Item spawns are deterministic** — kind and location rotate on a fixed
  tick schedule (every 10s, max 2 active). No RNG to synchronize, so the
  netcode needed zero changes; prediction covers item pickups for free, and
  players can learn the rotation (a feature at this scale, not a bug).

**Built**
- Sim: `WorldItem` system (spawn rotation, AABB pickup by first live
  fighter, per-kind effects, `speedBoost` fighter timer, cleared on death),
  `itemspawn`/`item` events, `itemsEnabled` flag, `Stage.itemSpawns`.
- Maps: stage registry (`shared/src/stages.ts`, `stageById` with safe
  fallback). Map 2 **Molten Span**: two solid islands with a lethal center
  gap, a soft bridge over it, two high side floats — rewards edge-guarding
  where Keep rewards juggling. Pure platform JSON, box backgrounds.
- Stage flows through the whole stack: room creator's `?stage=` request →
  room → `welcome/begin.stageId` → client builds renderer + predictor for
  that stage (renderer construction now deferred until the stage is known).
  Local mode: `?stage=molten_span`.
- Snapshots carry items + speedBoost (round-trip tested); interpolator
  passes items through; renderer draws the three item shapes (bobbing) and
  pickup popups; two new silent SFX ids.

**Tests: 115/115 green.** 14 new: deterministic spawn rotation, active cap,
no-spawn stages, disable flag, heal + floor-at-zero, wings refresh + boosted
top speed + expiry, bomb throw/arc/hit, dead-fighter pickup denial,
items/boost snapshot determinism, map-2 registry/fallback, lethal gap,
bridge collision, spawn-point sanity.

**Needs human playtesting**
- Item balance (heal 35% may be too swingy at 2 stocks; bomb knockback).
- Whether the deterministic rotation feels fine or telegraphed-boring.
- Molten Span's gap width (220 px) vs dash distance — is crossing without
  the bridge possible for every character? (Dash covers ~225 px + momentum,
  so it should be barely makeable with a jump; verify it feels fair.)

---

## Phase G — Balance envelopes, hardening, anti-troll, launch prep

**Balance pass (what tests CAN do without humans)**
`shared/src/balance.test.ts` pins the roster inside envelopes so future
tuning edits that make one character silently dominant fail CI:
- Light DPS band 15–30 with max/min spread < 1.35× (measured: 20.0–23.3 —
  the roster is naturally tight).
- Heavy reward-vs-risk: knockback@100% per startup-tick ∈ [120, 290]; the
  fastest heavy < 70% of the slowest heavy's knockback.
- weight × speed ∈ [0.7, 1.2] (no fast heavyweights).
- Projectiles never out-damage the same character's heavy; stronger
  projectiles never cool down faster than much weaker ones.
Real balance verdicts (matchups, edge-guarding, item swing) remain human
work — the numbers only rule out obvious dominance.

**Hardening / anti-troll**
- Input sanitization at the room boundary: NaN/Infinity aim (which would
  poison the entire sim via `Math.hypot`), garbage button bits, non-finite
  ticks, oversized batches — all normalized or dropped. Tested with a
  malicious-client test.
- ws `maxPayload: 4096` (legit packets are ~200 B); names stripped to
  printable ASCII.
- **AFK/rage-quit forfeit**: disconnected >30 s mid-match → stocks
  forfeited → team elimination check runs (a 2v1 continues; a deserted 1v1
  ends). Reconnecting within the window keeps everything. Both paths
  tested.
- Empty rooms GC'd; stale input buffers GC'd.

**Deployment** — `docs/DEPLOY.md`: Oracle Ampere A1 provisioning (VCN +
iptables both), DuckDNS for a free hostname, Node 22 + Caddy (static client
+ `/ws` reverse proxy + auto-HTTPS), systemd unit with restart/resource
caps, `tc netem` commands for the mandatory real-network verification, ops
notes (bandwidth math, update procedure, security posture). Client defaults
to same-origin `wss://host/ws` under HTTPS — zero client config in prod.

**Final state: 123/123 tests green; client+server build clean.**

**What launch still needs from a human (cannot be automated here)**
1. Playtest feel: hit-pause/shake/kick magnitudes, netcode smoothing at
   real ping, camera at 4 players.
2. Real-network verification (two machines + `tc netem`, steps in
   DEPLOY.md §7) — the harness simulated the link, not TCP-on-wifi reality.
3. Balance verdicts from actual matches.
4. The deploy itself (account, domain, DNS).

**Known deliberate gaps** (rejected as out-of-$0-scope, revisit on traction)
- No rematch flow (refresh to re-lobby), no spectators, no profanity
  filter, no accounts/persistence, JSON (not binary) protocol, lobby slots
  tombstone on stranger-leave, no mobile/touch input.

---

## Phase H — Painterly rigs, roster to 9, melee/ranged primaries

(Summarized from the pre-flow commits `7ac4f12` + `2b26855`.)
- Fighters became procedural painterly rigs (`client/src/paint/`) driven from
  sim state — bone hierarchies posed per (state, velocity, attack timeline,
  aim), plus a flame rig for Pyre. No sprites.
- Roster grew from 6 to 9 (Sable, Hessa, Pyre added); 4 maps (Stormshard,
  Ashwood added) with parallax scenes + stage hazards.
- **Melee/ranged primary distinction** (`CharacterDef.attackType`): melee
  fighters swing; ranged fighters fire a projectile on every primary press
  and keep a melee heavy. Sim reads it via `move.kind` (schema-locked), the
  bot spaces/attacks by it, the rig picks cast/bow-draw vs swing poses.
- 241 tests at the end of this phase.

---

## Phase I — Single-player flow: menu, selects, quick match, results

**Built (this phase)**
- **Screen state machine** (`client/src/ui/flow.ts`): typed `ScreenFlow`
  (menu | charselect | mapselect | loading | match | results) with a
  legal-transition table, `MatchConfig`/`MatchDraft`/`MatchResult` payloads,
  `rosterOf()` slot ordering, and `ScreenHost` — a fade-driven mount/unmount
  orchestrator. Its ordering guarantees (old unmounted exactly once before
  new mounts; retarget mid-fade without double-mounting) ARE the
  container-teardown / no-leak contract, tested headlessly.
- **Match stats** (`shared/src/matchstats.ts`): `MatchStatsTracker` consumes
  the sim event stream + a per-tick damage sweep → KOs (credited to the last
  direct hitter; hazard/self falls credit nobody), damage dealt/taken (burn
  chip counted via damage diff), and an MVP score. Lives in shared/ so a
  server could tally identically.
- **Screens** (`client/src/ui/`): a shared UI kit (`screens.ts`: palette,
  serif/mono styles, `UiButton` with ember-underline hover, `EmberEmitter`,
  `BaseScreen` with per-mount fresh root + auto-removed listeners + resize
  layout). Main menu reuses `KeepScene` as a slow-panning vista under an
  animated title; character select is a 9-fighter grid + a live rig-puppet
  preview that loops each fighter's *actual* primary (ranged fighters
  cast/draw/lob a projectile matching their `ProjectileDef`, melee swing);
  map select renders 4 live `MiniScene` thumbnails (real `StageScene` at
  0.32× particle density) with blast-shape/hazard/mood detail; match runs the
  hotseat loop with one human + difficulty-gated `BotController`s; results
  shows per-fighter panels with MVP crown + rematch.
- **Wiring** (`main.ts`): default boot is the menu flow; hotseat moved behind
  `?hotseat`; online untouched. Shared P1 input assembly extracted to
  `engine/localinput.ts`; `projDraw` moved to `render.ts`. Entry module
  declines HMR so dev hot-patches can't stack a second Pixi app/ticker.

**Design decisions (flagged)**
- **Quick-match MVP is 1v1 vs one bot, with 2v2 built into the config type
  from day one.** `MatchConfig.mode` + `rosterOf()` produce a 1-human /
  1-bot solo roster or a 2v2 (human + bot ally vs two bots) with zero sim
  changes — `addFighter(charId, team)` already existed. Char select lets you
  assemble a 2-fighter team so the UI never needs rework to enable 2v2.
- **Difficulty maps straight onto the existing `botLevel(1|2|3)`** — no new
  AI, just gated `BotParams` (reaction/aggression/wisdom).
- **Opponents are random distinct characters** (mirror allowed only if the
  roster runs out), seeded per match so a rematch reseeds for variety.

**Tests: 257/257 green** (16 new: 6 flow — legal-transition table, config
handoff, rematch reseed, roster ordering; 6 host — boot-without-fade,
swap-at-black ordering, retarget-mid-fade no double-mount, alpha peaks at 1
on swap; 10 stats — hit/KO/self/hazard credit, burn-in-taken, MVP weighting,
end-to-end through a real sim exchange). Client `tsc --noEmit` + build clean.

**Verified in-browser** (screens are visual; the sim/flow/stats logic is
test-locked): menu vista + hover + settings; character select roster with
ranged-vs-melee preview poses/chips; map select live thumbnails + per-map
blast-shape; a full quick match — 3-2-1 countdown → live combat → a Wren
(ranged) bot kiting and firing arcing arrows rather than swinging → match
resolves → results with correct MVP/attribution → rematch reseeds.
(Preview-pane rAF throttling freezes fades mid-transition between automated
tool calls — an environment artifact, not a bug; `ScreenHost` was driven
deterministically to verify.)

**Needs human playtesting (not provable by tests)**
- Whether the menu hits the "concept-art-in-motion" bar; transition timing
  feel (`FADE_OUT_S`/`FADE_IN_S`).
- Bot difficulty curve at Easy/Normal/Hard against a real player (the AI was
  only ever verified against a passive human here).
- 2v2 quick-match balance with a bot ally (the mode works; feel is untested).

**Deferred / out of scope for this phase** (per the brief)
- 2v2 online lobby + room-code UX (next phase; single-player flow first).
- Full settings screen (stubbed: volume + fullscreen only).
- Audio implementation (hooks reserved in `engine/audio.ts`; UI routes
  `ui_move`/`ui_select`/`ui_back`/`countdown`/`match_win` through the bus).
