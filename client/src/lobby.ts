/**
 * Lobby screen: room code, player list with characters and ready states,
 * character select (1-6), ready toggle (Space). Pure Pixi, no DOM.
 */
import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { CHARACTERS, CHAR_IDS, type PlayerInfo } from "@emberfall/shared";
import { COLORS } from "./render.js";

const mono = (size: number, fill: number, weight: "normal" | "bold" | "900" = "bold"): TextStyle =>
  new TextStyle({ fontFamily: "monospace", fontSize: size, fontWeight: weight, fill });

export class LobbyScreen {
  readonly root = new Container();
  private title: Text;
  private code: Text;
  private hint: Text;
  private rows: Text[] = [];
  private rosterText: Text;

  constructor(private app: Application) {
    const dim = new Graphics();
    dim.rect(0, 0, 4000, 3000).fill({ color: 0x0d0a14, alpha: 0.88 });
    this.root.addChild(dim);

    this.title = new Text({ text: "EMBERFALL 2: THE ARENA", style: mono(30, 0xffd75a, "900") });
    this.code = new Text({ text: "", style: mono(56, 0xffffff, "900") });
    this.hint = new Text({
      text: "1-6 choose character  ·  SPACE ready  ·  match starts when everyone is ready",
      style: mono(15, 0x9a8ec0),
    });
    this.rosterText = new Text({
      text: CHAR_IDS.map((id, i) => `${i + 1} ${CHARACTERS[id].name}`).join("   "),
      style: mono(15, 0x6a5a9a),
    });
    for (const t of [this.title, this.code, this.hint, this.rosterText]) {
      t.anchor.set(0.5, 0);
      this.root.addChild(t);
    }
    app.stage.addChild(this.root);
    this.root.visible = false;
  }

  set visible(v: boolean) {
    this.root.visible = v;
  }

  /** Pre-lobby status ("CONNECTING…", errors) using the same layout. */
  status(main: string, sub = ""): void {
    const cx = this.app.screen.width / 2;
    let y = this.app.screen.height * 0.16;
    this.title.position.set(cx, y); y += 54;
    this.code.text = main;
    this.code.position.set(cx, y); y += 86;
    this.hint.text = sub;
    this.hint.position.set(cx, y);
    this.rosterText.text = "";
    for (const r of this.rows) r.text = "";
  }

  get visible(): boolean {
    return this.root.visible;
  }

  update(roomCode: string, players: PlayerInfo[], myId: number): void {
    const cx = this.app.screen.width / 2;
    let y = this.app.screen.height * 0.16;
    this.title.position.set(cx, y); y += 54;
    this.code.text = `ROOM ${roomCode}`;
    this.code.position.set(cx, y); y += 86;
    this.hint.position.set(cx, y); y += 30;
    this.rosterText.position.set(cx, y); y += 60;

    while (this.rows.length < players.length) {
      const t = new Text({ text: "", style: mono(24, 0xffffff) });
      t.anchor.set(0.5, 0);
      this.root.addChild(t);
      this.rows.push(t);
    }
    this.rows.forEach((row, i) => {
      const p = players[i];
      if (!p) { row.text = ""; return; }
      const you = p.id === myId ? "▶ " : "  ";
      const status = !p.connected ? "· gone" : p.ready ? "· READY" : "· picking…";
      row.text = `${you}P${p.id + 1} ${p.name}  —  ${CHARACTERS[p.charId].name}  ${status}`;
      row.style.fill = COLORS[p.id % COLORS.length];
      row.alpha = p.connected ? 1 : 0.4;
      row.position.set(cx, y);
      y += 40;
    });
    if (players.length < 2) {
      // solo: show the share hint on the first empty row slot
      if (this.rows.length < 2) {
        const t = new Text({ text: "", style: mono(18, 0x9a8ec0) });
        t.anchor.set(0.5, 0);
        this.root.addChild(t);
        this.rows.push(t);
      }
      this.rows[1].text = `waiting… share this URL:  ?room=${roomCode}`;
      this.rows[1].style.fill = 0x9a8ec0;
      this.rows[1].alpha = 1;
      this.rows[1].position.set(cx, y);
    }
  }
}
