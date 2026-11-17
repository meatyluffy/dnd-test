// Побег из Велкинвильва — pixel JRPG. Exploration + turn-based battles, host-authoritative co-op.
(function () {
  const D = window.DATA;
  const W = 640, H = 360;
  const params = new URLSearchParams(location.search);
  const COLORS = [0xffd36b, 0x6bdcff, 0xff7ad9, 0x8dff8a];
  const FONT = '"Cyrillic Pixel-7", monospace';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fz = (n) => Math.max(10, Math.round(n * 1.2));
  const T = (sc, x, y, s, size = 12, color = '#f1e6cf', o = {}) => sc.add.text(x, y, s, Object.assign({ fontFamily: FONT, fontSize: fz(size), color, resolution: 3, stroke: '#0a0610', strokeThickness: o.stroke !== undefined ? o.stroke : 3, wordWrap: o.wrap ? { width: o.wrap } : undefined, lineSpacing: 2 }, o.style || {}));

  // ------------------------------------------------------------ shared state
  const S = window.S = {
    net: null, isHost: false, myPid: null, started: false, me: { name: 'Игрок', char: 'lukaris' },
    roster: [], peerToPid: new Map(), nextPid: 1,
    world: null,                // host: authoritative; client: mirror
    battle: null,               // host: Battle engine
    bview: null,                // battle view model (both)
    scheme: (() => { try { return localStorage.getItem('velk_scheme') || 'wasd'; } catch (e) { return 'wasd'; } })(),
  };

  function newWorld() {
    return { area: 'cell', mode: 'explore', players: new Map(), opened: {}, defeated: {}, inv: { potion: 1, ether: 0 }, party: {}, seen: {}, t: 0 };
  }

  function partyList() {
    // one hero per player; a lone player leads both heroes
    const ps = [...S.world.players.values()];
    const list = ps.map(p => ({ uid: 'h' + p.id, owner: p.id, char: p.char, name: D.HEROES[p.char].name }));
    if (ps.length === 1) {
      const other = ps[0].char === 'lukaris' ? 'soreen' : 'lukaris';
      list.push({ uid: 'h' + ps[0].id + 'b', owner: ps[0].id, char: other, name: D.HEROES[other].name, companion: true });
    }
    for (const h of list) if (!S.world.party[h.uid]) S.world.party[h.uid] = { hp: D.HEROES[h.char].stats.hp, sp: D.HEROES[h.char].stats.sp };
    return list;
  }

  function addPlayer(id, name, char) {
    const used = new Set([...S.world.players.values()].map(p => p.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[0];
    const A = D.AREAS[S.world.area];
    const i = S.world.players.size;
    const st = A.start[i % A.start.length];
    const p = { id, name, char, color, x: st[0], y: st[1], face: 1, anim: 'idle' };
    S.world.players.set(id, p);
    return p;
  }
  const roster = () => [...S.world.players.values()].map(p => ({ id: p.id, name: p.name, char: p.char, color: p.color }));

  // ------------------------------------------------------------ lobby API
  window.GAME = {
    hostGame(me, cb) {
      S.me = me; S.isHost = true; S.world = newWorld(); S.myPid = 0;
      addPlayer(0, me.name, me.char);
      S.roster = roster(); LOBBY.roster(S.roster);
      const net = S.net = new Net();
      let done = false;
      net.onMessage = (peer, m) => hostMsg(peer, m);
      net.onLeave = (peer) => {
        const pid = S.peerToPid.get(peer); if (pid === undefined) return;
        S.peerToPid.delete(peer); S.world.players.delete(pid);
        S.roster = roster(); LOBBY.roster(S.roster); net.broadcast({ t: 'roster', list: S.roster });
        if (S.battle) hostBattleOwnerLeft(pid);
      };
      net.onError = (e) => { console.warn('net', e && e.type); if (!done) { done = true; cb(e && e.type || 'network'); } };
      net.host((err, code) => { if (!done) { done = true; cb(err, code); } });
    },
    startAsHost() {
      if (S.started) return;
      S.started = true;
      if (params.get('area')) { S.world.area = params.get('area'); placeAtStart(); }
      S.net && S.net.broadcast({ t: 'start' });
      boot();
    },
    joinGame(code, me, cb) {
      S.me = me; S.isHost = false; S.world = newWorld();
      const net = S.net = new Net();
      net.onMessage = (_, m) => clientMsg(m);
      net.onLeave = () => { if (S.ui) S.ui.toast('Связь с хостом потеряна'); LOBBY.status('Связь с хостом потеряна'); };
      net.onError = (e) => console.warn('net', e && e.type);
      net.join(code, (err) => { if (err) return cb(err); net.toHost({ t: 'hello', name: me.name, char: me.char }); cb(null); });
    },
  };

  function placeAtStart() {
    const A = D.AREAS[S.world.area]; let i = 0;
    for (const p of S.world.players.values()) { const st = A.start[i++ % A.start.length]; p.x = st[0]; p.y = st[1]; }
  }

  // ------------------------------------------------------------ host networking
  function hostMsg(peer, m) {
    if (m.t === 'hello') {
      if (S.peerToPid.has(peer)) return;
      if (S.world.players.size >= 4) { S.net.send(peer, { t: 'full' }); return; }
      const pid = S.nextPid++;
      S.peerToPid.set(peer, pid);
      const p = addPlayer(pid, String(m.name || 'Игрок').slice(0, 14), D.HEROES[m.char] ? m.char : 'lukaris');
      S.roster = roster(); LOBBY.roster(S.roster);
      S.net.send(peer, { t: 'welcome', pid });
      S.net.broadcast({ t: 'roster', list: S.roster });
      if (S.started) { S.net.send(peer, { t: 'start' }); sendWorld(true); if (S.ui) S.ui.toast(p.name + ' присоединяется!'); }
      return;
    }
    const pid = S.peerToPid.get(peer); if (pid === undefined) return;
    handleAction(pid, m);
  }

  // actions from any player (host's own go here directly)
  function handleAction(pid, m) {
    const w = S.world, p = w.players.get(pid);
    if (!p) return;
    if (m.t === 'st') { if (w.mode === 'explore') { p.x = m.x; p.y = m.y; p.face = m.f; p.anim = m.a; } }
    else if (m.t === 'interact') hostInteract(pid, m.id);
    else if (m.t === 'exit') hostExit();
    else if (m.t === 'cmd') hostCommand(pid, m.uid, m.cmd);
    else if (m.t === 'retry') hostRetry();
  }
  function send(m) { if (S.isHost) handleAction(S.myPid, m); else S.net.toHost(m); }

  function sendWorld(full) {
    const w = S.world;
    const msg = { t: 'ws', area: w.area, mode: w.mode, ps: [...w.players.values()].map(p => [p.id, Math.round(p.x), Math.round(p.y), p.face, p.anim]), opened: w.opened, defeated: w.defeated, inv: w.inv, party: w.party, roster: S.roster };
    if (S.net) S.net.broadcast(msg);
  }
  function broadcastAll(m) { if (S.net) S.net.broadcast(m); clientMsg(m, true); }

  // ------------------------------------------------------------ host: world logic
  function hostInteract(pid, id) {
    const w = S.world, A = D.AREAS[w.area];
    if (w.mode !== 'explore') return;
    const ch = A.chests.find(c => c.id === id);
    if (ch && !w.opened[id]) {
      w.opened[id] = true;
      const got = [];
      for (const k in ch.items) { w.inv[k] = (w.inv[k] || 0) + ch.items[k]; got.push(D.ITEMS[k].name + ' ×' + ch.items[k]); }
      broadcastAll({ t: 'dialog', lines: [['', 'Сундук открыт! Найдено: ' + got.join(', ') + '.']] });
      sendWorld();
      return;
    }
    const n = A.notes.find(x => x.id === id);
    if (n) { const pp = S.world.players.get(pid); broadcastAll({ t: 'dialog', lines: n.text, only: pid }); }
  }

  function hostExit() {
    const w = S.world, A = D.AREAS[w.area];
    if (w.mode !== 'explore' || !A.next) return;
    w.area = A.next; placeAtStart();
    if (D.AREAS[w.area].restore) for (const h of partyList()) w.party[h.uid] = { hp: D.HEROES[h.char].stats.hp, sp: D.HEROES[h.char].stats.sp };
    broadcastAll({ t: 'area', area: w.area, ps: [...w.players.values()].map(p => [p.id, p.x, p.y]) });
    sendWorld();
    if (!w.seen[w.area]) { w.seen[w.area] = 1; setTimeout(() => broadcastAll({ t: 'dialog', lines: D.AREAS[w.area].intro }), 900); }
  }

  function foePos(f, t) { return { x: f.x + Math.sin(t * 0.8 + f.x) * (f.patrol || 0), y: f.y }; }

  function hostTick(dt) {
    const w = S.world;
    w.t += dt;
    if (w.mode !== 'explore' || S.dialogOpenHost) return;
    const A = D.AREAS[w.area];
    for (const f of A.foes) {
      if (w.defeated[f.id]) continue;
      const fp = foePos(f, w.t);
      for (const p of w.players.values()) {
        if (Math.abs(p.x - fp.x) < 24 && Math.abs(p.y - fp.y) < 16) { hostStartEncounter(f); return; }
      }
    }
  }

  function hostStartEncounter(f) {
    const w = S.world;
    w.mode = 'pre';
    if (f.talk) {
      broadcastAll({ t: 'dialog', lines: f.talk });
      S.afterDialog = () => hostBattle(f);
    } else hostBattle(f);
  }

  function hostBattle(f) {
    const w = S.world;
    w.mode = 'battle';
    const party = partyList().map(h => Object.assign({}, h, { hp: Math.max(1, w.party[h.uid].hp), sp: w.party[h.uid].sp }));
    S.battle = new Battle(party, f.group, w.inv, { boss: !!f.boss });
    S.battle.foeRef = f;
    S.battle.start();
    broadcastAll({ t: 'battle', snap: S.battle.snapshot(), area: w.area, boss: !!f.boss });
    flushBattle();
  }

  function evDur(e) {
    switch (e.type) {
      case 'msg': return 0.9; case 'round': return 0.55; case 'turn': return 0.25;
      case 'action': return 0.85 + 0.24 * (e.hits ? e.hits.length : 0) + (e.counter ? 0.7 : 0) + (e.hits && e.hits.some(h => h.broke) ? 0.5 : 0);
      case 'tick': return 0.55; case 'ko': return 0.45; case 'recover': return 0.45; case 'summon': return 1.0; case 'skip': return 0.8;
      default: return 0;
    }
  }

  function flushBattle() {
    const b = S.battle; if (!b) return;
    const evs = b.events.splice(0);
    const snap = b.snapshot();
    broadcastAll({ t: 'bev', ev: evs, snap });
    const dur = evs.reduce((s, e) => s + evDur(e), 0);
    if (b.phase === 'win' || b.phase === 'lose') { setTimeout(() => hostBattleEnd(b.phase), dur * 1000 + 600); return; }
    if (b.pendingNext) setTimeout(() => { if (S.battle === b) { b.continue(); flushBattle(); } }, dur * 1000 + 150);
  }

  function hostCommand(pid, uid, cmd) {
    const b = S.battle; if (!b) return;
    const u = b.unit(uid);
    if (!u || u.owner !== pid) return;
    if (b.heroCommand(uid, cmd)) flushBattle();
  }
  function hostBattleOwnerLeft(pid) {
    const b = S.battle; if (!b) return;
    for (const u of b.heroes) if (u.owner === pid) u.owner = S.myPid; // host takes over a disconnected player's hero
    flushBattle();
  }

  function hostBattleEnd(result) {
    const w = S.world, b = S.battle;
    if (!b) return;
    if (result === 'win') {
      w.defeated[b.foeRef.id] = true;
      for (const u of b.heroes) w.party[u.uid] = { hp: Math.max(1, u.hp), sp: u.sp };
      w.inv = b.inv;
      S.battle = null;
      w.mode = 'explore';
      broadcastAll({ t: 'bend', result });
      sendWorld();
      const A = D.AREAS[w.area];
      if (b.foeRef.boss && A.outro) { w.mode = 'pre'; setTimeout(() => { broadcastAll({ t: 'dialog', lines: A.outro }); S.afterDialog = () => { w.mode = 'end'; broadcastAll({ t: 'end' }); }; }, 1200); }
    } else {
      S.battle = null;
      broadcastAll({ t: 'bend', result });
    }
  }
  function hostRetry() {
    const w = S.world;
    if (w.mode !== 'battle' || S.battle) return;
    for (const h of partyList()) w.party[h.uid] = { hp: D.HEROES[h.char].stats.hp, sp: D.HEROES[h.char].stats.sp };
    w.mode = 'explore'; placeAtStart();
    broadcastAll({ t: 'area', area: w.area, ps: [...w.players.values()].map(p => [p.id, p.x, p.y]) });
    broadcastAll({ t: 'dialog', lines: [['Рассказчик', 'Вы приходите в себя у входа. Силы вернулись — попробуйте снова.']] });
    sendWorld();
  }

  // ------------------------------------------------------------ client side (also runs on host for its own view)
  function clientMsg(m, local) {
    switch (m.t) {
      case 'welcome': S.myPid = m.pid; break;
      case 'roster': S.roster = m.list; LOBBY.roster(m.list); break;
      case 'full': LOBBY.status('Комната заполнена (максимум 4 игрока)'); break;
      case 'start': if (!S.started) { S.started = true; boot(); } break;
      case 'ws': if (!S.isHost) applyWorld(m); break;
      case 'area': if (!S.isHost) { S.world.area = m.area; for (const [id, x, y] of m.ps) { const p = S.world.players.get(id); if (p) { p.x = x; p.y = y; } } }
        if (S.explore) S.explore.enterArea(m.area, m.ps); break;
      case 'dialog': if (S.ui && (!m.only || m.only === S.myPid || true)) S.ui.dialog(m.lines); break;
      case 'battle': if (S.explore) S.explore.toBattle(m); break;
      case 'bev': if (S.battleScene) S.battleScene.pushEvents(m.ev, m.snap); else S.pendingBev = (S.pendingBev || []).concat([m]); break;
      case 'bend': if (S.battleScene) S.battleScene.finish(m.result); break;
      case 'end': if (S.ui) S.ui.ending(); break;
    }
  }

  function applyWorld(m) {
    const w = S.world;
    if (m.roster) S.roster = m.roster;
    if (w.area !== m.area && S.explore) S.explore.enterArea(m.area);
    w.area = m.area; w.mode = m.mode; w.opened = m.opened; w.defeated = m.defeated; w.inv = m.inv; w.party = m.party;
    const seen = new Set();
    for (const [id, x, y, face, anim] of m.ps) {
      seen.add(id);
      let p = w.players.get(id);
      const r = S.roster.find(r => r.id === id) || { name: '?', char: 'lukaris', color: 0xffffff };
      if (!p) { p = { id, x, y, face, anim, name: r.name, char: r.char, color: r.color }; w.players.set(id, p); }
      Object.assign(p, { name: r.name, char: r.char, color: r.color });
      if (id !== S.myPid) { p.tx = x; p.ty = y; p.face = face; p.anim = anim; }
    }
    for (const id of [...w.players.keys()]) if (!seen.has(id)) w.players.delete(id);
  }

  // ------------------------------------------------------------ input
  const BIND = {
    wasd: { up: ['W', 'UP'], down: ['S', 'DOWN'], left: ['A', 'LEFT'], right: ['D', 'RIGHT'], ok: ['ENTER', 'SPACE', 'J', 'Z'], back: ['ESC', 'BACKSPACE', 'K', 'X'], bup: ['E'], bdown: ['Q'] },
  };
  class Input {
    constructor(sc) {
      this.sc = sc;
      this.keys = sc.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,ENTER,SPACE,J,Z,ESC,BACKSPACE,K,X,E,Q');
      sc.input.keyboard.addCapture('SPACE,UP,DOWN,LEFT,RIGHT');
      this.prevPad = {};
      this.repeat = {};
    }
    down(act) { return BIND.wasd[act].some(k => this.keys[k] && this.keys[k].isDown) || this.padDown(act); }
    pressed(act) {
      let p = BIND.wasd[act].some(k => this.keys[k] && Phaser.Input.Keyboard.JustDown(this.keys[k]));
      return p || this.padPressed(act);
    }
    pad() { const g = this.sc.input.gamepad; return g && g.total ? g.getPad(0) : null; }
    padDown(act) {
      const p = this.pad(); if (!p) return false;
      const ax = p.axes.length ? p.axes[0].getValue() : 0, ay = p.axes.length > 1 ? p.axes[1].getValue() : 0;
      switch (act) {
        case 'left': return p.left || ax < -0.4; case 'right': return p.right || ax > 0.4;
        case 'up': return p.up || ay < -0.4; case 'down': return p.down || ay > 0.4;
        case 'ok': return p.A; case 'back': return p.B; case 'bup': return p.R1 > 0.5 || (p.buttons[5] && p.buttons[5].pressed); case 'bdown': return p.L1 > 0.5 || (p.buttons[4] && p.buttons[4].pressed);
      }
      return false;
    }
    padPressed(act) {
      const v = this.padDown(act), was = this.prevPad[act];
      this.prevPad[act] = v;
      return v && !was;
    }
    // menu navigation with auto-repeat
    nav(act, dt) {
      const d = this.down(act);
      if (!d) { this.repeat[act] = 0; return false; }
      if (!this.repeat[act]) { this.repeat[act] = 0.32; return true; }
      this.repeat[act] -= dt;
      if (this.repeat[act] <= 0) { this.repeat[act] = 0.1; return true; }
      return false;
    }
    axis() { return { x: (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0), y: (this.down('down') ? 1 : 0) - (this.down('up') ? 1 : 0) }; }
  }

  // ------------------------------------------------------------ boot
  function boot() {
    if (document.fonts && !boot.waited) { boot.waited = true; document.fonts.load('12px "Cyrillic Pixel-7"', 'АБВ abc').finally(boot); return; }
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    new Phaser.Game({
      type: Phaser.WEBGL, parent: 'game', width: W, height: H, pixelArt: true, roundPixels: true, backgroundColor: '#05030a',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      input: { gamepad: true },
      render: { preserveDrawingBuffer: params.has('test') },
      scene: [Boot, Explore, BattleScene, UIScene],
    });
  }

  function heroKey(char) { return 'spr_' + char; }

  class Boot extends Phaser.Scene {
    constructor() { super('boot'); }
    preload() {
      const t = this.add.text(W / 2, H / 2, 'Спуск в Подземье…', { fontFamily: FONT, fontSize: 16, color: '#e8c27a', resolution: 3 }).setOrigin(0.5);
      this.load.on('progress', v => t.setText('Спуск в Подземье… ' + Math.round(v * 100) + '%'));
      window.loadAssets(this);
    }
    create() {
      // slice sprite strips into frames
      for (const k of ['lukaris', 'soreen', 'drow', 'xbow', 'quaggoth', 'spider', 'ilvara']) {
        const meta = window.SPRITE_META[k];
        const tex = this.textures.get('spr_' + k);
        for (let i = 0; i < meta.n; i++) tex.add(i, 0, i * meta.fw, 0, meta.fw, meta.fh);
        // head crop for the turn order bar
        tex.add('head', 0, Math.round(meta.fw * 0.25), Math.round(meta.fh * 0.02), Math.round(meta.fw * 0.5), Math.round(meta.fw * 0.5));
      }
      const g = this.make.graphics({ add: false });
      for (let r = 8; r > 0; r--) { g.fillStyle(0xffffff, (1 - r / 8) * 0.3); g.fillCircle(8, 8, r); }
      g.generateTexture('glow', 16, 16); g.clear();
      g.fillStyle(0xffffff, 1); g.fillRect(0, 0, 2, 2); g.generateTexture('px2', 2, 2); g.clear();
      g.fillStyle(0x000000, 0.45); g.fillEllipse(12, 4, 24, 8); g.generateTexture('shadow', 24, 8); g.destroy();
      this.scene.start('explore');
      this.scene.launch('ui');
    }
  }

  // ------------------------------------------------------------ HD-2D look helpers
  function hd2d(cam, strong) {
    if (!cam.postFX || params.has('nofx')) return;
    cam.postFX.addTiltShift(strong ? 0.35 : 0.25, 1.2, 0, 0.5, 0.5, 1.0);
    cam.postFX.addBloom(0xffffff, 1, 1, 0.8, 1.05);
    cam.postFX.addVignette(0.5, 0.52, 0.86, 0.38);
  }
  function addLights(sc, lights, depth = 50) {
    const objs = [];
    for (const [x, y, c, s] of lights) {
      const g = sc.add.image(x, y, 'glow').setTint(c).setScale(s * 2.4).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.55).setDepth(depth);
      sc.tweens.add({ targets: g, alpha: { from: 0.4, to: 0.7 }, scale: s * 2.6, yoyo: true, repeat: -1, duration: 700 + Math.random() * 900, ease: 'Sine.inOut' });
      objs.push(g);
    }
    // floating spores / dust
    const em = sc.add.particles(0, 0, 'px2', { x: { min: 0, max: W }, y: { min: 40, max: H }, lifespan: 6000, speedX: { min: -6, max: 6 }, speedY: { min: -10, max: -3 },
      alpha: { start: 0, end: 0.9, ease: 'Sine.inOut' }, tint: [0xd8b0ff, 0x9fe8ff, 0xffd8a0], frequency: 120, scale: { min: 0.5, max: 1 } }).setDepth(depth + 500).setBlendMode(Phaser.BlendModes.ADD);
    em.setParticleAlpha({ start: 0.9, end: 0 });
    objs.push(em);
    return objs;
  }

  function animFrames(char, anim, t) {
    const F = D.HERO_FR;
    if (anim === 'walk') return F.walk[Math.floor(t * 8) % 4];
    if (anim === 'ko') return F.ko;
    return F.idle[Math.floor(t * 2) % 2];
  }

  // ------------------------------------------------------------ Exploration scene
  class Explore extends Phaser.Scene {
    constructor() { super('explore'); }
    create() {
      S.explore = this;
      this.inp = new Input(this);
      this.vis = new Map();
      this.foeVis = [];
      this.objVis = [];
      hd2d(this.cameras.main);
      this.local = null;
      this.enterArea(S.world.area);
      this.sendT = 0;
      if (S.isHost) {
        const w = S.world;
        if (!w.seen[w.area]) { w.seen[w.area] = 1; setTimeout(() => broadcastAll({ t: 'dialog', lines: D.AREAS[w.area].intro }), 800); }
      }
      if (params.has('test')) window.TEST = this;
    }

    enterArea(area, ps) {
      const A = D.AREAS[area];
      S.world.area = area;
      if (this.layer) this.layer.forEach(o => o.destroy());
      this.layer = [];
      this.layer.push(this.add.image(0, 0, 'bg_' + A.bg).setOrigin(0).setDepth(0));
      this.layer.push(...addLights(this, A.lights));
      // fog band at the bottom
      const fog = this.add.particles(0, 0, 'glow', { x: { min: -20, max: W + 20 }, y: { min: H - 40, max: H }, lifespan: 7000, speedX: { min: -4, max: 4 }, scale: { min: 4, max: 7 }, tint: 0x6b5a9a, frequency: 300 }).setDepth(400);
      fog.setParticleAlpha({ start: 0.25, end: 0 });
      this.layer.push(fog);
      for (const o of this.objVis) o.destroy(); this.objVis = [];
      for (const o of this.foeVis) { o.spr.destroy(); o.sh.destroy(); o.mark && o.mark.destroy(); } this.foeVis = [];
      // chests & notes
      for (const c of A.chests) {
        const img = this.add.image(c.x, c.y, 'ic_chest').setOrigin(0.5, 1).setScale(2).setDepth(c.y);
        this.objVis.push(img);
        img.chest = c;
      }
      for (const n of A.notes) {
        const s = this.add.image(n.x, n.y - 14, 'glow').setTint(0xffe9a0).setScale(1.2).setBlendMode(Phaser.BlendModes.ADD).setDepth(n.y);
        this.tweens.add({ targets: s, alpha: { from: 0.4, to: 1 }, yoyo: true, repeat: -1, duration: 700 });
        this.objVis.push(s);
      }
      // patrolling foes (only the leader is shown on the map)
      for (const f of A.foes) {
        const kind = f.boss ? 'ilvara' : f.group[0];
        const spr = this.add.sprite(f.x, f.y, 'spr_' + kind, 0).setOrigin(0.5, 1).setDepth(f.y);
        const sh = this.add.image(f.x, f.y, 'shadow').setDepth(f.y - 1);
        const mark = this.add.text(f.x, f.y - spr.height - 4, f.boss ? '☠' : '!', { fontFamily: FONT, fontSize: 12, color: f.boss ? '#ff6a8a' : '#ffd36b', resolution: 3, stroke: '#000', strokeThickness: 3 }).setOrigin(0.5, 1).setDepth(900);
        this.foeVis.push({ f, spr, sh, mark, kind });
      }
      // exit arrow
      if (A.next) {
        const ar = T(this, W - 14, (A.band[0] + A.band[1]) / 2, '➜', 16, '#ffd36b').setOrigin(0.5).setDepth(900);
        this.tweens.add({ targets: ar, x: W - 8, yoyo: true, repeat: -1, duration: 500 });
        this.objVis.push(ar);
      }
      // reset local position
      const me = S.world.players.get(S.myPid);
      if (me) {
        if (ps) { const r = ps.find(a => a[0] === S.myPid); if (r) { me.x = r[1]; me.y = r[2]; } }
        else if (!me.x) { const st = A.start[0]; me.x = st[0]; me.y = st[1]; }
        this.local = { x: me.x, y: me.y, face: 1, anim: 'idle', t: 0 };
      }
      this.cameras.main.fadeIn(500, 0, 0, 0);
      if (S.ui) S.ui.areaTitle(A.name);
      this.trail = [];
    }

    toBattle(m) {
      S.pendingBev = [];
      this.cameras.main.flash(250, 255, 255, 255);
      this.cameras.main.shake(250, 0.01);
      this.time.delayedCall(300, () => {
        this.scene.pause();
        this.scene.setVisible(false);
        this.scene.launch('battle', m);
        this.scene.bringToTop('ui');
      });
    }
    backFromBattle() {
      this.scene.setVisible(true);
      this.scene.resume();
      this.cameras.main.fadeIn(400);
    }

    update(time, delta) {
      const now = performance.now(); const dt = Math.min(0.25, (now - (this.lastMs || now - 16)) / 1000); this.lastMs = now;
      const w = S.world, A = D.AREAS[w.area];
      const me = w.players.get(S.myPid);
      // local movement
      if (me && this.local) {
        const L = this.local;
        const busy = S.ui && S.ui.busy();
        let { x, y } = busy || w.mode !== 'explore' ? { x: 0, y: 0 } : this.inp.axis();
        if (S.testMove) { x = S.testMove.x; y = S.testMove.y; }
        const sp = 90;
        L.x = clamp(L.x + x * sp * dt, 12, W - 6); L.y = clamp(L.y + y * sp * 0.6 * dt, A.band[0], A.band[1]);
        if (x) L.face = x > 0 ? 1 : -1;
        L.anim = x || y ? 'walk' : 'idle';
        L.t += dt;
        Object.assign(me, { x: L.x, y: L.y, face: L.face, anim: L.anim });
        if (!busy && w.mode === 'explore' && (this.inp.pressed('ok') || S.testOk)) { S.testOk = false; this.tryInteract(); }
        if (w.mode === 'explore' && A.next && L.x > W - 10) { if (!this.exitReq) { this.exitReq = true; send({ t: 'exit' }); this.time.delayedCall(1500, () => this.exitReq = false); } }
        this.sendT += dt;
        if (!S.isHost && this.sendT > 1 / 15) { this.sendT = 0; S.net.toHost({ t: 'st', x: Math.round(L.x), y: Math.round(L.y), f: L.face, a: L.anim }); }
        this.trail.push([L.x, L.y, L.face, L.anim]); if (this.trail.length > 30) this.trail.shift();
      }
      if (S.isHost) {
        hostTick(dt);
        this.wsT = (this.wsT || 0) + dt;
        if (this.wsT > 1 / 12) { this.wsT = 0; sendWorld(); }
      } else {
        const k = Math.min(1, dt * 10);
        for (const p of w.players.values()) if (p.id !== S.myPid && p.tx !== undefined) { p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k; }
      }
      this.renderPlayers(dt, time / 1000);
      // foes
      for (const v of this.foeVis) {
        const dead = w.defeated[v.f.id];
        v.spr.setVisible(!dead); v.sh.setVisible(!dead); v.mark.setVisible(!dead);
        if (dead) continue;
        const p = foePos(v.f, w.t || time / 1000);
        const px = v.spr.x;
        v.spr.setPosition(p.x, p.y).setFrame(Math.floor(time / 500) % 2).setDepth(p.y);
        v.spr.setFlipX(p.x < px);
        v.sh.setPosition(p.x, p.y);
        v.mark.setPosition(p.x, p.y - v.spr.height - 2);
      }
      for (const o of this.objVis) if (o.chest) o.setTint(w.opened[o.chest.id] ? 0x707070 : 0xffffff);
      // interaction prompt
      const near = this.nearest();
      if (S.ui) S.ui.prompt(near && w.mode === 'explore' ? near : null, this.local);
    }

    nearest() {
      const A = D.AREAS[S.world.area], L = this.local; if (!L) return null;
      for (const c of A.chests) if (!S.world.opened[c.id] && Math.abs(c.x - L.x) < 26 && Math.abs(c.y - L.y) < 22) return { id: c.id, label: 'Открыть' };
      for (const n of A.notes) if (Math.abs(n.x - L.x) < 24 && Math.abs(n.y - L.y) < 22) return { id: n.id, label: 'Осмотреть' };
      return null;
    }
    tryInteract() { const n = this.nearest(); if (n) send({ t: 'interact', id: n.id }); }

    renderPlayers(dt, now) {
      const w = S.world;
      const seen = new Set();
      const party = [];
      for (const p of w.players.values()) party.push({ key: 'p' + p.id, char: p.char, x: p.x, y: p.y, face: p.face, anim: p.anim, color: p.color, name: p.name });
      // companion follows the lone player (Octopath-like follower)
      if (w.players.size === 1 && this.trail && this.trail.length > 18) {
        const p = [...w.players.values()][0];
        const tr = S.isHost || p.id === S.myPid ? this.trail[0] : [p.x - 24 * p.face, p.y, p.face, p.anim];
        const other = p.char === 'lukaris' ? 'soreen' : 'lukaris';
        party.push({ key: 'comp', char: other, x: tr[0], y: tr[1], face: tr[2], anim: tr[3], color: 0xaaaaaa });
      }
      for (const q of party) {
        seen.add(q.key);
        let v = this.vis.get(q.key);
        if (!v) {
          v = { spr: this.add.sprite(q.x, q.y, heroKey(q.char), 0).setOrigin(0.5, 1), sh: this.add.image(q.x, q.y, 'shadow'), t: Math.random() * 3 };
          if (q.name && w.players.size > 1) v.tag = T(this, q.x, q.y, q.name, 8, '#' + q.color.toString(16).padStart(6, '0')).setOrigin(0.5, 1).setDepth(950);
          this.vis.set(q.key, v);
        }
        v.t += dt;
        const fly = q.char === 'lukaris' ? 8 + Math.sin(now * 3) * 2 : 0;
        v.spr.setPosition(Math.round(q.x), Math.round(q.y - fly)).setFrame(animFrames(q.char, q.anim, v.t)).setFlipX(q.face > 0).setDepth(q.y);
        v.sh.setPosition(Math.round(q.x), Math.round(q.y)).setDepth(q.y - 1);
        if (v.tag) v.tag.setPosition(Math.round(q.x), Math.round(q.y - v.spr.height - fly - 1));
      }
      for (const [k, v] of [...this.vis]) if (!seen.has(k)) { v.spr.destroy(); v.sh.destroy(); v.tag && v.tag.destroy(); this.vis.delete(k); }
    }
  }

  // ------------------------------------------------------------ Battle scene
  const FOE_SLOTS = [[170, 250], [104, 208], [104, 296], [236, 206], [236, 300]];
  const HERO_SLOTS = [[472, 200], [516, 236], [470, 272], [552, 268]];

  class BattleScene extends Phaser.Scene {
    constructor() { super('battle'); }
    init(data) { this.init0 = data; }
    create() {
      S.battleScene = this;
      this.inp = new Input(this);
      const A = D.AREAS[this.init0.area];
      this.add.image(0, 0, 'bg_' + A.bg).setOrigin(0).setTint(0x8a80a0);
      this.add.rectangle(0, 0, W, H, 0x05020c, 0.25).setOrigin(0);
      addLights(this, A.lights, 5);
      hd2d(this.cameras.main, true);
      this.view = {}; this.units = new Map();
      this.queue = []; this.busy = 0; this.menu = null;
      this.applySnap(this.init0.snap, true);
      this.ui = new BattleUI(this);
      if (S.pendingBev) { for (const m of S.pendingBev) this.pushEvents(m.ev, m.snap); S.pendingBev = null; }
      this.cameras.main.fadeIn(350);
      if (this.init0.boss) this.cameras.main.shake(400, 0.006);
    }

    unitPos(u) {
      const [y0, y1] = D.AREAS[this.init0.area].bfloor;
      const fy = (f) => Math.round(y0 + (y1 - y0) * f);
      const FOE = this.init0.boss ? [[150, 0.6], [250, 0.2], [250, 0.98], [70, 0.15], [70, 0.98]] : [[175, 0.55], [105, 0.2], [105, 0.95], [245, 0.15], [245, 0.95]];
      const HERO = [[470, 0.1], [520, 0.45], [468, 0.8], [560, 0.98]];
      const sl = u.side === 'foe' ? FOE[u.slot % 5] : HERO[u.slot % 4];
      return { x: sl[0], y: fy(sl[1]) };
    }

    applySnap(snap, first) {
      this.snap = snap;
      for (const u of snap.units) {
        let v = this.units.get(u.uid);
        if (!v) v = this.makeUnit(u, first);
        v.u = u;
      }
    }

    makeUnit(u) {
      const p = this.unitPos(u);
      const key = u.side === 'hero' ? heroKey(u.key) : 'spr_' + D.ENEMIES[u.key].sprite;
      const spr = this.add.sprite(p.x, p.y, key, 0).setOrigin(0.5, 1).setDepth(p.y);
      if (u.side === 'hero') spr.setFlipX(false); // hero strips face left already
      const sh = this.add.image(p.x, p.y, 'shadow').setScale(u.side === 'foe' ? 1.6 : 1.1).setDepth(p.y - 1);
      const v = { u, spr, sh, home: p, t: Math.random() * 3, pose: null, poseT: 0, flash: 0 };
      this.units.set(u.uid, v);
      return v;
    }

    // ---------- event playback
    pushEvents(evs, snap) {
      this.queue.push(...evs.map(e => ({ e })));
      this.queue.push({ snap });
    }

    update(time, delta) {
      const now = performance.now(); const dt = Math.min(0.25, (now - (this.lastMs || now - 16)) / 1000); this.lastMs = now;
      // playback
      if (this.busy > 0) this.busy -= dt;
      while (this.busy <= 0 && this.queue.length) {
        const q = this.queue.shift();
        if (q.snap) { this.applySnap(q.snap); continue; }
        this.busy = this.play(q.e);
      }
      // idle animation
      for (const v of this.units.values()) {
        v.t += dt;
        const u = v.u;
        const isHero = u.side === 'hero';
        let frame;
        if (v.pose && v.poseT > 0) { v.poseT -= dt; frame = v.pose; }
        else if (!u.alive) frame = isHero ? D.HERO_FR.ko : D.FOE_FR.hurt;
        else frame = (isHero ? D.HERO_FR.idle : D.FOE_FR.idle)[Math.floor(v.t * 2.2) % 2];
        v.spr.setFrame(frame);
        const fly = isHero && u.key === 'lukaris' && u.alive ? 6 + Math.sin(v.t * 3) * 2 : 0;
        v.spr.y = Math.round(v.home.y - fly + (v.dy || 0));
        if (!u.alive && !isHero && !v.dead) { v.dead = true; this.tweens.add({ targets: [v.spr, v.sh], alpha: 0, duration: 600 }); }
        if (u.alive && v.dead) { v.dead = false; v.spr.setAlpha(1); v.sh.setAlpha(1); }
        if (v.flash > 0) { v.flash -= dt; v.spr.setTintFill(0xffffff); } else if (u.side === 'foe' && u.broken > 0) v.spr.setTint(0xb0a0c0); else if (u.status && u.status.poison) v.spr.setTint(0xe2ffd8); else v.spr.clearTint();
      }
      this.ui.update(dt);
      // command input
      if (this.menu) this.menu.update(dt);
      else this.maybeOpenMenu();
    }

    maybeOpenMenu() {
      const s = this.snap;
      if (!s || s.phase !== 'command' || this.queue.length || this.busy > 0) return;
      const u = s.units.find(x => x.uid === s.actor);
      if (u && u.owner === S.myPid && u.side === 'hero') this.menu = new CommandMenu(this, u);
    }

    sendCmd(uid, cmd) {
      this.menu = null;
      this.snap.phase = 'wait';
      send({ t: 'cmd', uid, cmd });
    }

    fx(key, x, y, o = {}) {
      const sp = this.add.image(x, y, 'fx_' + key).setDepth(o.depth || 800).setBlendMode(o.normal ? Phaser.BlendModes.NORMAL : Phaser.BlendModes.ADD).setScale(o.s0 || 0.3).setAlpha(o.a0 === undefined ? 1 : o.a0);
      if (o.flip) sp.setFlipX(true);
      if (o.tint) sp.setTint(o.tint);
      if (o.origin) sp.setOrigin(...o.origin);
      this.tweens.add({ targets: sp, scale: o.s1 || 0.8, alpha: 0, angle: o.spin || 0, x: x + (o.dx || 0), y: y + (o.dy || 0), duration: o.dur || 450, delay: o.delay || 0, ease: o.ease || 'Cubic.out', onComplete: () => sp.destroy() });
      return sp;
    }
    burst(x, y, tint, n = 12, o = {}) {
      const em = this.add.particles(x, y, 'px2', Object.assign({ speed: { min: 30, max: 110 }, lifespan: 500, scale: { start: 1.5, end: 0 }, tint, blendMode: 'ADD', emitting: false }, o)).setDepth(820);
      em.explode(n); this.time.delayedCall(900, () => em.destroy());
    }
    light(x, y, c, s = 3, d = 400) {
      const g = this.add.image(x, y, 'glow').setTint(c).setScale(s * 3).setBlendMode(Phaser.BlendModes.ADD).setDepth(790);
      this.tweens.add({ targets: g, alpha: 0, duration: d, onComplete: () => g.destroy() });
    }
    num(x, y, txt, color, big) {
      const t = T(this, x, y, txt, big ? 16 : 13, color, { stroke: 3 }).setOrigin(0.5).setDepth(1000).setScale(0.5);
      this.tweens.add({ targets: t, scale: 1, duration: 120, ease: 'Back.out' });
      this.tweens.add({ targets: t, y: y - 18, alpha: 0, delay: 500, duration: 450, onComplete: () => t.destroy() });
    }
    center(v) { return { x: v.home.x, y: v.home.y - v.spr.height * 0.5 }; }

    play(e) {
      const U = (id) => this.units.get(id);
      switch (e.type) {
        case 'msg': this.ui.banner(e.text); return 0.9;
        case 'round': this.ui.roundLabel(e.round); return 0.55;
        case 'turn': { const v = U(e.actor); if (v) { this.ui.focus(e.actor); this.tweens.add({ targets: v.spr, x: v.home.x + (v.u.side === 'hero' ? -8 : 8), duration: 150 }); this.time.delayedCall(260, () => { if (v.spr) this.tweens.add({ targets: v.spr, x: v.home.x, duration: 120 }); }); } return 0.25; }
        case 'skip': this.ui.banner(e.text); return 0.8;
        case 'tick': { const v = U(e.target); if (v) { const c = this.center(v); if (e.dmg) { this.num(c.x, c.y, String(e.dmg), '#8dff6a'); v.u.hp = Math.max(0, v.u.hp - e.dmg); this.burst(c.x, c.y, 0x7dff4a, 8); } else { this.num(c.x, c.y, '+' + e.heal, '#7dff8a'); v.u.hp = Math.min(v.u.maxhp, v.u.hp + e.heal); this.fx('motes', c.x, c.y, { s0: 0.1, s1: 0.35, tint: 0xff8a9a }); } } return 0.55; }
        case 'ko': { const v = U(e.target); if (v) { v.u.alive = false; v.u.hp = 0; this.burst(v.home.x, v.home.y - 20, 0x8a5aff, 16); } return 0.45; }
        case 'recover': { const v = U(e.target); if (v) { this.num(v.home.x, v.home.y - v.spr.height - 6, 'Щит восстановлен', '#9fd8ff'); v.u.broken = 0; v.u.shield = v.u.maxShield; } return 0.45; }
        case 'summon': {
          for (const nu of e.units) { const v = this.makeUnit(nu); v.spr.setAlpha(0); this.tweens.add({ targets: v.spr, alpha: 1, duration: 500 }); this.fx('mist', v.home.x, v.home.y - 30, { normal: true, s0: 0.2, s1: 0.6, tint: 0x4a2a6a }); }
          this.ui.banner(e.name); return 1.0;
        }
        case 'action': return this.playAction(e);
        case 'win': this.ui.result(true); return 0;
        case 'lose': this.ui.result(false); return 0;
      }
      return 0;
    }

    playAction(e) {
      const v = this.units.get(e.actor); if (!v) return 0.5;
      const hero = v.u.side === 'hero';
      const dir = hero ? -1 : 1;
      this.ui.actionName(e.name, hero);
      const F = hero ? D.HERO_FR : D.FOE_FR;
      const melee = e.anim === 'strike';
      // boost aura
      if (e.boost) { this.fx('motes', v.home.x, v.home.y - 24, { s0: 0.2, s1: 0.5, tint: 0xffd36b }); this.light(v.home.x, v.home.y - 20, 0xffd36b, 3, 500); }
      // approach
      const first = e.hits && e.hits[0] ? this.units.get(e.hits[0].target) : null;
      if (melee && first && first !== v) {
        const tx = first.home.x - dir * (hero ? -36 : 36) * -1;
        this.tweens.add({ targets: v.spr, x: first.home.x + (hero ? 34 : -34), duration: 180, ease: 'Quad.out' });
        this.tweens.add({ targets: v.spr, x: v.home.x, duration: 220, delay: 400 + 240 * Math.max(0, e.hits.length - 1), ease: 'Quad.in' });
      } else if (e.anim !== 'none') {
        this.tweens.add({ targets: v.spr, x: v.home.x + dir * 10, duration: 150, yoyo: true, hold: 300 });
      }
      v.pose = melee ? F.windup : F.cast; v.poseT = 0.2;
      this.time.delayedCall(200, () => { v.pose = melee ? F.strike : (F.release !== undefined ? F.release : F.cast); v.poseT = 0.3 + 0.24 * e.hits.length; });
      // cast circle
      if (e.anim === 'cast') {
        const c = this.add.image(v.home.x, v.home.y, 'fx_circle').setScale(0.1, 0.04).setBlendMode(Phaser.BlendModes.ADD).setDepth(v.home.y - 2).setTint(hero ? (v.u.key === 'lukaris' ? 0x9dff9d : 0xc08aff) : 0xff5a8a);
        this.tweens.add({ targets: c, scaleX: 0.5, scaleY: 0.2, duration: 200, ease: 'Back.out' });
        this.tweens.add({ targets: c, alpha: 0, delay: 450, duration: 300, onComplete: () => c.destroy() });
        this.light(v.home.x, v.home.y - 16, hero ? 0xb08aff : 0xff5a8a, 3, 600);
      }
      this.castFx(e, v);
      const base = 0.35;
      e.hits.forEach((h, i) => this.time.delayedCall((base + i * 0.24) * 1000, () => this.applyHit(h, e, v)));
      let t = base + e.hits.length * 0.24;
      if (e.counter) {
        e.counter.forEach((h, i) => this.time.delayedCall((t + 0.25 + i * 0.2) * 1000, () => {
          const by = this.units.get(h.by); const tg = this.units.get(h.target);
          if (tg) { const c = this.center(tg); this.fx('hellfire', c.x, tg.home.y, { s0: 0.15, s1: 0.5, origin: [0.5, 0.95], dur: 700, depth: 830 }); this.light(c.x, c.y, 0xff8a2a, 4, 600); this.cameras.main.shake(160, 0.01); }
          if (by) this.ui.actionName('Адское возмездие!', true);
          this.applyHit(h, e, by);
        }));
        t += 0.7;
      }
      return evDurLocal(e);
    }

    castFx(e, v) {
      const tgt = e.main || (e.hits[0] && e.hits[0].target);
      const tv = tgt ? this.units.get(tgt) : null;
      const from = { x: v.home.x + (v.u.side === 'hero' ? -16 : 16), y: v.home.y - v.spr.height * 0.6 };
      const to = tv ? this.center(tv) : from;
      const fly = (key, tint, s = 0.25, dur = 300) => {
        const sp = this.add.image(from.x, from.y, 'fx_' + key).setScale(s).setBlendMode(Phaser.BlendModes.ADD).setDepth(850);
        if (tint) sp.setTint(tint);
        sp.setFlipX(to.x < from.x);
        this.tweens.add({ targets: sp, x: to.x, y: to.y, duration: dur, ease: 'Quad.in', onComplete: () => sp.destroy() });
      };
      switch (e.fx) {
        case 'eldritch': for (let i = 0; i < e.hits.length; i++) this.time.delayedCall(140 + i * 240, () => fly('ebolt', null, 0.32, 200)); break;
        case 'iceknife': this.time.delayedCall(120, () => fly('iceshard', null, 0.3, 220)); this.time.delayedCall(360, () => { this.fx('iceburst', to.x, to.y, { s0: 0.15, s1: 0.8, dur: 600 }); this.cameras.main.shake(140, 0.008); }); break;
        case 'frost': this.time.delayedCall(200, () => this.fx('snowflake', to.x, to.y, { s0: 0.05, s1: 0.5, spin: 90, dur: 700 })); break;
        case 'faerie': for (const h of e.hits) { const t = this.units.get(h.target); if (t) { const c = this.center(t); this.fx('motes', c.x, c.y, { s0: 0.15, s1: 0.6, dur: 1100, spin: 40 }); } } break;
        case 'heal': case 'item': for (const h of e.hits) { const t = this.units.get(h.target); if (t) this.fx('healcol', t.home.x, t.home.y - 22, { s0: 0.2, s1: 0.5, dur: 900, dy: -8 }); } break;
        case 'berry': for (const h of e.hits) { const t = this.units.get(h.target); if (t) this.fx('motes', t.home.x, t.home.y - 20, { s0: 0.1, s1: 0.4, tint: 0xff7a8a, dur: 900 }); } break;
        case 'mist': this.fx('mist', v.home.x, v.home.y - 20, { normal: true, s0: 0.15, s1: 0.55, dur: 800 }); break;
        case 'rebukeReady': this.fx('hellfire', v.home.x, v.home.y, { s0: 0.1, s1: 0.4, origin: [0.5, 0.95], dur: 800 }); break;
        case 'defend': this.fx('spark', v.home.x, v.home.y - 24, { s0: 0.1, s1: 0.4, tint: 0x9fd8ff }); break;
        case 'darkness': for (const h of e.hits) { const t = this.units.get(h.target); if (t) this.fx('mist', t.home.x, t.home.y - 20, { normal: true, s0: 0.2, s1: 0.6, tint: 0x14081c, a0: 0.9, dur: 1000 }); } break;
        case 'litparty': for (const h of e.hits) { const t = this.units.get(h.target); if (t) this.fx('motes', t.home.x, t.home.y - 22, { s0: 0.1, s1: 0.4, dur: 900 }); } break;
        case 'spray': for (const h of e.hits) { const t = this.units.get(h.target); if (t) this.time.delayedCall(150, () => this.fx('poison', t.home.x, t.home.y - 22, { normal: true, s0: 0.15, s1: 0.45, dur: 700 })); } break;
        case 'web': if (tv) this.fx('slash', to.x, to.y, { s0: 0.2, s1: 0.4, tint: 0xffffff, dur: 600 }); break;
        case 'poisonbolt': case 'shot': break;
      }
    }

    applyHit(h, e, src) {
      const v = this.units.get(h.target); if (!v) return;
      const c = this.center(v);
      const u = v.u;
      if (h.miss) { this.num(c.x, c.y - 8, h.text || 'Промах', '#c8c0ff'); return; }
      if (h.dmg !== undefined) {
        u.hp = Math.max(0, u.hp - h.dmg);
        v.flash = 0.06; v.pose = (u.side === 'hero' ? D.HERO_FR : D.FOE_FR).hurt; v.poseT = 0.25;
        this.tweens.add({ targets: v.spr, x: v.home.x + (u.side === 'hero' ? 5 : -5), duration: 50, yoyo: true, repeat: 1 });
        const col = { fire: 0xff8a2a, ice: 0x9fe8ff, force: 0xc08aff, staff: 0xffe9a0, book: 0xffd9a0 }[h.type] || 0xffffff;
        if (e.fx === 'weapon' || e.anim === 'strike') this.fx('slash', c.x, c.y, { s0: 0.18, s1: 0.32, dur: 180, flip: u.side === 'foe', tint: col });
        this.fx('spark', c.x + Phaser.Math.Between(-6, 6), c.y + Phaser.Math.Between(-6, 6), { s0: 0.06, s1: h.weak ? 0.38 : 0.26, dur: 200, tint: col });
        if (h.type === 'fire') this.fx('hellfire', c.x, v.home.y, { s0: 0.08, s1: 0.3, origin: [0.5, 0.95], dur: 500 });
        this.burst(c.x, c.y, col, h.weak ? 14 : 8);
        this.num(c.x, c.y - 6, String(h.dmg) + (h.crit ? '!' : ''), h.weak ? '#ffd36b' : u.side === 'hero' ? '#ff7a7a' : '#ffffff', h.weak || h.crit);
        if (h.weak) this.num(c.x, c.y - 24, 'СЛАБОСТЬ', '#ffd36b');
        if (h.reveal) this.ui.reveal(u.uid, h.reveal);
        if (h.shield !== undefined) { u.shield = h.shield; this.ui.shieldHit(u.uid); }
        if (h.broke) {
          u.broken = 2; u.shield = 0;
          this.time.delayedCall(80, () => {
            this.ui.breakFx(u.uid);
            this.fx('spark', c.x, c.y, { s0: 0.2, s1: 0.9, dur: 400, tint: 0xffd36b });
            this.burst(c.x, c.y, 0xffe9a0, 30, { speed: { min: 60, max: 200 } });
            this.cameras.main.shake(260, 0.014);
            this.cameras.main.flash(120, 255, 240, 200);
          });
        }
        this.cameras.main.shake(80, h.weak ? 0.008 : 0.004);
        if (h.ko) { u.alive = false; }
      }
      if (h.heal !== undefined) { u.hp = Math.min(u.maxhp, u.hp + h.heal); if (h.revive) u.alive = true; this.num(c.x, c.y - 6, '+' + h.heal, '#7dff8a', true); if (h.revive) this.num(c.x, c.y - 24, 'Поднят!', '#bfffbf'); }
      if (h.sp !== undefined) { u.sp = Math.min(u.maxsp, u.sp + h.sp); this.num(c.x, c.y - 6, '+' + h.sp + ' ОУ', '#8ad8ff', true); }
      if (h.status) { const st = D.STATUS[h.status]; if (st) this.num(c.x, c.y - 30, st.name, st.color); }
      if (h.revealAll) for (const t of h.revealAll) this.ui.reveal(u.uid, t);
    }

    finish(result) {
      this.time.delayedCall(result === 'win' ? 1600 : 200, () => {
        if (result === 'win') this.close();
      });
      this.result = result;
    }
    close() {
      S.battleScene = null;
      this.scene.stop();
      if (S.explore) S.explore.backFromBattle();
    }
  }

  function evDurLocal(e) {
    return 0.85 + 0.24 * (e.hits ? e.hits.length : 0) + (e.counter ? 0.7 : 0) + (e.hits && e.hits.some(h => h.broke) ? 0.5 : 0);
  }

  // ------------------------------------------------------------ battle UI
  function panel(g, x, y, w, h, a = 0.82) {
    g.fillStyle(0x0b0714, a).fillRect(x, y, w, h);
    g.lineStyle(1, 0x8a6a3a, 1).strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.lineStyle(1, 0xe8c27a, 0.5).strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
    g.fillStyle(0xe8c27a, 1).fillRect(x, y, 2, 2).fillRect(x + w - 2, y, 2, 2).fillRect(x, y + h - 2, 2, 2).fillRect(x + w - 2, y + h - 2, 2, 2);
  }

  class BattleUI {
    constructor(sc) {
      this.sc = sc;
      this.g = sc.add.graphics().setDepth(2000);
      this.texts = [];
      this.foeInfo = new Map();
      this.orderIcons = [];
      this.bannerT = T(sc, W / 2, 46, '', 13, '#ffe3a0').setOrigin(0.5).setDepth(2100).setAlpha(0);
      this.actT = T(sc, W / 2, 28, '', 12, '#ffffff').setOrigin(0.5).setDepth(2100).setAlpha(0);
      this.partyT = [];
      this.focusId = null;
      this.revealed = new Map();
      this.orderLbl = T(sc, 8, 4, '', 9, '#e8c27a').setDepth(2100);
    }
    banner(s) { const t = this.bannerT; t.setText(s).setAlpha(1).setScale(0.8); this.sc.tweens.killTweensOf(t); this.sc.tweens.add({ targets: t, scale: 1, duration: 150, ease: 'Back.out' }); this.sc.tweens.add({ targets: t, alpha: 0, delay: 800, duration: 300 }); }
    actionName(s, hero) { const t = this.actT; t.setText(s).setColor(hero ? '#ffffff' : '#ffb0c0').setAlpha(1); this.sc.tweens.killTweensOf(t); this.sc.tweens.add({ targets: t, alpha: 0, delay: 900, duration: 300 }); }
    roundLabel(r) { this.banner('Раунд ' + r); }
    focus(id) { this.focusId = id; }
    reveal(uid, type) { const v = this.sc.units.get(uid); if (!v) return; const w = v.u.weak; }
    shieldHit(uid) { const fi = this.foeInfo.get(uid); if (fi) { fi.shake = 0.25; } }
    breakFx(uid) {
      const v = this.sc.units.get(uid); if (!v) return;
      const t = T(this.sc, v.home.x, v.home.y - v.spr.height - 10, 'ПРОЛОМ!', 18, '#ffd36b').setOrigin(0.5).setDepth(2100).setScale(2);
      this.sc.tweens.add({ targets: t, scale: 1, duration: 200, ease: 'Back.out' });
      this.sc.tweens.add({ targets: t, alpha: 0, y: t.y - 12, delay: 900, duration: 400, onComplete: () => t.destroy() });
    }
    result(win) {
      const sc = this.sc;
      const g = sc.add.graphics().setDepth(3000);
      panel(g, W / 2 - 150, H / 2 - 40, 300, 80, 0.92);
      T(sc, W / 2, H / 2 - 18, win ? 'ПОБЕДА' : 'ПАРТИЯ ПАЛА', 20, win ? '#ffd36b' : '#ff7a8a').setOrigin(0.5).setDepth(3001);
      T(sc, W / 2, H / 2 + 12, win ? 'Дроу больше не преграждают путь.' : (S.isHost ? 'Нажми «Подтвердить», чтобы попробовать снова' : 'Ждём хоста…'), 10, '#ffffff').setOrigin(0.5).setDepth(3001);
      if (!win) sc.retryWait = true;
    }
    clearTexts() { for (const t of this.texts) t.destroy(); this.texts = []; }
    update(dt) {
      const sc = this.sc, g = this.g, s = sc.snap;
      g.clear(); this.clearTexts();
      if (!s) return;
      // turn order (current round), top-left
      panel(g, 4, 2, 250, 26);
      this.texts.push(T(sc, 10, 6, 'Ход', 9, '#e8c27a').setDepth(2100));
      const order = s.order.filter(id => { const v = sc.units.get(id); return v && v.u.alive; });
      order.slice(0, 9).forEach((id, i) => {
        const v = sc.units.get(id); const x = 34 + i * 24, y = 5;
        const cur = id === s.actor;
        g.fillStyle(v.u.side === 'hero' ? 0x24384a : 0x4a2430, 1).fillRect(x, y, 20, 20);
        g.lineStyle(1, cur ? 0xffd36b : 0x6a5a7a, 1).strokeRect(x + 0.5, y + 0.5, 19, 19);
        const key = v.u.side === 'hero' ? heroKey(v.u.key) : 'spr_' + D.ENEMIES[v.u.key].sprite;
        const im = sc.add.image(x + 10, y + 10, key, 'head').setDepth(2101);
        im.setScale(18 / Math.max(im.width, im.height)); if (v.u.side === 'hero') im.setFlipX(false);
        this.texts.push(im);
      });
      // foes: shield + weaknesses + hp
      for (const v of sc.units.values()) {
        const u = v.u;
        if (u.side !== 'foe' || !u.alive) continue;
        const x = v.home.x, y = v.home.y + 4;
        const n = u.weak.length;
        const w0 = 22 + n * 12;
        g.fillStyle(0x0b0714, 0.8).fillRect(x - w0 / 2, y, w0, 14);
        // shield badge
        const broken = u.broken > 0;
        g.fillStyle(broken ? 0x5a4a5a : 0x3a5a8a, 1).fillRect(x - w0 / 2 + 1, y + 1, 18, 12);
        this.texts.push(T(sc, x - w0 / 2 + 10, y + 7, broken ? '✕' : String(u.shield), 9, broken ? '#ff8a8a' : '#ffffff', { stroke: 2 }).setOrigin(0.5).setDepth(2101));
        u.weak.forEach((t, i) => {
          const ix = x - w0 / 2 + 22 + i * 12 + 5, iy = y + 7;
          if (t === '?') { g.fillStyle(0x2a2238, 1).fillRect(ix - 5, iy - 5, 10, 10); this.texts.push(T(sc, ix, iy, '?', 8, '#a898c0', { stroke: 0 }).setOrigin(0.5).setDepth(2101)); }
          else { const im = sc.add.image(ix, iy, 'ic_' + D.TYPES[t].icon).setDepth(2101).setScale(10 / 18); this.texts.push(im); }
        });
        // hp bar
        g.fillStyle(0x000000, 0.8).fillRect(x - w0 / 2, y + 15, w0, 3);
        g.fillStyle(broken ? 0xffd36b : 0xd84a5a, 1).fillRect(x - w0 / 2, y + 15, w0 * u.hp / u.maxhp, 3);
        if (broken) { const t = T(sc, x, v.home.y - v.spr.height - 2, 'ПРОЛОМ ' + u.broken, 8, '#ffd36b').setOrigin(0.5, 1).setDepth(2101); this.texts.push(t); }
        if (u.status && u.status.lit) { this.texts.push(T(sc, x, y + 26, 'подсвечен', 7, '#e7a6ff').setOrigin(0.5).setDepth(2101)); }
      }
      // party panel bottom-right
      const heroes = [...sc.units.values()].filter(v => v.u.side === 'hero');
      const ph = 8 + heroes.length * 16;
      panel(g, 330, H - ph - 4, 306, ph);
      heroes.forEach((v, i) => {
        const u = v.u, y = H - ph + i * 16;
        const cur = s.actor === u.uid;
        if (cur) g.fillStyle(0xe8c27a, 0.18).fillRect(333, y - 1, 300, 15);
        const owner = S.roster.find(r => r.id === u.owner);
        this.texts.push(T(sc, 338, y, u.name, 9, u.alive ? '#f1e6cf' : '#8a7a8a').setDepth(2101));
        if (owner && S.roster.length > 1) this.texts.push(T(sc, 384, y + 1, owner.name.slice(0, 8), 7, '#' + owner.color.toString(16).padStart(6, '0')).setDepth(2101));
        // HP
        g.fillStyle(0x000000, 1).fillRect(430, y + 6, 70, 4);
        g.fillStyle(u.hp / u.maxhp > 0.3 ? 0x5ad86a : 0xd84a3a, 1).fillRect(430, y + 6, 70 * u.hp / u.maxhp, 4);
        this.texts.push(T(sc, 430, y - 5, 'ОЗ ' + u.hp, 8, '#ffffff', { stroke: 2 }).setDepth(2101));
        g.fillStyle(0x000000, 1).fillRect(506, y + 6, 46, 4);
        g.fillStyle(0x5aa8ff, 1).fillRect(506, y + 6, 46 * u.sp / u.maxsp, 4);
        this.texts.push(T(sc, 506, y - 5, 'ОУ ' + u.sp, 8, '#ffffff', { stroke: 2 }).setDepth(2101));
        // BP pips
        for (let k = 0; k < 5; k++) {
          const filled = k < u.bp;
          g.fillStyle(filled ? 0xffb43a : 0x2a2030, 1).fillCircle(566 + k * 13, y + 7, 4);
          if (filled) g.fillStyle(0xfff0b0, 1).fillCircle(565 + k * 13, y + 6, 1.5);
        }
        const sts = Object.keys(u.status || {}).map(k => D.STATUS[k] && D.STATUS[k].name).filter(Boolean);
        if (sts.length) this.texts.push(T(sc, v.home.x, v.home.y + 2, sts.join(' · '), 7, '#d8c8ff').setOrigin(0.5, 0).setDepth(2101));
      });
      if (this.focusId) { const v = sc.units.get(this.focusId); if (v && v.u.alive && s.phase !== 'win') { g.fillStyle(0xffd36b, 1).fillTriangle(v.home.x - 4, v.home.y - v.spr.height - 12, v.home.x + 4, v.home.y - v.spr.height - 12, v.home.x, v.home.y - v.spr.height - 6); } }
      // waiting for another player
      if (s.phase === 'command' && !sc.menu && !sc.queue.length) {
        const a = s.units.find(x => x.uid === s.actor);
        if (a && a.owner !== S.myPid) { const o = S.roster.find(r => r.id === a.owner); this.texts.push(T(sc, 10, H - 18, 'Ход: ' + a.name + (o ? ' (' + o.name + ')' : '') + ' — ждём…', 10, '#d8c8ff').setDepth(2101)); }
      }
      if (sc.retryWait && S.isHost && (sc.inp.pressed('ok') || S.testOk)) { S.testOk = false; sc.retryWait = false; send({ t: 'retry' }); sc.close(); }
      if (sc.retryWait && !S.isHost && S.world.mode === 'explore') { sc.retryWait = false; sc.close(); }
    }
  }

  // ------------------------------------------------------------ command menu
  class CommandMenu {
    constructor(sc, u) {
      this.sc = sc; this.u = u; this.h = D.HEROES[u.key];
      this.level = 'main'; this.idx = 0; this.boost = 0; this.sel = null;
      this.g = sc.add.graphics().setDepth(2500);
      this.texts = [];
      this.main = [['attack', 'Атака'], ['skill', 'Умения'], ['item', 'Предметы'], ['defend', 'Защита']];
      sc.ui.focus(u.uid);
      if (S.testCmd) this.auto();
    }
    auto() {
      // automated tests: pick a scripted command
      const c = S.testCmd(this.u, this.sc.snap);
      if (c) this.sc.time.delayedCall(150, () => { this.destroy(); this.sc.sendCmd(this.u.uid, c); });
    }
    destroy() { this.g.destroy(); this.texts.forEach(t => t.destroy()); }
    list() {
      if (this.level === 'main') return this.main;
      if (this.level === 'skill') return this.h.skills.map(k => [k, D.SKILLS[k].name, D.SKILLS[k].sp]);
      if (this.level === 'item') return Object.keys(D.ITEMS).map(k => [k, D.ITEMS[k].name, (this.sc.snap.inv || {})[k] || 0]);
      return [];
    }
    targets() {
      const s = this.sc.snap;
      const kind = this.sel.target;
      if (kind === 'enemy') return s.units.filter(x => x.side === 'foe' && x.alive);
      if (kind === 'ally') return s.units.filter(x => x.side === 'hero' && (x.alive || this.sel.revive));
      if (kind === 'ko') return s.units.filter(x => x.side === 'hero' && !x.alive);
      if (kind === 'itemAlly') return s.units.filter(x => x.side === 'hero' && x.alive);
      return [];
    }
    update(dt) {
      const inp = this.sc.inp;
      if (inp.pressed('bup')) this.boost = Math.min(Math.min(3, this.u.bp), this.boost + 1);
      if (inp.pressed('bdown')) this.boost = Math.max(0, this.boost - 1);
      if (this.level === 'target') {
        const ts = this.targets();
        if (!ts.length) { this.level = this.prevLevel; return; }
        if (inp.nav('up', dt) || inp.nav('left', dt)) this.tidx = (this.tidx + ts.length - 1) % ts.length;
        if (inp.nav('down', dt) || inp.nav('right', dt)) this.tidx = (this.tidx + 1) % ts.length;
        this.tidx = clamp(this.tidx, 0, ts.length - 1);
        if (inp.pressed('ok')) return this.commit(ts[this.tidx].uid);
        if (inp.pressed('back')) { this.level = this.prevLevel; return this.draw(); }
        return this.draw();
      }
      const L = this.list();
      if (inp.nav('up', dt)) this.idx = (this.idx + L.length - 1) % L.length;
      if (inp.nav('down', dt)) this.idx = (this.idx + 1) % L.length;
      if (inp.pressed('back') && this.level !== 'main') { this.level = 'main'; this.idx = 0; }
      else if (inp.pressed('ok')) this.choose(L[this.idx]);
      this.draw();
    }
    choose(item) {
      if (this.level === 'main') {
        const k = item[0];
        if (k === 'attack') { this.cmd = { kind: 'attack' }; this.sel = { target: 'enemy' }; this.toTarget(); }
        else if (k === 'defend') this.commit(null, { kind: 'defend' });
        else { this.level = k; this.idx = 0; }
      } else if (this.level === 'skill') {
        const s = D.SKILLS[item[0]];
        if (this.u.sp < s.sp) { this.sc.ui.banner('Не хватает очков умений'); return; }
        this.cmd = { kind: 'skill', skill: item[0] }; this.sel = s;
        if (s.target === 'enemy' || s.target === 'ally' || s.target === 'ko') this.toTarget();
        else this.commit(null);
      } else if (this.level === 'item') {
        if (!(item[2] > 0)) { this.sc.ui.banner('Нет в сумке'); return; }
        this.cmd = { kind: 'item', item: item[0] }; this.sel = { target: 'itemAlly' }; this.toTarget();
      }
    }
    toTarget() { this.prevLevel = this.level; this.level = 'target'; this.tidx = 0; }
    commit(target, cmd) {
      const c = Object.assign({}, cmd || this.cmd, { target, boost: (cmd || this.cmd).kind === 'defend' || (cmd || this.cmd).kind === 'item' ? 0 : this.boost });
      this.destroy();
      this.sc.sendCmd(this.u.uid, c);
    }
    draw() {
      const g = this.g, sc = this.sc;
      g.clear(); this.texts.forEach(t => t.destroy()); this.texts = [];
      const tx = (x, y, s, size, col, o) => { const t = T(sc, x, y, s, size, col, o).setDepth(2501); this.texts.push(t); return t; };
      // header: hero + boost
      panel(g, 6, H - 132, 200, 18);
      tx(12, H - 129, this.u.name, 10, '#ffe3a0');
      tx(100, H - 129, 'Усиление ' + '◆'.repeat(this.boost) + '◇'.repeat(Math.max(0, Math.min(3, this.u.bp) - this.boost)), 9, this.boost ? '#ffb43a' : '#8a7a8a');
      const L = this.level === 'target' ? this.list.call(Object.assign({}, this, { level: this.prevLevel })) : this.list();
      const lvl = this.level === 'target' ? this.prevLevel : this.level;
      const rows = lvl === 'main' ? 4 : L.length;
      const h = 8 + rows * 14;
      panel(g, 6, H - 112, 200, h);
      L.forEach((it, i) => {
        const y = H - 108 + i * 14;
        const cur = i === this.idx && this.level !== 'target';
        if (cur || (this.level === 'target' && i === this.idx)) g.fillStyle(0xe8c27a, cur ? 0.25 : 0.12).fillRect(9, y - 1, 194, 13);
        let col = '#f1e6cf';
        if (lvl === 'skill' && this.u.sp < it[2]) col = '#6a5a6a';
        if (lvl === 'item' && !(it[2] > 0)) col = '#6a5a6a';
        tx(16, y, (cur ? '▶ ' : '  ') + it[1], 10, col);
        if (lvl === 'skill') tx(170, y, String(it[2]), 9, '#8ad8ff');
        if (lvl === 'item') tx(178, y, '×' + it[2], 9, '#cfc0a0');
      });
      // description
      let desc = '';
      if (lvl === 'skill') desc = D.SKILLS[L[this.idx][0]].desc;
      else if (lvl === 'item') desc = D.ITEMS[L[this.idx][0]].desc;
      else if (lvl === 'main') desc = ['Удар оружием (' + D.TYPES[this.h.weapon].name.toLowerCase() + '). Усиление: больше ударов.', 'Заклинания и приёмы.', 'Общая сумка партии.', 'Урон по герою вдвое меньше, ходит первым в следующем раунде.'][this.idx];
      if (this.level === 'target') {
        const ts = this.targets(); const t = ts[this.tidx];
        if (t) {
          const v = sc.units.get(t.uid);
          desc = 'Цель: ' + t.name + (t.side === 'foe' ? '  · щит ' + t.shield : '  · ОЗ ' + t.hp + '/' + t.maxhp);
          if (v) { const bob = Math.sin(sc.time.now / 120) * 2; g.fillStyle(0xffd36b, 1).fillTriangle(v.home.x - 5, v.home.y - v.spr.height - 14 + bob, v.home.x + 5, v.home.y - v.spr.height - 14 + bob, v.home.x, v.home.y - v.spr.height - 7 + bob); }
        }
      }
      if (desc) { panel(g, 120, 32, 400, 30); tx(128, 36, desc, 9, '#f1e6cf', { wrap: 386 }); }
      tx(6, H - 150, 'Подтвердить: Enter/Пробел/J · Назад: Esc/K · Усиление: E/Q (геймпад A/B, RB/LB)', 7, '#a898c0');
    }
  }

  // ------------------------------------------------------------ UI scene: dialogs, prompts, area titles, explore HUD
  class UIScene extends Phaser.Scene {
    constructor() { super('ui'); }
    create() {
      S.ui = this;
      this.inp = new Input(this);
      this.g = this.add.graphics().setDepth(10);
      this.q = []; this.cur = null;
      this.dlgName = T(this, 30, 16, '', 11, '#ffe3a0').setDepth(12);
      this.dlgText = T(this, 30, 32, '', 11, '#f1e6cf', { wrap: 580 }).setDepth(12);
      this.dlgHint = T(this, W - 30, 70, '▼', 10, '#e8c27a').setOrigin(1, 0).setDepth(12);
      this.promptT = T(this, 0, 0, '', 9, '#ffe3a0').setOrigin(0.5, 1).setDepth(12);
      this.titleT = T(this, W / 2, 26, '', 14, '#ffe3a0').setOrigin(0.5).setAlpha(0).setDepth(12);
      this.toastT = T(this, W / 2, 70, '', 10, '#ffffff').setOrigin(0.5).setAlpha(0).setDepth(12);
      this.hud = this.add.graphics().setDepth(5);
      this.hudT = [];
    }
    busy() { return !!this.cur; }
    dialog(lines) { this.q.push(...lines); if (!this.cur) this.nextLine(); if (S.isHost) S.dialogOpenHost = true; }
    nextLine() {
      this.cur = this.q.shift() || null;
      if (!this.cur) {
        this.dlgName.setText(''); this.dlgText.setText(''); this.dlgHint.setText('');
        if (S.isHost) { S.dialogOpenHost = false; if (S.afterDialog) { const f = S.afterDialog; S.afterDialog = null; f(); } }
        return;
      }
      this.typed = 0; this.full = this.cur[1];
    }
    areaTitle(s) { const t = this.titleT; t.setText(s).setAlpha(0); this.tweens.killTweensOf(t); this.tweens.add({ targets: t, alpha: 1, duration: 500 }); this.tweens.add({ targets: t, alpha: 0, delay: 2600, duration: 700 }); }
    toast(s) { const t = this.toastT; t.setText(s).setAlpha(1); this.tweens.killTweensOf(t); this.tweens.add({ targets: t, alpha: 0, delay: 1800, duration: 500 }); }
    prompt(near, L) {
      if (!near || !L || this.cur) { this.promptT.setText(''); return; }
      this.promptT.setText('[Enter] ' + near.label).setPosition(L.x, L.y - 62);
    }
    ending() {
      const g = this.add.graphics().setDepth(50);
      g.fillStyle(0x000000, 0.85).fillRect(0, 0, W, H);
      const t1 = T(this, W / 2, H / 2 - 30, 'ПОБЕГ ИЗ ВЕЛКИНВИЛЬВА', 22, '#ffd36b').setOrigin(0.5).setDepth(51).setAlpha(0);
      const t2 = T(this, W / 2, H / 2 + 6, 'Конец пробной главы', 13, '#f1e6cf').setOrigin(0.5).setDepth(51).setAlpha(0);
      const t3 = T(this, W / 2, H / 2 + 30, 'Впереди — Подземье. Продолжение следует…', 10, '#a898c0').setOrigin(0.5).setDepth(51).setAlpha(0);
      this.tweens.add({ targets: [t1, t2, t3], alpha: 1, duration: 1200 });
    }
    update(time, delta) {
      const dt = delta / 1000;
      const g = this.g;
      g.clear();
      if (this.cur) {
        panel(g, 16, 8, W - 32, 78, 0.9);
        this.typed = Math.min(this.full.length, this.typed + dt * 55);
        this.dlgName.setText(this.cur[0]);
        this.dlgText.setText(this.full.slice(0, Math.floor(this.typed)));
        this.dlgHint.setText(this.typed >= this.full.length && Math.floor(time / 400) % 2 ? '▼' : '');
        if (this.inp.pressed('ok') || S.testOk) {
          S.testOk = false;
          if (this.typed < this.full.length) this.typed = this.full.length; else this.nextLine();
        }
      }
      // exploration HUD: party HP + bag
      this.hud.clear(); this.hudT.forEach(t => t.destroy()); this.hudT = [];
      const w = S.world;
      if (w && w.mode !== 'battle' && !S.battleScene && !this.cur) {
        const list = (S.isHost ? partyList() : this.mirrorParty()) || [];
        panel(this.hud, W - 150, 4, 146, 8 + list.length * 12);
        list.forEach((h, i) => {
          const st = w.party[h.uid] || { hp: D.HEROES[h.char].stats.hp, sp: D.HEROES[h.char].stats.sp };
          const y = 8 + i * 12;
          this.hudT.push(T(this, W - 144, y, h.name, 8, '#f1e6cf').setDepth(6));
          this.hud.fillStyle(0x000000, 1).fillRect(W - 90, y + 4, 50, 3);
          this.hud.fillStyle(0x5ad86a, 1).fillRect(W - 90, y + 4, 50 * st.hp / D.HEROES[h.char].stats.hp, 3);
          this.hudT.push(T(this, W - 36, y, String(st.hp), 8, '#ffffff', { stroke: 2 }).setDepth(6));
        });
        const inv = w.inv || {};
        this.hudT.push(T(this, W - 146, 12 + list.length * 12, 'Зелья ×' + (inv.potion || 0) + '  Настой ×' + (inv.ether || 0), 7, '#cfc0a0').setDepth(6));
      }
    }
    mirrorParty() {
      const ps = [...S.world.players.values()];
      const list = ps.map(p => ({ uid: 'h' + p.id, char: p.char, name: D.HEROES[p.char].name }));
      if (ps.length === 1) { const o = ps[0].char === 'lukaris' ? 'soreen' : 'lukaris'; list.push({ uid: 'h' + ps[0].id + 'b', char: o, name: D.HEROES[o].name }); }
      return list;
    }
  }

  window.JR = { evDur, partyList };
})();
