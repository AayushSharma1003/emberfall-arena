/**
 * Entry point + game modes.
 *
 *  - Menu flow (default): main menu -> character select -> map select ->
 *    quick match vs bots -> results. Screen state machine in ui/flow.ts.
 *  - Local hotseat (?hotseat): two players, one sim, one machine.
 *    URL: ?hotseat&stage=molten_span picks the map.
 *  - Online (?server[=ws://host:port]&room=CODE&char=knight&name=NAME&stage=id):
 *    server-authoritative with client prediction + reconciliation for the
 *    local fighter and snapshot interpolation for remote fighters. The
 *    stage is chosen by whoever creates the room.
 */
// the deploy ships a strict CSP (script-src 'self', no unsafe-eval); this
// shim swaps Pixi's new Function() codegen for precompiled equivalents
import "pixi.js/unsafe-eval";
import { Application, Graphics } from "pixi.js";
import {
  CHARACTERS, CHAR_IDS, DT, INPUT_BATCH, INTERP_DELAY_TICKS, STAGE_INFO,
  Sim, Predictor, Interpolator, makeFighter, stageById, applyFighterSnap,
  type CharId, type Fighter, type InputFrame, type PlayerInfo, type SimEvent,
  type Stage, type TickInput,
} from "@emberfall/shared";
import { makeScene, PLATFORM_PALETTES } from "./scenes/index.js";
import { Keyboard, Mouse, Gamepads } from "./engine/input.js";
import { buildP1Input, p1Reticle, type P1Sources } from "./engine/localinput.js";
import {
  GameRenderer, projDraw,
  type DrawConstruct, type DrawFighter, type DrawItem, type DrawProj, type DrawWorld, type DrawZone,
} from "./render.js";
import { NetClient } from "./net.js";
import { LobbyScreen } from "./lobby.js";
import { silentAudio } from "./engine/audio.js";
import { parseBoot, readResumeMarker, resumeIntent } from "./boot.js";
import { OnlineSession } from "./online/session.js";
import { ScreenFlow, ScreenHost, type ScreenId, type ScreenView } from "./ui/flow.js";
import type { UiContext } from "./ui/screens.js";
import { MenuScreen } from "./ui/menu.js";
import { CharSelectScreen } from "./ui/charselect.js";
import { MapSelectScreen } from "./ui/mapselect.js";
import { PlaceholderScreen } from "./ui/placeholder.js";
import { MatchScreen } from "./ui/match.js";
import { ResultsScreen } from "./ui/results.js";
import { OnlineScreen } from "./ui/online.js";
import { OnlineLobbyScreen } from "./ui/onlinelobby.js";
import { OnlineMatchScreen } from "./ui/onlinematch.js";

async function main(): Promise<void> {
  const app = new Application();
  await app.init({
    resizeTo: window,
    background: 0x14101c,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio, 2),
    autoDensity: true,
  });
  document.body.appendChild(app.canvas);

  let intent = parseBoot(location.search);
  if (intent.mode === "menu") {
    // reopened mid-match? the resume marker gets us back into the room
    intent = resumeIntent(readResumeMarker()) ?? intent;
  }
  if (intent.mode === "legacyOnline") {
    onlineMode(app, new URLSearchParams(location.search));
  } else if (intent.mode === "hotseat") {
    localMode(app, new URLSearchParams(location.search));
  } else {
    menuMode(app, intent.mode === "online" ? intent : null);
  }
}

// ---------------------------------------------------------------------------
// menu flow (default boot)
// ---------------------------------------------------------------------------

function menuMode(app: Application, online: { code: string; host: boolean } | null): void {
  // invite deep link: consume it, then scrub the query so the room code never
  // rides along in history or a Referer header
  if (online) history.replaceState(null, "", location.pathname);

  const flow = new ScreenFlow(online ? "online" : "menu");
  flow.onlineIntent = online;
  const session = new OnlineSession();
  const ctx: UiContext = { app, flow, audio: silentAudio, online: session };
  const views: Record<ScreenId, ScreenView> = {
    menu: new MenuScreen(ctx),
    charselect: new CharSelectScreen(ctx),
    mapselect: new MapSelectScreen(ctx),
    loading: new PlaceholderScreen(ctx, "loading", "THE EMBERS STIR…", null, { to: "match", afterS: 0.7 }),
    match: new MatchScreen(ctx),
    results: new ResultsScreen(ctx),
    online: new OnlineScreen(ctx),
    onlinelobby: new OnlineLobbyScreen(ctx),
    onlinematch: new OnlineMatchScreen(ctx),
  };
  const host = new ScreenHost(views, flow);
  host.boot();

  // fade overlay rides above every screen (and above match renderers, which
  // add their own containers to app.stage — hence the re-raise each frame)
  const overlay = new Graphics();
  app.stage.addChild(overlay);
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    host.update(dt);
    overlay.clear();
    if (host.overlayAlpha > 0.001) {
      overlay.rect(0, 0, app.screen.width, app.screen.height).fill({ color: 0x08060e, alpha: host.overlayAlpha });
    }
    app.stage.addChild(overlay);
  });
}

// ---------------------------------------------------------------------------
// local hotseat
// ---------------------------------------------------------------------------

function localMode(app: Application, params: URLSearchParams): void {
  const picked = stageById(params.get("stage"));
  const stage = picked.make();
  const sim = new Sim(stage);
  sim.addFighter("knight");
  sim.addFighter("ogre").facing = -1;

  const renderer = new GameRenderer(app, stage);
  const theme = STAGE_INFO[picked.id].theme;
  renderer.platformPalette = PLATFORM_PALETTES[theme];
  renderer.scene = makeScene(theme, stage, { under: renderer.sceneUnder, over: renderer.sceneOver });
  renderer.setHelp([
    "P1  WASD · mouse aim · LMB light · RMB heavy · F special · Shift dash        1-6 P1 char · 9/0 P2 char",
    "P2  Arrows move/aim · , light · . heavy · RShift special · / dash            H hitboxes · R reset · C crosshair",
    "Gamepads: stick move · R-stick aim · A jump · X light · B heavy · Y special · RB dash",
    "?stage=molten_span for map 2 · add ?server to the URL for online (see README)",
  ].join("\n"));

  const src: P1Sources = { keyboard: new Keyboard(), mouse: new Mouse(app.canvas), gamepads: new Gamepads() };
  let crosshairVisible = true;

  function resetMatch(): void {
    sim.projectiles.length = 0;
    sim.items.length = 0;
    sim.hitstop = 0;
    sim.fighters.forEach((f, i) => {
      const s = stage.spawns[i % stage.spawns.length];
      f.x = s.x; f.y = s.y - 100; f.vx = 0; f.vy = 0;
      f.damage = 0; f.stocks = 3; f.state = "fall";
      f.hitstun = 0; f.invuln = 0; f.respawnTimer = 0; f.speedBoost = 0;
      f.attack = null; f.attackTick = 0; f.hitConfirmed = false;
      f.bufSlot = null; f.bufTicks = 0;
      f.dashTicks = 0; f.dashCooldown = 0; f.specialCooldown = 0;
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyC") crosshairVisible = !crosshairVisible;
    if (e.code === "KeyH") renderer.showHitboxes = !renderer.showHitboxes;
    if (e.code === "KeyR") resetMatch();
    const digit = e.code.match(/^Digit([1-9])$/);
    if (digit) sim.setCharacter(0, CHAR_IDS[Number(digit[1]) - 1]);
    if (e.code === "Digit0" || e.code === "Minus") {
      const cur = CHAR_IDS.indexOf(sim.fighters[1].charId);
      const next = (cur + (e.code === "Digit0" ? 1 : CHAR_IDS.length - 1)) % CHAR_IDS.length;
      sim.setCharacter(1, CHAR_IDS[next]);
    }
  });

  function buildInputs(): InputFrame[] {
    const f1 = sim.fighters[0];
    const p1 = buildP1Input(src, renderer, { x: f1.x, y: f1.y, h: f1.stats.height });
    const [, k2] = src.keyboard.sample();
    const pad2 = src.gamepads.sample(1);
    let aim2X = pad2.aimX, aim2Y = pad2.aimY;
    if (aim2X === 0 && aim2Y === 0) [aim2X, aim2Y] = src.keyboard.p2AimRaw();
    return [p1, { buttons: k2 | pad2.buttons, aimX: aim2X, aimY: aim2Y }];
  }

  let accumulator = 0;
  const prevPos = sim.fighters.map((f) => ({ x: f.x, y: f.y }));

  app.ticker.add((ticker) => {
    const frameDt = Math.min(ticker.deltaMS / 1000, 0.1);
    accumulator += frameDt;
    while (accumulator >= DT) {
      for (let i = 0; i < sim.fighters.length; i++) {
        prevPos[i].x = sim.fighters[i].x;
        prevPos[i].y = sim.fighters[i].y;
      }
      renderer.handleEvents(sim.step(buildInputs()));
      accumulator -= DT;
    }
    const alpha = accumulator / DT;

    const items: DrawFighter[] = sim.fighters.map((f, i) => ({
      f,
      rx: prevPos[i].x + (f.x - prevPos[i].x) * alpha,
      ry: prevPos[i].y + (f.y - prevPos[i].y) * alpha,
    }));
    const ownerChar = (id: number): CharId => sim.fighters[id]?.charId ?? "knight";
    const world: DrawWorld = {
      fighters: items,
      projs: sim.projectiles.map((p) => projDraw(p, ownerChar)),
      constructs: sim.constructs.map((c): DrawConstruct => ({
        x: c.x, y: c.y, kindId: c.def.kindId, facing: c.facing,
        hpT: Math.max(0, c.hp / c.def.hp), owner: c.owner,
      })),
      zones: sim.zones.map((z): DrawZone => ({ x: z.x, y: z.y, radius: z.radius, owner: z.owner })),
      items: sim.items,
      tick: sim.tick,
    };

    const alive = sim.fighters.filter((f) => f.stocks > 0);
    renderer.setBanner(alive.length === 1 ? `P${alive[0].id + 1} WINS` : "", alive.length === 1 ? "R to rematch" : "");

    renderer.draw(world, frameDt, p1Reticle(src, renderer, crosshairVisible), sim.hitstop > 0);
  });
}

// ---------------------------------------------------------------------------
// online
// ---------------------------------------------------------------------------

function onlineMode(app: Application, params: URLSearchParams): void {
  const serverParam = params.get("server");
  // default: production is same-origin behind a reverse proxy (wss://host/ws);
  // dev is the bare ws server on :8080
  const url = serverParam && serverParam.length > 0
    ? serverParam
    : location.protocol === "https:"
      ? `wss://${location.host}/ws`
      : `ws://${location.port === "5173" ? `${location.hostname}:8080` : location.host}/ws`;
  // a secure page never talks to an unencrypted socket (localhost dev excepted)
  if (location.protocol === "https:" && url.startsWith("ws://")) {
    const lobbyErr = new LobbyScreen(app);
    lobbyErr.visible = true;
    lobbyErr.status("INSECURE SERVER URL", "use wss:// from an https page");
    return;
  }
  const wantedChar = (params.get("char") ?? "knight") as CharId;
  const charId: CharId = wantedChar in CHARACTERS ? wantedChar : "knight";
  const name = params.get("name") ?? "player";
  const roomCode = params.get("room");

  const src: P1Sources = { keyboard: new Keyboard(), mouse: new Mouse(app.canvas), gamepads: new Gamepads() };
  const lobby = new LobbyScreen(app);
  lobby.visible = true;
  lobby.status("CONNECTING…", url);

  // renderer + stage exist only after the server tells us the stage id
  let renderer: GameRenderer | null = null;
  let stageObj: Stage | null = null;
  let crosshairVisible = true;
  let players: PlayerInfo[] = [];
  let myReady = false;
  let myId = -1;
  let myRoom = "";
  let predictor: Predictor | null = null;
  const interp = new Interpolator();
  let displayFighters: Fighter[] = [];
  let renderTick = -1;
  let outbox: TickInput[] = [];
  let sinceSend = 0;
  let smoothX = 0, smoothY = 0;
  let gameOverText = "";

  const net = new NetClient(url);

  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyC") crosshairVisible = !crosshairVisible;
    if (e.code === "KeyH" && renderer) renderer.showHitboxes = !renderer.showHitboxes;
    if (!lobby.visible) return;
    const digit = e.code.match(/^Digit([1-9])$/);
    if (digit) {
      net.send({ t: "setChar", charId: CHAR_IDS[Number(digit[1]) - 1] });
      myReady = false;
    }
    if (e.code === "Space" || e.code === "Enter") {
      myReady = !myReady;
      net.send({ t: "ready", ready: myReady });
    }
  });

  net.onOpen = () => {
    const token = sessionStorage.getItem(`ef_token_${roomCode ?? ""}`);
    net.send({ t: "join", name, room: roomCode, charId, token, stage: params.get("stage") });
  };
  net.onClose = () => {
    if (renderer) renderer.setBanner("DISCONNECTED", "refresh to reconnect");
    else lobby.status("DISCONNECTED", "refresh to retry");
  };

  net.onMessage = (m) => {
    switch (m.t) {
      case "welcome": {
        myId = m.playerId;
        myRoom = m.roomCode;
        players = m.players;
        sessionStorage.setItem(`ef_token_${myRoom}`, m.token);
        const picked = stageById(m.stageId);
        stageObj = picked.make();
        if (!renderer) {
          renderer = new GameRenderer(app, stageObj);
          const theme = STAGE_INFO[picked.id].theme;
          renderer.platformPalette = PLATFORM_PALETTES[theme];
          renderer.scene = makeScene(theme, stageObj, { under: renderer.sceneUnder, over: renderer.sceneOver });
          renderer.setHelp("ONLINE  ·  WASD move · mouse aim · LMB light · RMB heavy · F special · Q ultimate · Shift dash · H hitboxes · C crosshair");
          app.stage.addChild(lobby.root); // keep the lobby overlay on top
        }
        lobby.visible = true;
        lobby.update(myRoom, players, myId);
        break;
      }
      case "lobby":
        players = m.players;
        myReady = players.find((p) => p.id === myId)?.ready ?? false;
        lobby.update(myRoom, players, myId);
        break;
      case "begin": {
        if (!stageObj) break;
        const roster = m.players.map((p: PlayerInfo) => ({ charId: p.charId, team: p.team }));
        predictor = new Predictor(stageObj, roster, myId, m.tick, 6);
        displayFighters = m.players.map((p: PlayerInfo, i: number) =>
          makeFighter(i, stageObj!.spawns[i % stageObj!.spawns.length], CHARACTERS[p.charId], p.team));
        renderTick = m.tick;
        smoothX = 0; smoothY = 0;
        outbox = [];
        gameOverText = "";
        lobby.visible = false;
        renderer?.setBanner("");
        break;
      }
      case "snapshot": {
        if (!predictor) break;
        const meBefore = predictor.sim.fighters[myId];
        const bx = meBefore.x, by = meBefore.y;
        predictor.applySnapshot(m.snap, m.lastInput);
        const meAfter = predictor.sim.fighters[myId];
        smoothX += bx - meAfter.x;
        smoothY += by - meAfter.y;
        if (Math.hypot(smoothX, smoothY) > 220) { smoothX = 0; smoothY = 0; } // too big to smooth: snap
        interp.push(m.snap);
        renderer?.handleEvents(m.events.filter((e: SimEvent) => !ownMovementEvent(e, myId)));
        break;
      }
      case "gameOver":
        gameOverText = m.winners.includes(myId) ? "VICTORY" : m.winners.length ? "DEFEAT" : "DRAW";
        renderer?.setBanner(gameOverText, "refresh to play again");
        break;
      case "peerLeft":
        renderer?.setBanner("PLAYER DISCONNECTED", "waiting for them to return…");
        break;
      case "peerBack":
        renderer?.setBanner(gameOverText, gameOverText ? "refresh to play again" : "");
        break;
      case "error":
        if (renderer) renderer.setBanner("ERROR", m.message);
        else lobby.status("ERROR", m.message);
        break;
      default:
        break;
    }
  };

  let accumulator = 0;
  let prevX = 0, prevY = 0;

  app.ticker.add((ticker) => {
    const frameDt = Math.min(ticker.deltaMS / 1000, 0.1);
    if (!predictor || !renderer) return;
    const me = predictor.sim.fighters[myId];

    accumulator += frameDt;
    while (accumulator >= DT) {
      prevX = me.x; prevY = me.y;
      const input = buildP1Input(src, renderer, { x: me.x + smoothX, y: me.y + smoothY, h: me.stats.height });
      const { events, toSend } = predictor.step(input);
      outbox.push(toSend);
      if (outbox.length > 6) outbox = outbox.slice(-6);
      if (++sinceSend >= INPUT_BATCH) {
        net.send({ t: "input", inputs: outbox.slice(-3) }); // 1 new + 2 redundant vs loss
        sinceSend = 0;
      }
      renderer.handleEvents(events.filter((e) => ownMovementEvent(e, myId)));
      accumulator -= DT;
    }
    const alpha = accumulator / DT;

    const decay = Math.exp(-12 * frameDt);
    smoothX *= decay; smoothY *= decay;

    const targetTick = interp.latestTick() - INTERP_DELAY_TICKS;
    if (renderTick < 0) renderTick = targetTick;
    renderTick += frameDt * 60;
    renderTick += (targetTick - renderTick) * Math.min(1, frameDt * 2);

    const sample = interp.sample(renderTick);
    const items: DrawFighter[] = [];
    const projs: DrawProj[] = [];
    const ownerChar = (id: number): CharId => predictor!.sim.fighters[id]?.charId ?? "knight";
    for (let i = 0; i < predictor.sim.fighters.length; i++) {
      if (i === myId) {
        items.push({
          f: me,
          rx: prevX + (me.x - prevX) * alpha + smoothX,
          ry: prevY + (me.y - prevY) * alpha + smoothY,
        });
      } else {
        const df = displayFighters[i];
        const snap = sample?.fighters.find((f) => f.id === i);
        if (snap) applyFighterSnap(df, snap); // full state: hitbox overlay works on remotes too
        items.push({ f: df, rx: df.x, ry: df.y });
      }
    }
    for (const p of predictor.sim.projectiles) {
      if (p.owner === myId) projs.push(projDraw(p, ownerChar));
    }
    for (const p of sample?.projectiles ?? []) {
      if (p.owner !== myId) projs.push(projDraw(p, ownerChar));
    }
    const constructsSrc = sample?.constructs ?? predictor.sim.constructs;
    const zonesSrc = sample?.zones ?? predictor.sim.zones;
    const worldItems: DrawItem[] = sample?.items ?? predictor.sim.items;
    const world: DrawWorld = {
      fighters: items,
      projs,
      constructs: constructsSrc.map((c): DrawConstruct => ({
        x: c.x, y: c.y, kindId: c.def.kindId, facing: c.facing,
        hpT: Math.max(0, c.hp / c.def.hp), owner: c.owner,
      })),
      zones: zonesSrc.map((z): DrawZone => ({ x: z.x, y: z.y, radius: z.radius, owner: z.owner })),
      items: worldItems,
      tick: Math.max(0, Math.round(renderTick)),
    };

    renderer.draw(world, frameDt, p1Reticle(src, renderer, crosshairVisible), predictor.sim.hitstop > 0);
  });
}

/** Movement/action events for the local player — predicted, played instantly. */
function ownMovementEvent(e: SimEvent, myId: number): boolean {
  switch (e.t) {
    case "jump":
    case "dash":
    case "land":
    case "shoot":
      return e.id === myId;
    default:
      return false; // hits/KOs/respawns/items wait for the server's word
  }
}

// This module bootstraps a Pixi Application + ticker. A hot-patch would re-run
// main() and stack a second app/canvas over the first (leaked ticker, ghost
// fade overlays). Force a full reload on any edit to this entry module instead.
(import.meta as { hot?: { decline(): void } }).hot?.decline();

main();
