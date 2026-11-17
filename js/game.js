// Main game: Phaser scenes, local player control, rendering, networking glue.
(function () {
  const G = window.GCONST;
  const params = new URLSearchParams(location.search);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ------------------------------------------------------------------ state
  const S = {
    net: null, isHost: false, myPid: null, started: false,
    roster: [],            // [{id,name,char,color}]
    world: null, sim: null, scene: null,
    me: { name: 'Игрок', char: 'lukaris' },
    peerToPid: new Map(), nextPid: 1,
    eventsOut: [], lastSnap: 0, lastReport: 0,
    snapInfo: { phase: 'walk', seg: 0, camL: 0, lock: false, dark: null, boss: null },
  };
  window.S = S;

  function newWorld() {
    return { players: new Map(), enemies: new Map(), projs: new Map(), pickups: new Map(), events: [], time: 0, nextId: 1, seg: 0, phase: 'walk', lock: false, camL: 0, dark: null, pending: [] };
  }

  function addPlayerToWorld(id, name, char, i) {
    const h = HEROES[char];
    const p = {
      id, name, char, color: G.COLORS[i % 4],
      x: 180 + i * 60, y: G.Y_MIN + 50 + i * 40, z: 0, face: 1, anim: 'idle', p: 0, v: 0,
      hp: h.hp, maxhp: h.hp, state: 'ok', revive: 0, rebuke: char === 'soreen' ? 0.5 : 0, inv: 0, poison: 0, dark: 0,
    };
    S.world.players.set(id, p);
    return p;
  }

  function rosterFromWorld() {
    return [...S.world.players.values()].map(p => ({ id: p.id, name: p.name, char: p.char, color: p.color }));
  }

  // ------------------------------------------------------------------ public API (lobby)
  window.GAME = {
    hostGame(me, cb) {
      S.me = me; S.isHost = true; S.world = newWorld(); S.sim = new Sim(S.world);
      S.myPid = 0;
      addPlayerToWorld(0, me.name, me.char, 0);
      S.roster = rosterFromWorld(); LOBBY.roster(S.roster);
      const net = S.net = new Net();
      net.onError = (e) => console.warn('net error', e && e.type, e);
      net.onJoin = (peerId) => { /* wait for hello */ };
      net.onLeave = (peerId) => {
        const pid = S.peerToPid.get(peerId);
        if (pid === undefined) return;
        S.peerToPid.delete(peerId);
        const p = S.world.players.get(pid);
        S.world.players.delete(pid);
        S.roster = rosterFromWorld(); LOBBY.roster(S.roster);
        net.broadcast({ t: 'roster', list: S.roster });
        if (p) pushEvent({ e: 'msg', text: p.name + ' отключился', small: true });
      };
      net.onMessage = (peerId, m) => hostOnMessage(peerId, m);
      net.host((err, code) => cb(err, code));
      net.onError = (e) => { console.warn('net error', e && e.type, e); if (!net.code || !net.peer || !net.peer.open) cb(e && e.type || 'network'); };
    },
    startAsHost() {
      if (S.started) return;
      S.started = true;
      if (params.get('seg')) {
        const n = +params.get('seg'); S.world.seg = n; S.world.camL = G.SEGS[n].x0;
        let i = 0; for (const p of S.world.players.values()) { p.x = G.SEGS[n].x0 + 200 + 60 * i++; }
      }
      S.net.broadcast({ t: 'start' });
      bootPhaser();
    },
    joinGame(code, me, cb) {
      S.me = me; S.isHost = false; S.world = newWorld();
      const net = S.net = new Net();
      net.onMessage = (_, m) => clientOnMessage(m);
      net.onLeave = () => { showBanner('Связь с хостом потеряна', true); LOBBY.status('Связь с хостом потеряна'); };
      net.onError = (e) => console.warn('net error', e && e.type, e);
      net.join(code, (err) => {
        if (err) return cb(err);
        net.toHost({ t: 'hello', name: me.name, char: me.char });
        cb(null);
      });
    },
  };

  // ------------------------------------------------------------------ host networking
  function hostOnMessage(peerId, m) {
    if (m.t === 'hello') {
      if (S.peerToPid.has(peerId)) return;
      if (S.world.players.size >= 4) { S.net.send(peerId, { t: 'full' }); return; }
      const pid = S.nextPid++;
      S.peerToPid.set(peerId, pid);
      const used = new Set([...S.world.players.values()].map(q => q.color));
      const ci = [0, 1, 2, 3].find(i => !used.has(G.COLORS[i]));
      const p = addPlayerToWorld(pid, String(m.name || 'Игрок').slice(0, 14), HEROES[m.char] ? m.char : 'lukaris', ci === undefined ? pid : ci);
      if (S.started) { p.x = S.world.camL + 200; p.inv = 2; }
      S.roster = rosterFromWorld(); LOBBY.roster(S.roster);
      S.net.send(peerId, { t: 'welcome', pid, x: p.x, y: p.y });
      S.net.broadcast({ t: 'roster', list: S.roster });
      if (S.started) { S.net.send(peerId, { t: 'start' }); pushEvent({ e: 'msg', text: p.name + ' присоединяется к побегу!', small: true }); }
      return;
    }
    const pid = S.peerToPid.get(peerId);
    if (pid === undefined) return;
    const p = S.world.players.get(pid);
    if (!p) return;
    if (m.t === 'st') {
      p.x = m.x; p.y = m.y; p.z = m.z; p.face = m.f; p.anim = m.a; p.p = m.p; p.v = m.v;
    } else if (m.t === 'a') {
      S.sim.action(pid, m);
    }
  }

  function pushEvent(e) { S.world.events.push(e); }

  function packSnapshot(events) {
    const w = S.world;
    const r1 = (v) => Math.round(v);
    return {
      t: 's',
      w: [w.phase, w.seg, r1(w.camL), w.lock ? 1 : 0, w.dark ? [r1(w.dark.x), r1(w.dark.y), w.dark.r] : 0],
      ps: [...w.players.values()].map(p => [p.id, r1(p.x), r1(p.y), r1(p.z), p.face, p.anim, +p.p.toFixed(2), p.v || 0, r1(p.hp), p.maxhp, p.state, +((p.revive || 0).toFixed(2)), +((p.rebuke || 0).toFixed(2)), p.poison > 0 ? 1 : 0, p.dark > 0 ? 1 : 0]),
      es: [...w.enemies.values()].map(e => [e.id, e.kind, r1(e.x), r1(e.y), r1(e.z), e.face, e.anim, +(e.p || 0).toFixed(2), r1(e.hp), e.maxhp, (e.ff > 0 ? 1 : 0) | (e.slow > 0 ? 2 : 0) | (e.burn > 0 ? 4 : 0), e.state]),
      pr: [...w.projs.values()].map(p => [p.id, p.kind, r1(p.x), r1(p.y), r1(p.z), r1(p.vx)]),
      pk: [...w.pickups.values()].map(k => [k.id, k.kind, r1(k.x), r1(k.y)]),
      ev: events,
    };
  }

  // ------------------------------------------------------------------ client networking
  function clientOnMessage(m) {
    switch (m.t) {
      case 'welcome': S.myPid = m.pid; S.spawn = { x: m.x, y: m.y }; break;
      case 'roster': S.roster = m.list; LOBBY.roster(m.list); break;
      case 'full': LOBBY.status('Комната заполнена (максимум 4 игрока)'); break;
      case 'start': if (!S.started) { S.started = true; bootPhaser(); } break;
      case 's': applySnapshot(m); break;
    }
  }

  function applySnapshot(m) {
    const w = S.world;
    const [phase, seg, camL, lock, dark] = m.w;
    w.phase = phase; w.seg = seg; w.camL = camL; w.lock = !!lock; w.dark = dark ? { x: dark[0], y: dark[1], r: dark[2] } : null;
    const seen = new Set();
    for (const a of m.ps) {
      const [id, x, y, z, face, anim, p, v, hp, maxhp, state, revive, rebuke, poison, darkf] = a;
      seen.add(id);
      let P = w.players.get(id);
      const ros = S.roster.find(r => r.id === id) || { name: '?', char: 'lukaris', color: 0xffffff };
      if (!P) { P = { id, name: ros.name, char: ros.char, color: ros.color, x, y, z, face }; w.players.set(id, P); }
      Object.assign(P, { tx: x, ty: y, tz: z, hp, maxhp, state, revive, rebuke, poison, dark: darkf, name: ros.name, char: ros.char, color: ros.color });
      if (id !== S.myPid) { P.face = face; P.anim = anim; P.p = p; P.v = v; }
    }
    for (const id of [...w.players.keys()]) if (!seen.has(id)) w.players.delete(id);
    syncMap(w.enemies, m.es, (a, E) => {
      const [id, kind, x, y, z, face, anim, p, hp, maxhp, flags, state] = a;
      Object.assign(E, { id, kind, tx: x, ty: y, tz: z, face, anim, p, hp, maxhp, ff: flags & 1, slow: flags & 2, burn: flags & 4, state });
      if (E.x === undefined) { E.x = x; E.y = y; E.z = z; }
    });
    syncMap(w.projs, m.pr, (a, R) => {
      const [id, kind, x, y, z, vx] = a;
      if (R.x === undefined || Math.abs(R.x - x) > 60) R.x = x;
      Object.assign(R, { id, kind, y, z, vx });
    });
    syncMap(w.pickups, m.pk, (a, K) => { const [id, kind, x, y] = a; Object.assign(K, { id, kind, x, y }); });
    for (const e of m.ev) handleEvent(e);
  }

  function syncMap(map, arr, fill) {
    const seen = new Set();
    for (const a of arr) {
      const id = a[0]; seen.add(id);
      let o = map.get(id); if (!o) { o = {}; map.set(id, o); }
      fill(a, o);
    }
    for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id);
  }

  // ------------------------------------------------------------------ local player controller
  class Local {
    constructor(pid, char, x, y) {
      this.pid = pid; this.char = char; this.h = HEROES[char];
      this.x = x; this.y = y; this.z = 0; this.face = 1; this.vx = 0; this.vz = 0;
      this.anim = 'idle'; this.p = 0; this.v = 0; this.act = null; this.hurtT = 0; this.kx = 0;
      this.cds = {}; this.combo = 0; this.comboT = 0; this.dashT = 0;
    }
    ready(s) { return !(this.cds[s] > 0); }
    use(s) { this.cds[s] = this.h.skills[s].cd; }

    update(dt, input, P) {
      for (const k in this.cds) this.cds[k] -= dt;
      this.comboT -= dt;
      const state = P ? P.state : 'ok';
      if (state === 'down') { this.anim = 'down'; this.act = null; this.write(P); return; }

      if (this.hurtT > 0) {
        this.hurtT -= dt; this.anim = 'hurt'; this.p = 1 - this.hurtT / 0.35;
        this.x += this.kx * dt; this.kx *= Math.pow(0.03, dt);
        this.clampPos(); this.write(P); return;
      }
      if (this.dashT > 0) {
        this.dashT -= dt; this.anim = 'dash'; this.x += this.vx * dt; this.clampPos();
        if (this.dashT <= 0) this.anim = 'idle';
        this.write(P); return;
      }

      let mvx = input.x, mvy = input.y;
      let speed = this.h.speed, dspeed = this.h.depthSpeed;
      if (P && P.dark) { speed *= 0.85; }
      if (this.act) {
        const a = this.act; a.t += dt;
        this.p = Math.min(1, a.t / a.dur); this.anim = a.anim; this.v = a.v || 0;
        if (!a.fired && a.t >= a.at) { a.fired = true; this.fire(a); }
        if (a.t >= a.dur) this.act = null;
        mvx *= 0.15; mvy *= 0.15;
      } else {
        if (mvx) this.face = Math.sign(mvx);
        // actions
        const press = input.pressed;
        if (press.dash && this.ready('dash')) this.dash(input);
        else if (press.melee && this.ready('melee')) {
          if (this.comboT <= 0) this.combo = 0;
          const v = this.combo % 2; this.combo++; this.comboT = 0.7;
          this.startAct({ s: 'melee', anim: 'melee', dur: 0.36, at: 0.17, v });
          this.use('melee');
        } else {
          for (const s of ['k', 'l', 'i', 'o', 'u']) {
            if (press[s] && this.h.skills[s] && this.ready(s)) {
              this.startAct({ s, anim: 'cast', dur: s === 'k' && this.char === 'soreen' ? 0.32 : 0.48, at: s === 'k' && this.char === 'soreen' ? 0.1 : 0.2 });
              this.use(s); break;
            }
          }
        }
      }
      const len = Math.hypot(mvx, mvy) || 1;
      const nx = mvx / Math.max(1, len), ny = mvy / Math.max(1, len);
      this.x += nx * speed * dt; this.y += ny * dspeed * dt;
      if (!this.act) { this.anim = (Math.abs(mvx) + Math.abs(mvy) > 0.1) ? 'walk' : 'idle'; this.p = 0; }
      this.clampPos();
      this.write(P);
    }
    clampPos() {
      const camL = S.world.camL;
      this.x = clamp(this.x, Math.max(30, camL + 40), Math.min(G.STAGE_W - 30, camL + G.W - 40));
      this.y = clamp(this.y, G.Y_MIN, G.Y_MAX);
    }
    startAct(a) { a.t = 0; a.fired = false; this.act = a; this.anim = a.anim; this.p = 0; this.v = a.v || 0; }
    fire(a) { sendAction({ s: a.s, v: a.v || 0 }); }
    dash(input) {
      this.use('dash');
      if (this.char === 'lukaris') { // Misty Step: teleport
        let dx = input.x, dy = input.y;
        if (!dx && !dy) dx = this.face;
        const L = Math.hypot(dx, dy); dx /= L; dy /= L;
        const fx = this.x, fy = this.y;
        this.x += dx * 240; this.y += dy * 130; this.clampPos();
        if (dx) this.face = Math.sign(dx);
        sendAction({ s: 'dash', fx, fy });
      } else { // backstep
        this.vx = -this.face * 720; this.dashT = 0.22;
        sendAction({ s: 'dash' });
      }
    }
    hurt(kx) { this.hurtT = 0.35; this.kx = kx; this.act = null; }
    write(P) {
      if (!P) return;
      P.x = this.x; P.y = this.y; P.z = this.z; P.face = this.face; P.anim = this.anim; P.p = this.p; P.v = this.v;
    }
  }

  function sendAction(a) {
    a.t = 'a';
    if (S.isHost) S.sim.action(S.myPid, a); else S.net.toHost(a);
  }

  // ------------------------------------------------------------------ events -> visuals
  function handleEvent(e) {
    const sc = S.scene; if (!sc) return;
    switch (e.e) {
      case 'dmg': sc.floatText(e.x, e.y - (e.z || 80), String(e.v), DMGCOL[e.c] || '#fff', e.c === 'enemy' ? 26 : 24); if (e.id !== undefined) sc.flashEnemy(e.id, e.v >= 9); break;
      case 'heal': if (e.v > 0) sc.floatText(e.x, e.y - (e.z || 90), '+' + e.v, '#7dff8a', 26); sc.fxHeal(e.x, e.y); break;
      case 'hurt': if (e.pid === S.myPid && S.local) { S.local.hurt(e.kx); sc.cameras.main.shake(120, 0.006); } break;
      case 'tp': if (e.pid === S.myPid && S.local) { S.local.x = e.x; S.local.y = e.y; } break;
      case 'revive': sc.fxHeal(e.x, e.y, true); if (e.pid === S.myPid) showBanner('Ты снова на ногах!'); break;
      case 'kill': sc.fxKill(e.x, e.y); break;
      case 'msg': if (!e.pid || e.pid === S.myPid) showBanner(e.text, e.big); if (e.win) sc.win(); break;
      case 'go': sc.showGo(); break;
      case 'tele': sc.telegraph(e.id); break;
      case 'fx': sc.fx(e); break;
    }
  }
  // Keyboard layouts follow common beat 'em up defaults:
  //  wasd   — WASD + J/K/L/I/O/U cluster, Space = dash (Scott Pilgrim, 2XKO-style)
  //  arrows — arrows + X attack / A special / S dodge (TMNT: Shredder's Revenge-style), extra spells on Z C D V
  // Gamepad follows Streets of Rage 4 / Shinobi: X attack, Y special, RB dash.
  const ACTIONS = ['melee', 'k', 'l', 'i', 'o', 'u', 'dash'];
  const BINDS = window.BINDS = {
    wasd: { up: 'W', down: 'S', left: 'A', right: 'D', melee: 'J', k: 'K', l: 'L', i: 'I', o: 'O', u: 'U', dash: 'SPACE' },
    arrows: { up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', melee: 'X', k: 'A', l: 'Z', i: 'C', o: 'D', u: 'V', dash: 'S' },
  };
  // standard gamepad indices: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT
  const PAD = window.PADBINDS = { melee: [2], k: [3], l: [1], i: [0], o: [4], u: [6], dash: [5, 7] };
  const PADLBL = { melee: 'X', k: 'Y', l: 'B', i: 'A', o: 'LB', u: 'LT', dash: 'RB' };
  const KEYLBL = (k) => ({ SPACE: '␣', UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' }[k] || k);
  S.scheme = (() => { try { return localStorage.getItem('velk_scheme') || 'wasd'; } catch (e) { return 'wasd'; } })();
  const DMGCOL = { phys: '#ffffff', cold: '#9fe8ff', fire: '#ffae4a', force: '#d7a6ff', poison: '#8dff6a', enemy: '#ff5a5a' };

  let bannerTimer = null;
  function showBanner(text, big) { if (S.scene) S.scene.banner(text, big); }

  // ------------------------------------------------------------------ Phaser
  function bootPhaser() {
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    new Phaser.Game({
      type: Phaser.AUTO, parent: 'game', width: G.W, height: G.H, backgroundColor: '#07050c',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
      input: { gamepad: true },
      render: { preserveDrawingBuffer: params.has('test') },
      scene: [GameScene],
    });
  }

  class GameScene extends Phaser.Scene {
    constructor() { super('game'); }
    preload() {
      loadAllAssets(this);
      const t = this.add.text(G.W / 2, G.H / 2, 'Спускаемся в Подземье…', { fontFamily: 'Cormorant SC, serif', fontSize: 32, color: '#e8c27a' }).setOrigin(0.5);
      this.load.on('progress', (v) => t.setText('Спускаемся в Подземье… ' + Math.round(v * 100) + '%'));
      this.load.on('complete', () => t.destroy());
    }
    create() {
      S.scene = this;
      this.makeTextures();
      this.vis = new Map();
      this.buildStage();
      // local player
      const startX = S.isHost ? S.world.players.get(0).x : (S.spawn ? S.spawn.x : 200);
      const startY = S.isHost ? S.world.players.get(0).y : (S.spawn ? S.spawn.y : 520);
      S.local = new Local(S.myPid, S.me.char, startX, startY);
      // input
      this.keys = this.input.keyboard.addKeys('W,A,S,D,UP,DOWN,LEFT,RIGHT,J,K,L,I,O,U,SPACE,Z,X,C,V');
      this.input.keyboard.addCapture('SPACE,UP,DOWN,LEFT,RIGHT');
      this.input.keyboard.on('keydown', () => { S.usingPad = false; });
      this.hud = new HUD(this);
      this.cameras.main.setBounds(0, 0, G.STAGE_W, G.H);
      this.cameras.main.fadeIn(600);
      this.banner('Велкинвильв. Бегите, пока стража не опомнилась!', true);
      if (params.has('test')) window.TEST_SCENE = this;
    }

    // ---------------- procedural textures for effects
    makeTextures() {
      const g = this.make.graphics({ x: 0, y: 0, add: false });
      // soft dot
      for (let r = 16; r > 0; r--) { g.fillStyle(0xffffff, (1 - r / 16) * 0.22); g.fillCircle(16, 16, r); }
      g.generateTexture('dot', 32, 32); g.clear();
      g.fillStyle(0xffffff, 1); g.fillCircle(4, 4, 4); g.generateTexture('px', 8, 8); g.clear();
      // spark (4-point star)
      g.fillStyle(0xffffff, 1); g.fillTriangle(8, 0, 10, 8, 6, 8); g.fillTriangle(8, 16, 10, 8, 6, 8); g.fillTriangle(0, 8, 8, 6, 8, 10); g.fillTriangle(16, 8, 8, 6, 8, 10);
      g.generateTexture('spark', 16, 16); g.clear();
      // ice shard
      g.fillStyle(0xdff8ff, 1); g.fillTriangle(0, 6, 40, 0, 40, 12); g.fillStyle(0x8fd8ff, 1); g.fillTriangle(40, 0, 52, 6, 40, 12); g.lineStyle(1, 0xffffff, 1); g.strokeTriangle(0, 6, 40, 0, 40, 12);
      g.generateTexture('shard', 52, 12); g.clear();
      // crossbow bolt
      g.fillStyle(0x2a2230, 1); g.fillRect(0, 3, 40, 3); g.fillStyle(0x9b8fb0, 1); g.fillTriangle(40, 0, 50, 4.5, 40, 9); g.fillStyle(0x6d2a8a, 1); g.fillTriangle(0, 0, 8, 4.5, 0, 9);
      g.generateTexture('bolt', 50, 9); g.clear();
      // goodberry
      g.fillStyle(0x1f6b2a, 1); g.fillEllipse(16, 8, 14, 6); g.fillStyle(0xc0172f, 1); g.fillCircle(16, 18, 10); g.fillStyle(0xff6b7d, 1); g.fillCircle(12, 14, 3);
      g.generateTexture('berry', 32, 30); g.clear();
      // ring
      g.lineStyle(4, 0xffffff, 1); g.strokeCircle(64, 64, 60); g.generateTexture('ring', 128, 128); g.clear();
      // shadow
      g.fillStyle(0x000000, 0.45); g.fillEllipse(50, 14, 100, 28); g.generateTexture('shadow', 100, 28); g.clear();
      // vignette
      g.destroy();
      const cv = this.textures.createCanvas('vignette', G.W, G.H);
      const ctx = cv.getContext();
      const grd = ctx.createRadialGradient(G.W / 2, G.H * 0.55, G.H * 0.35, G.W / 2, G.H * 0.55, G.W * 0.75);
      grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(5,0,15,0.75)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, G.W, G.H); cv.refresh();
    }

    buildStage() {
      // far cavern (parallax)
      const bg = this.add.image(0, -170, 'st_bg').setOrigin(0, 0).setScale(1.22).setScrollFactor(0.17, 0).setDepth(-100);
      // mid layer: hanging stalactites & lanterns
      for (let i = 0; i < 16; i++) {
        const x = i * 330 + (i % 3) * 40;
        this.add.image(x, -40 - (i % 2) * 40, 'st_stalactite').setOrigin(0.5, 0).setScale(0.7 + (i % 3) * 0.15).setScrollFactor(0.55, 0).setDepth(-60).setTint(0x8a80a8);
        if (i % 2 === 0) {
          const ln = this.add.image(x + 150, 70 + (i % 4) * 30, 'st_lantern').setScale(0.42).setScrollFactor(0.7, 0).setDepth(-55);
          this.tweens.add({ targets: ln, angle: { from: -4, to: 4 }, yoyo: true, repeat: -1, duration: 2200 + i * 100, ease: 'Sine.inOut' });
          const glow = this.add.image(ln.x, ln.y + 10, 'dot').setScale(5).setTint(0xb07aff).setAlpha(0.35).setScrollFactor(0.7, 0).setDepth(-56).setBlendMode(Phaser.BlendModes.ADD);
          this.tweens.add({ targets: glow, alpha: { from: 0.25, to: 0.45 }, yoyo: true, repeat: -1, duration: 900 + i * 50 });
        }
      }
      // fog band behind walkway
      this.fog = this.add.particles(0, 0, 'dot', {
        x: { min: 0, max: G.STAGE_W }, y: { min: 300, max: 420 }, lifespan: 9000, speedX: { min: -12, max: 12 }, speedY: { min: -3, max: 3 },
        scale: { start: 6, end: 9 }, alpha: { start: 0, end: 0.0, ease: 'Sine.inOut' }, tint: 0x6b6aa8, frequency: 180, quantity: 1,
      }).setDepth(-40);
      this.fog.setParticleAlpha({ start: 0.35, end: 0 });
      // walkway ground
      const gt = this.textures.get('st_ground').getSourceImage();
      const gs = 0.64;
      this.add.tileSprite(0, G.H - gt.height * gs + 4, G.STAGE_W, Math.ceil(gt.height * gs), 'st_ground').setOrigin(0, 0).setTileScale(gs, gs).setDepth(-30);
      // props on the back edge of the walkway
      const backY = G.Y_MIN - 30;
      const props = [['st_barrel', 520, 0.5], ['st_crates', 1180, 0.48], ['st_banner', 1700, 0.55], ['st_mushrooms', 2050, 0.4], ['st_barrel', 2400, 0.45], ['st_crates', 2850, 0.5], ['st_banner', 3200, 0.6], ['st_mushrooms', 3600, 0.45], ['st_banner', 3950, 0.6]];
      for (const [k, x, s] of props) this.add.image(x, backY, k).setOrigin(0.5, 1).setScale(s).setDepth(backY - 200);
      // foreground webs (parallax > 1)
      for (let i = 0; i < 12; i++) {
        const x = i * 520 + 120;
        if (i % 2) this.add.image(x, -10, 'st_web_strand').setOrigin(0.5, 0).setScale(0.9).setScrollFactor(1.25, 0).setDepth(5000).setAlpha(0.8);
        else this.add.image(x, -20, 'st_cobweb').setOrigin(0.5, 0).setScale(0.8).setScrollFactor(1.25, 0).setDepth(5000).setAlpha(0.65).setFlipX(i % 4 === 0);
      }
      this.add.image(0, 0, 'vignette').setOrigin(0).setScrollFactor(0).setDepth(6000);
      // darkness zone visual
      this.darkGfx = this.add.graphics().setDepth(4000);
    }

    // ---------------- input
    readInput() {
      const B = BINDS[S.scheme] || BINDS.wasd, k = this.keys;
      const down = (n) => k[n] && k[n].isDown;
      let x = 0, y = 0;
      if (down(B.left)) x -= 1;
      if (down(B.right)) x += 1;
      if (down(B.up)) y -= 1;
      if (down(B.down)) y += 1;
      const J = (n) => k[n] && Phaser.Input.Keyboard.JustDown(k[n]);
      const pressed = {};
      for (const a of ACTIONS) pressed[a] = J(B[a]);
      const pad = this.input.gamepad && this.input.gamepad.total ? this.input.gamepad.getPad(0) : null;
      if (pad) {
        const ax = pad.axes.length ? pad.axes[0].getValue() : 0, ay = pad.axes.length > 1 ? pad.axes[1].getValue() : 0;
        if (Math.abs(ax) > 0.25) x = ax; if (Math.abs(ay) > 0.25) y = ay;
        if (pad.left) x = -1; if (pad.right) x = 1; if (pad.up) y = -1; if (pad.down) y = 1;
        this.padPrev = this.padPrev || {};
        const btn = (i) => { const b = pad.buttons[i]; const v = !!(b && b.pressed); const was = this.padPrev[i]; this.padPrev[i] = v; return v && !was; };
        const anyBtn = pad.buttons.some(b => b && b.pressed) || Math.abs(ax) > 0.25 || Math.abs(ay) > 0.25;
        if (anyBtn) S.usingPad = true;
        for (const a of ACTIONS) for (const i of PAD[a]) if (btn(i)) pressed[a] = true;
      }
      if (S.testInput) { x = S.testInput.x || 0; y = S.testInput.y || 0; Object.assign(pressed, S.testInput.pressed || {}); S.testInput.pressed = {}; }
      return { x, y, pressed };
    }

    update(time, delta) {
      const nowMs = performance.now();
      const dt = Math.min(0.1, Math.max(0.001, (nowMs - (this.lastMs || nowMs - 16)) / 1000));
      this.lastMs = nowMs;
      const w = S.world;
      const meP = w.players.get(S.myPid);
      S.local.update(dt, this.readInput(), S.isHost ? meP : (meP || null));
      if (!S.isHost && meP) { S.local.write(meP); }

      if (S.isHost) {
        S.sim.update(dt);
        const evs = w.events.splice(0);
        for (const e of evs) handleEvent(e);
        S.eventsOut.push(...evs);
        S.lastSnap += dt;
        if (S.lastSnap >= 0.05 && S.net) {
          S.lastSnap = 0;
          if (S.net.conns.size) S.net.broadcast(packSnapshot(S.eventsOut));
          S.eventsOut = [];
        }
      } else {
        S.lastReport += dt;
        if (S.lastReport >= 1 / 30) {
          S.lastReport = 0;
          const L = S.local;
          S.net.toHost({ t: 'st', x: Math.round(L.x), y: Math.round(L.y), z: Math.round(L.z), f: L.face, a: L.anim, p: +L.p.toFixed(2), v: L.v || 0 });
        }
        // smooth remote entities
        const k = Math.min(1, dt * 14);
        for (const P of w.players.values()) if (P.id !== S.myPid && P.tx !== undefined) { P.x = lerp(P.x, P.tx, k); P.y = lerp(P.y, P.ty, k); P.z = lerp(P.z, P.tz, k); }
        for (const E of w.enemies.values()) { E.x = lerp(E.x, E.tx, k); E.y = lerp(E.y, E.ty, k); E.z = lerp(E.z || 0, E.tz || 0, k); }
        for (const R of w.projs.values()) R.x += R.vx * dt;
      }
      this.cameras.main.scrollX = lerp(this.cameras.main.scrollX, w.camL, Math.min(1, dt * 8));
      this.renderWorld(dt, time / 1000);
      this.hud.update(dt);
    }

    // ---------------- rendering
    ensure(key, make) { let v = this.vis.get(key); if (!v) { v = make(); v.key = key; this.vis.set(key, v); } v.seen = true; return v; }

    makeActorVis(charKey, opts = {}) {
      const def = CHARS[charKey];
      const rig = new Rig(this, def, { scaleMul: opts.scaleMul || 1 });
      const shadow = this.add.image(0, 0, 'shadow').setScale(def.hover ? 0.5 : 0.9 * (opts.scaleMul || 1));
      const v = { rig, shadow, t: Math.random() * 10, def, tint: opts.tint || null, flash: 0, glow: false };
      if (opts.tint) rig.setTintAll(opts.tint);
      return v;
    }

    renderWorld(dt, now) {
      const w = S.world;
      for (const v of this.vis.values()) v.seen = false;
      // players
      for (const P of w.players.values()) {
        const v = this.ensure('p' + P.id, () => {
          const a = this.makeActorVis(P.char);
          a.name = this.add.text(0, 0, P.name, { fontFamily: 'Alegreya Sans', fontSize: 15, color: '#' + P.color.toString(16).padStart(6, '0'), stroke: '#000', strokeThickness: 4 }).setOrigin(0.5);
          a.ring = this.add.ellipse(0, 0, 70, 20).setStrokeStyle(2, P.color, 0.8);
          a.revive = this.add.graphics();
          for (const sp of Object.values(a.rig.sprites)) sp.preFX && sp.preFX.addGlow(P.color, 1.6, 0, false, 0.1, 6);
          return a;
        });
        const anim = P.state === 'down' ? 'down' : P.anim;
        this.drawActor(v, P.x, P.y, P.z || 0, P.face, { anim, p: P.p || 0, variant: P.v || 0 }, dt);
        v.name.setPosition(P.x, P.y - (v.def.hover ? 170 : 245) * (v.def.scale / 0.36) * 0.36 / v.def.scale * v.def.scale).setDepth(4500);
        v.name.y = P.y - this.actorHeight(v) - 18;
        v.ring.setPosition(P.x, P.y).setDepth(P.y - 1);
        // status tints
        let tint = null;
        if (P.poison) { tint = 0xdcffd4; if (Math.random() < dt * 10) this.emitAt(P.x + Phaser.Math.Between(-20, 20), P.y - Phaser.Math.Between(40, 160), 'dot', 0x7dff4a, 1, { speed: { min: 10, max: 40 }, gravityY: -80, scale: { start: 0.9, end: 0 }, lifespan: 700 }); }
        if (P.state === 'ok' && P.id === S.myPid && S.local.hurtT > 0.2) tint = 0xff8080;
        if (tint !== v.curTint) { v.rig.setTintAll(tint); v.curTint = tint; }
        v.rig.setAlpha(P.state === 'down' ? 0.85 : 1);
        v.revive.clear();
        if (P.state === 'down') {
          v.revive.setDepth(4600);
          v.revive.fillStyle(0x000000, 0.6).fillRect(P.x - 32, P.y - 70, 64, 8);
          v.revive.fillStyle(0x7dff8a, 1).fillRect(P.x - 31, P.y - 69, 62 * (P.revive || 0), 6);
        }
      }
      // enemies
      for (const E of w.enemies.values()) {
        const d = ENEMY[E.kind];
        const v = this.ensure('e' + E.id, () => {
          const a = this.makeActorVis(d.char, { scaleMul: d.scaleMul, tint: d.tint });
          a.bar = this.add.graphics();
          return a;
        });
        const anim = E.state === 'dying' ? 'down' : (E.state === 'down' ? 'down' : E.anim);
        this.drawActor(v, E.x, E.y, E.z || 0, E.face, { anim, p: E.p || 0, variant: (E.id % 2) }, dt);
        if (E.state === 'dying') { v.dieT = (v.dieT || 0) + dt; v.rig.setAlpha(Math.max(0, 1 - Math.max(0, v.dieT - 0.9))); v.shadow.setAlpha(Math.max(0, 1 - v.dieT)); }
        // faerie fire glow
        const ff = !!E.ff;
        if (ff !== v.glow) {
          v.glow = ff;
          for (const s of Object.values(v.rig.sprites)) { if (ff) s.preFX && s.preFX.addGlow(0xc77dff, 4, 0, false, 0.1, 12); else s.preFX && s.preFX.clear(); }
        }
        let tint = d.tint || null;
        if (E.slow) tint = 0xd2ecff;
        if (E.burn) tint = 0xffd8b8;
        if (v.flash > 0) { v.flash -= dt; tint = 'flash'; }
        if (tint !== v.curTint) {
          v.curTint = tint;
          if (tint === 'flash') for (const s of Object.values(v.rig.sprites)) s.setTintFill(0xffffff);
          else v.rig.setTintAll(tint);
        }
        // hp bar
        v.bar.clear();
        if (!d.boss && E.hp > 0 && E.hp < E.maxhp) {
          const h = this.actorHeight(v);
          v.bar.setDepth(4500).fillStyle(0x000000, 0.7).fillRect(E.x - 30, E.y - h - 12, 60, 6).fillStyle(0xd23b5a, 1).fillRect(E.x - 29, E.y - h - 11, 58 * E.hp / E.maxhp, 4);
        }
        if (E.burn && Math.random() < dt * 9) this.sprite('fx_hellfire', E.x + Phaser.Math.Between(-30, 30), E.y - Phaser.Math.Between(10, 120), { s0: 0.06, s1: 0.16, a0: 0.95, dur: 420, dy: -40, origin: [0.5, 0.9], depth: E.y + 3 });
        if (E.slow && Math.random() < dt * 8) this.emitAt(E.x + Phaser.Math.Between(-25, 25), E.y - Phaser.Math.Between(40, 160), 'spark', 0xcff4ff, 1);
      }
      // projectiles
      for (const R of w.projs.values()) {
        const v = this.ensure('r' + R.id, () => this.makeProjVis(R));
        v.obj.setPosition(R.x, R.y - R.z).setDepth(R.y + 5);
        v.obj.setFlipX(R.kind === 'spray' ? R.vx > 0 : R.vx < 0);
        if (v.gl) v.gl.setPosition(R.x, R.y - R.z).setDepth(R.y + 4).setAlpha(0.45 + 0.15 * Math.sin(now * 30));
        if (v.ground) v.ground.setPosition(R.x, R.y).setDepth(R.y - 3).setScale(v.ground.scaleX, v.ground.scaleX * 0.35);
        if (v.trail) v.trail.setPosition(R.x, R.y - R.z);
        if (v.sh) v.sh.setPosition(R.x, R.y).setDepth(R.y - 2);
      }
      // pickups
      for (const K of w.pickups.values()) {
        const v = this.ensure('k' + K.id, () => {
          const o = this.add.image(K.x, K.y - 14, 'berry').setScale(0.9);
          const gl = this.add.image(K.x, K.y - 14, 'dot').setScale(1.6).setTint(0xff5a7a).setBlendMode(Phaser.BlendModes.ADD);
          return { obj: o, gl };
        });
        const b = Math.sin(now * 4 + K.id) * 4;
        v.obj.setPosition(K.x, K.y - 16 + b).setDepth(K.y); v.gl.setPosition(K.x, K.y - 16 + b).setDepth(K.y - 1);
      }
      // darkness
      this.darkGfx.clear();
      if (w.dark) {
        for (let i = 6; i > 0; i--) { this.darkGfx.fillStyle(0x000000, 0.16); this.darkGfx.fillEllipse(w.dark.x, w.dark.y - 60, w.dark.r * 2 * (0.6 + i * 0.1), w.dark.r * 1.3 * (0.6 + i * 0.1)); }
      }
      // cleanup
      for (const [key, v] of [...this.vis]) {
        if (v.seen) continue;
        if (v.rig) { v.rig.destroy(); v.shadow.destroy(); v.name && v.name.destroy(); v.ring && v.ring.destroy(); v.bar && v.bar.destroy(); v.revive && v.revive.destroy(); }
        if (v.obj) { v.obj.destroy(); v.gl && v.gl.destroy(); v.sh && v.sh.destroy(); v.ground && v.ground.destroy(); if (v.trail) { v.trail.stop(); this.time.delayedCall(600, () => v.trail.destroy()); } }
        this.vis.delete(key);
      }
    }

    actorHeight(v) { const d = v.def; return ((d.hip + 330) * d.scale + (d.hover ? d.hover * d.scale : 0)) * (v.rig.scale / d.scale); }

    drawActor(v, x, y, z, face, st, dt) {
      if (v.stop > 0) { v.stop -= dt; dt *= 0.05; x += Math.sin(v.stop * 300) * 3; }
      v.t += dt;
      if (st.anim === 'down') { v.downT = (v.downT || 0) + dt; st.p = Math.min(1, v.downT / 0.9); } else v.downT = 0;
      if (st.anim === 'cast' && v.lastAnim !== 'cast') {
        const col = v.def.key === 'lukaris' ? 0x9dff9d : v.def.key === 'soreen' ? 0xb06bff : v.def.key === 'priestess' ? 0xd04aff : 0xff6a6a;
        this.magicCircle(x, y, col, v.def.key === 'priestess' ? 0.75 : 0.5, 650);
      }
      v.lastAnim = st.anim;
      const pose = RigAnim.animate(v.def, { anim: st.anim, t: v.t, p: st.p, speed: 1, variant: st.variant });
      v.rig.setFacing(face || 1, dt);
      v.rig.container.setPosition(x, y - z - (pose.lift || 0) * v.rig.scale);
      v.rig.apply(pose, Math.max(dt, 0.001));
      v.rig.container.setDepth(y);
      v.shadow.setPosition(x, y + 2).setDepth(y - 2);
    }

    makeProjVis(R) {
      const glow = (c, sc) => this.add.image(R.x, R.y, 'dot').setTint(c).setScale(sc).setAlpha(0.5).setBlendMode(Phaser.BlendModes.ADD);
      if (R.kind === 'ice') {
        const obj = this.add.image(R.x, R.y, 'fx_iceshard').setScale(0.32).setBlendMode(Phaser.BlendModes.ADD);
        const trail = this.add.particles(R.x, R.y, 'spark', { lifespan: 350, speed: 25, scale: { start: 0.7, end: 0 }, tint: [0xcff4ff, 0x7fc8ff], frequency: 14, blendMode: 'ADD' });
        return { obj, trail, gl: glow(0x9fe8ff, 3), ground: glow(0x6fc8ff, 3.5) };
      }
      if (R.kind === 'eb') {
        const obj = this.add.image(R.x, R.y, 'fx_ebolt').setScale(0.38).setBlendMode(Phaser.BlendModes.ADD);
        const trail = this.add.particles(R.x, R.y, 'dot', { lifespan: 300, speed: 40, scale: { start: 1.6, end: 0 }, tint: [0xd7a6ff, 0x7b2bff, 0x6bff9e], frequency: 7, blendMode: 'ADD' });
        return { obj, trail, gl: glow(0xb06bff, 2.2), ground: glow(0x9a4bff, 4) };
      }
      if (R.kind === 'bolt') {
        const obj = this.add.image(R.x, R.y, 'bolt').setScale(1.1);
        const trail = this.add.particles(R.x, R.y, 'dot', { lifespan: 260, speed: 8, scale: { start: 0.6, end: 0 }, tint: 0x8dff6a, alpha: { start: 0.6, end: 0 }, frequency: 20, blendMode: 'ADD' });
        const sh = this.add.image(R.x, R.y, 'shadow').setScale(0.3);
        return { obj, trail, sh };
      }
      const obj = this.add.image(R.x, R.y, 'fx_poison').setScale(0.4).setAlpha(0.9);
      const trail = this.add.particles(R.x, R.y, 'dot', { lifespan: 500, speed: 40, scale: { start: 2, end: 0 }, tint: [0x6bff3a, 0x2a8a1a], alpha: { start: 0.7, end: 0 }, frequency: 15 });
      return { obj, trail, ground: glow(0x6bff3a, 3) };
    }

    // ---------------- effects
    emitAt(x, y, tex, tint, n = 10, cfg = {}) {
      const em = this.add.particles(x, y, tex, Object.assign({ lifespan: 600, speed: { min: 40, max: 160 }, scale: { start: 0.8, end: 0 }, tint, blendMode: 'ADD', emitting: false }, cfg));
      em.setDepth(cfg.depth || 4400);
      em.explode(n);
      this.time.delayedCall((cfg.lifespan || 600) + 200, () => em.destroy());
      return em;
    }
    // one-shot painted effect sprite
    sprite(key, x, y, o = {}) {
      const sp = this.add.image(x, y, key).setDepth(o.depth || 4400).setBlendMode(o.blend === 'normal' ? Phaser.BlendModes.NORMAL : Phaser.BlendModes.ADD);
      sp.setScale(o.s0 !== undefined ? o.s0 : 0.3, (o.s0 !== undefined ? o.s0 : 0.3) * (o.squash || 1)).setAlpha(o.a0 !== undefined ? o.a0 : 1).setAngle(o.angle || 0);
      if (o.flip) sp.setFlipX(true);
      if (o.tint) sp.setTint(o.tint);
      if (o.origin) sp.setOrigin(o.origin[0], o.origin[1]);
      const s1 = o.s1 !== undefined ? o.s1 : 0.8;
      this.tweens.add({ targets: sp, scaleX: s1, scaleY: s1 * (o.squash || 1), alpha: o.a1 !== undefined ? o.a1 : 0, angle: (o.angle || 0) + (o.spin || 0), y: y + (o.dy || 0), x: x + (o.dx || 0),
        duration: o.dur || 450, ease: o.ease || 'Cubic.out', delay: o.delay || 0, onComplete: () => sp.destroy() });
      return sp;
    }
    screenTint(color, a, dur) {
      const r = this.add.rectangle(0, 0, G.W, G.H, color, a).setOrigin(0).setScrollFactor(0).setDepth(5900).setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({ targets: r, alpha: 0, duration: dur, onComplete: () => r.destroy() });
    }
    light(x, y, color, size = 4, dur = 400, a = 0.6) {
      const g = this.add.image(x, y, 'dot').setTint(color).setScale(size).setAlpha(a).setBlendMode(Phaser.BlendModes.ADD).setDepth(y - 3);
      this.tweens.add({ targets: g, alpha: 0, scale: size * 1.4, duration: dur, onComplete: () => g.destroy() });
    }
    magicCircle(x, y, color, size = 0.35, dur = 700) {
      const c = this.add.image(x, y, 'fx_circle').setBlendMode(Phaser.BlendModes.ADD).setDepth(y - 4).setScale(size * 0.3, size * 0.3 * 0.42).setAlpha(0);
      if (color) c.setTint(color);
      this.tweens.add({ targets: c, scaleX: size, scaleY: size * 0.42, alpha: 0.95, duration: 180, ease: 'Back.out' });
      this.tweens.add({ targets: c, alpha: 0, duration: 300, delay: dur - 300, onComplete: () => c.destroy() });
      this.light(x, y - 20, color || 0xb06bff, size * 10, dur, 0.45);
    }
    flashEnemy(id, big) {
      const v = this.vis.get('e' + id); if (!v) return;
      v.flash = 0.08; v.stop = big ? 0.09 : 0.06;
    }
    telegraph(id) {
      const v = this.vis.get('e' + id); if (!v) return;
      const p = v.rig.point('head', 'start');
      const t = this.add.text(p.x, p.y - 34, '!', { fontFamily: 'Cormorant SC', fontStyle: 'bold', fontSize: 44, color: '#ff4a4a', stroke: '#200', strokeThickness: 7 }).setOrigin(0.5).setDepth(4700).setScale(0.3);
      this.tweens.add({ targets: t, scale: 1, duration: 140, ease: 'Back.out' });
      this.tweens.add({ targets: t, y: t.y - 16, alpha: 0, duration: 380, delay: 260, onComplete: () => t.destroy() });
      // weapon glint
      const w = v.rig.point('farm');
      this.sprite('fx_spark', w.x, w.y, { s0: 0.05, s1: 0.32, dur: 300, spin: 90, tint: 0xff8080 });
    }
    fxHeal(x, y, big) {
      this.emitAt(x, y - 60, 'spark', [0x7dff8a, 0xeaffc0], big ? 30 : 14, { speed: { min: 20, max: 90 }, gravityY: -120, lifespan: 900 });
      if (big) this.sprite('fx_healcol', x, y - 90, { s0: 0.3, s1: 0.7, dur: 900, dy: -20, ease: 'Sine.out', depth: y + 2 });
    }
    fxKill(x, y) {
      this.sprite('fx_mist', x, y - 50, { s0: 0.3, s1: 0.9, dur: 1100, blend: 'normal', tint: 0x2a1640, a0: 0.8, dy: -30 });
      this.emitAt(x, y - 60, 'dot', [0x8a5aff, 0x2a1a40], 18, { lifespan: 900, scale: { start: 2, end: 0 }, blendMode: 'NORMAL', alpha: { start: 0.7, end: 0 } });
    }
    fx(e) {
      switch (e.k) {
        case 'hit':
          this.sprite('fx_spark', e.x + Phaser.Math.Between(-10, 10), e.y - (e.z || 70), { s0: 0.1, s1: 0.5, dur: 180, angle: Phaser.Math.Between(0, 90), ease: 'Quad.out' });
          this.emitAt(e.x, e.y - (e.z || 70), 'spark', 0xfff0c0, 10, { speed: { min: 160, max: 340 }, lifespan: 260 });
          this.cameras.main.shake(70, 0.004);
          break;
        case 'swing': {
          const big = e.c === 'soreen';
          const sx = e.x + e.f * (big ? 60 : 50), sy = e.y - (big ? 110 : 150);
          this.sprite('fx_slash', sx, sy, { s0: big ? 0.32 : 0.22, s1: big ? 0.42 : 0.3, dur: 200, flip: e.f < 0, angle: (e.v ? 30 : -20) * e.f, tint: big ? 0xffd9a0 : 0xd7b6ff, ease: 'Quad.out' });
          break;
        }
        case 'slash':
          this.sprite('fx_slash', e.x, e.y - 110, { s0: 0.3, s1: 0.4, dur: 200, flip: true, tint: 0xd9c7ff });
          break;
        case 'whip':
          this.sprite('fx_slash', e.x + e.f * 80, e.y - 120, { s0: 0.5, s1: 0.7, dur: 260, flip: e.f < 0, tint: 0x9dff6a });
          this.sprite('fx_poison', e.x + e.f * 150, e.y - 110, { s0: 0.2, s1: 0.45, dur: 500, flip: e.f > 0, blend: 'normal', a0: 0.8 });
          this.cameras.main.shake(120, 0.006);
          break;
        case 'iceburst':
          this.sprite('fx_iceburst', e.x, e.y - 70, { s0: 0.15, s1: 0.75, dur: 520, ease: 'Expo.out', depth: e.y + 5 });
          this.sprite('fx_snowflake', e.x, e.y - 70, { s0: 0.1, s1: 0.5, dur: 600, spin: 60 });
          this.emitAt(e.x, e.y - 60, 'shard', 0xdff8ff, 16, { speed: { min: 180, max: 420 }, rotate: { min: 0, max: 360 }, scale: { start: 0.7, end: 0.1 }, lifespan: 500, blendMode: 'NORMAL', gravityY: 500 });
          this.light(e.x, e.y - 40, 0x9fe8ff, 7, 450, 0.7);
          this.cameras.main.shake(110, 0.006);
          break;
        case 'faerie':
          for (let i = 0; i < 3; i++) this.sprite('fx_motes', e.x + (i - 1) * 110, e.y - 100 + (i % 2) * 30, { s0: 0.2, s1: 0.75, a0: 1, dur: 1300, delay: i * 90, spin: 40, ease: 'Sine.out' });
          this.magicCircle(e.x, e.y, 0x9dff9d, 0.9, 900);
          { const em = this.add.particles(e.x, e.y - 90, 'spark', { x: { min: -170, max: 170 }, y: { min: -90, max: 90 }, lifespan: 1100, speed: 10, scale: { start: 0.9, end: 0 }, tint: [0xc77dff, 0x8ad8ff, 0x9dff9d], frequency: 6, blendMode: 'ADD' }).setDepth(4400);
            this.time.delayedCall(700, () => em.stop()); this.time.delayedCall(1900, () => em.destroy()); }
          break;
        case 'word':
          this.magicCircle(e.x, e.y, 0x7dff8a, 1.2, 800);
          this.floatText(e.x, e.y - 190, '«Встаньте!»', '#bfffbf', 22);
          break;
        case 'healcol':
          this.sprite('fx_healcol', e.x, e.y - 100, { s0: (e.s || 0.5) * 0.5, s1: e.s || 0.5, a0: 1, dur: 950, dy: -25, ease: 'Sine.out', depth: e.y + 2 });
          this.light(e.x, e.y - 20, 0x7dff8a, 5, 700, 0.5);
          break;
        case 'cure': this.fxHeal(e.x, e.y, true); break;
        case 'berries': this.sprite('fx_motes', e.x, e.y - 50, { s0: 0.1, s1: 0.4, dur: 700, tint: 0xff8090 }); break;
        case 'mist':
          this.sprite('fx_mist', e.x, e.y - 60, { s0: 0.15, s1: 0.6, a0: 0.95, dur: 750, blend: 'normal', dy: -20 });
          this.light(e.x, e.y - 40, 0xc8b8ff, 4, 500, 0.5);
          break;
        case 'ebhit':
          this.sprite('fx_spark', e.x, e.y - (e.z || 100), { s0: 0.1, s1: 0.5, dur: 220, tint: 0xd7a6ff });
          this.sprite('fx_motes', e.x, e.y - (e.z || 100), { s0: 0.1, s1: 0.35, dur: 400, tint: 0xb06bff });
          this.emitAt(e.x, e.y - (e.z || 100), 'dot', [0xd7a6ff, 0x7b2bff, 0x6bff9e], 16, { speed: { min: 100, max: 280 }, lifespan: 320 });
          this.light(e.x, e.y - 30, 0xb06bff, 4, 300, 0.6);
          break;
        case 'frost':
          this.sprite('fx_snowflake', e.x, e.y - 110, { s0: 0.05, s1: 0.42, a0: 1, dur: 700, spin: 90, ease: 'Back.out' });
          this.emitAt(e.x, e.y - 100, 'spark', [0xffffff, 0x9fe8ff], 22, { speed: { min: 30, max: 140 }, lifespan: 700 });
          this.light(e.x, e.y - 30, 0x9fe8ff, 4, 500, 0.6);
          break;
        case 'frostmiss': this.sprite('fx_snowflake', e.x, e.y - 100, { s0: 0.05, s1: 0.25, dur: 400 }); break;
        case 'rebuke':
          this.sprite('fx_hellfire', e.x, e.y - 30, { s0: 0.2, s1: 0.75, a0: 1, dur: 800, dy: -40, origin: [0.5, 0.9], depth: e.y + 5, ease: 'Expo.out' });
          this.sprite('fx_hellfire', e.x + 30, e.y - 20, { s0: 0.1, s1: 0.5, a0: 1, dur: 900, delay: 100, dy: -50, origin: [0.5, 0.9], depth: e.y + 6 });
          this.emitAt(e.x, e.y - 80, 'dot', [0xff6a1a, 0xffc04a, 0x6bff4a], 40, { speed: { min: 60, max: 240 }, gravityY: -260, scale: { start: 2.2, end: 0 }, lifespan: 800 });
          this.light(e.x, e.y - 30, 0xff8a2a, 8, 700, 0.8);
          this.screenTint(0xff8a2a, 0.22, 220);
          this.cameras.main.shake(180, 0.01);
          break;
        case 'darkness': break;
      }
    }
    floatText(x, y, s, color, size = 24) {
      const t = this.add.text(x + Phaser.Math.Between(-10, 10), y, s, { fontFamily: 'Cormorant SC, serif', fontStyle: 'bold', fontSize: size, color, stroke: '#000', strokeThickness: 5 }).setOrigin(0.5).setDepth(4800);
      this.tweens.add({ targets: t, y: y - 50, alpha: { from: 1, to: 0 }, duration: 900, ease: 'Cubic.out', onComplete: () => t.destroy() });
    }
    banner(text, big) { this.hud && this.hud.banner(text, big); this.pendingBanner = this.hud ? null : [text, big]; }
    showGo() { this.hud.go(); }
    win() { this.hud.win(); }
  }

  // ------------------------------------------------------------------ HUD (painted frames, portraits, skill icons)
  const FRAME = { // interior rectangles measured on the painted frames (x, y, w, h in source pixels)
    hpbar: [965, 230, 152, 104, 718, 58], bossbar: [1020, 384, 103, 182, 841, 56], slot: [170, 188, 33, 41, 106, 103],
    medallion: [476, 490, 87, 91, 291, 289], plaque: [1017, 345, 126, 103, 783, 154], nameplate: [456, 200, 66, 80, 341, 76],
  };
  // place a frame so that its interior lands on (x, y, w); returns {img, inner:{x,y,w,h}}
  function frameAt(sc, key, x, y, w, depth) {
    const [fw, fh, ix, iy, iw, ih] = FRAME[key];
    const k = w / iw;
    const img = sc.add.image(x - ix * k, y - iy * k, 'ui_' + key).setOrigin(0, 0).setScale(k).setScrollFactor(0).setDepth(depth);
    return { img, k, inner: { x, y, w: iw * k, h: ih * k } };
  }
  const TXT = (size, color = '#f3e6c8') => ({ fontFamily: 'Cormorant SC, serif', fontStyle: 'bold', fontSize: size, color, stroke: '#0b0612', strokeThickness: Math.max(3, size / 5) });

  class HUD {
    constructor(sc) {
      this.sc = sc;
      this.g = sc.add.graphics().setScrollFactor(0).setDepth(9020);
      this.panels = new Map();
      // banner on a painted plaque
      const pl = frameAt(sc, 'plaque', G.W / 2 - 230, 150, 460, 9100);
      this.plaque = pl.img.setAlpha(0);
      this.bannerText = sc.add.text(G.W / 2, 150 + pl.inner.h / 2, '', Object.assign(TXT(24, '#ffe3a0'), { align: 'center', wordWrap: { width: 470 } })).setOrigin(0.5).setScrollFactor(0).setDepth(9101).setAlpha(0);
      this.goText = sc.add.text(G.W - 120, G.H / 2 - 40, 'ВПЕРЁД ➜', TXT(44, '#ffd36b')).setOrigin(0.5).setScrollFactor(0).setDepth(9100).setAlpha(0);
      // boss bar
      const bb = frameAt(sc, 'bossbar', G.W / 2 - 250, G.H - 46, 500, 9030);
      this.boss = { frame: bb.img.setVisible(false), inner: bb.inner, name: sc.add.text(G.W / 2, G.H - 70, '', TXT(22, '#f0c8ff')).setOrigin(0.5).setScrollFactor(0).setDepth(9101) };
      // skill bar (local player)
      this.skills = [];
      const L = S.local, h = HEROES[L.char];
      const acts = ['melee', 'k', 'l', 'i', 'o', 'u', 'dash'].filter(a => h.skills[a]);
      acts.forEach((act, j) => {
        const cx = 54 + j * 76, cy = G.H - 62;
        const icon = sc.add.image(cx, cy, 'ui_icon_' + h.skills[act].icon).setScrollFactor(0).setDepth(9040).setDisplaySize(50, 50);
        const fr = frameAt(sc, 'slot', cx - 27, cy - 26, 54, 9045);
        const badge = sc.add.circle(cx + 21, cy - 21, 10, 0x140c20, 0.95).setStrokeStyle(1.5, 0xc9a04e).setScrollFactor(0).setDepth(9058);
        const key = sc.add.text(cx + 21, cy - 22, '', TXT(13, '#ffd36b')).setOrigin(0.5).setScrollFactor(0).setDepth(9060);
        const name = sc.add.text(cx, cy + 40, h.skills[act].name, { fontFamily: 'Alegreya Sans', fontSize: 11, color: '#e8dcc0', stroke: '#000', strokeThickness: 3, align: 'center', wordWrap: { width: 74 } }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(9060);
        const cdText = sc.add.text(cx, cy, '', TXT(18, '#ffffff')).setOrigin(0.5).setScrollFactor(0).setDepth(9061);
        this.skills.push({ act, cx, cy, icon, frame: fr.img, key, name, cdText, wasReady: true });
      });
      this.passive = sc.add.text(54 + acts.length * 76 - 18, G.H - 92, '', { fontFamily: 'Alegreya Sans', fontStyle: 'bold', fontSize: 15, color: '#ffb050', stroke: '#000', strokeThickness: 4 }).setScrollFactor(0).setDepth(9060);
      this.netText = sc.add.text(G.W - 12, G.H - 18, '', { fontFamily: 'monospace', fontSize: 12, color: '#9a90b0', stroke: '#000', strokeThickness: 3 }).setOrigin(1, 1).setScrollFactor(0).setDepth(9100);
      if (sc.pendingBanner) this.banner(...sc.pendingBanner);
    }
    banner(text, big) {
      const t = this.bannerText, sc = this.sc;
      t.setText(text).setFontSize(big ? 22 : 19);
      sc.tweens.killTweensOf([t, this.plaque]);
      t.setAlpha(0).setScale(0.9); this.plaque.setAlpha(0);
      sc.tweens.add({ targets: [t, this.plaque], alpha: 1, duration: 200 });
      sc.tweens.add({ targets: t, scale: 1, duration: 260, ease: 'Back.out' });
      sc.tweens.add({ targets: [t, this.plaque], alpha: 0, delay: big ? 2800 : 1700, duration: 500 });
    }
    go() {
      const t = this.goText; t.setAlpha(1);
      this.sc.tweens.killTweensOf(t);
      this.sc.tweens.add({ targets: t, x: { from: G.W - 140, to: G.W - 100 }, yoyo: true, repeat: 4, duration: 350, onComplete: () => this.sc.tweens.add({ targets: t, alpha: 0, duration: 400 }) });
    }
    win() {
      const sc = this.sc;
      const pl = frameAt(sc, 'plaque', G.W / 2 - 380, G.H / 2 - 70, 760, 9190);
      const t = sc.add.text(G.W / 2, G.H / 2 - 20, 'ПОБЕГ УДАЛСЯ', TXT(60, '#ffd36b')).setOrigin(0.5).setScrollFactor(0).setDepth(9200);
      const s2 = sc.add.text(G.W / 2, G.H / 2 + 30, 'Конец пробной главы · продолжение следует', { fontFamily: 'Alegreya Sans', fontSize: 20, color: '#fff', stroke: '#000', strokeThickness: 5 }).setOrigin(0.5).setScrollFactor(0).setDepth(9200);
      for (const o of [pl.img, t, s2]) { o.setAlpha(0); sc.tweens.add({ targets: o, alpha: 1, duration: 600 }); }
      t.setScale(0.6); sc.tweens.add({ targets: t, scale: 1, duration: 700, ease: 'Back.out' });
    }
    makePanel(P, i) {
      const sc = this.sc, x = 10 + i * 318, y = 10;
      const portraitKey = 'ui_portrait_' + P.char;
      const portrait = sc.add.image(x + 46, y + 46, portraitKey).setScrollFactor(0).setDepth(9030).setDisplaySize(76, 76);
      const med = frameAt(sc, 'medallion', x + 9, y + 9, 74, 9050);
      const np = frameAt(sc, 'nameplate', x + 110, y + 12, 140, 9035);
      const name = sc.add.text(x + 110 + 70, y + 12 + np.inner.h / 2, P.name, TXT(17)).setOrigin(0.5).setScrollFactor(0).setDepth(9060);
      const hp = frameAt(sc, 'hpbar', x + 104, y + 52, 168, 9045);
      const hpText = sc.add.text(x + 104 + 84, y + 52 + hp.inner.h / 2, '', { fontFamily: 'Alegreya Sans', fontStyle: 'bold', fontSize: 11, color: '#fff', stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setScrollFactor(0).setDepth(9060);
      const ring = sc.add.ellipse(x + 46, y + 46, 80, 80).setStrokeStyle(3, P.color, 0.9).setScrollFactor(0).setDepth(9049);
      return { x, y, portrait, med: med.img, np: np.img, name, hp, hpText, ring, shown: P.hp, char: P.char };
    }
    destroyPanel(pn) { for (const o of [pn.portrait, pn.med, pn.np, pn.name, pn.hp.img, pn.hpText, pn.ring]) o.destroy(); }
    update(dt) {
      const g = this.g, w = S.world, sc = this.sc;
      g.clear();
      let i = 0;
      const seen = new Set();
      for (const P of w.players.values()) {
        seen.add(P.id);
        let pn = this.panels.get(P.id);
        if (pn && pn.idx !== i) { this.destroyPanel(pn); pn = null; }
        if (!pn) { pn = this.makePanel(P, i); pn.idx = i; this.panels.set(P.id, pn); }
        const frac = Math.max(0, P.hp / P.maxhp);
        pn.shown += (frac - pn.shown) * Math.min(1, dt * 3);   // trailing damage bar
        const r = pn.hp.inner;
        g.fillStyle(0x12060c, 1).fillRect(r.x, r.y, r.w, r.h);
        g.fillStyle(0xd8a040, 0.9).fillRect(r.x, r.y, r.w * Math.max(frac, pn.shown), r.h);
        const col = frac > 0.5 ? 0x3fbf5a : frac > 0.25 ? 0xd9a43a : 0xd8402e;
        g.fillGradientStyle(col, col, Phaser.Display.Color.ValueToColor(col).darken(35).color, Phaser.Display.Color.ValueToColor(col).darken(35).color, 1);
        g.fillRect(r.x, r.y, r.w * frac, r.h);
        g.fillStyle(0xffffff, 0.18).fillRect(r.x, r.y, r.w * frac, r.h * 0.35);
        pn.hpText.setText(Math.ceil(P.hp) + ' / ' + P.maxhp);
        if (P.char === 'soreen') {
          const rb = Math.min(1, P.rebuke || 0);
          g.fillStyle(0x000000, 0.75).fillRoundedRect(r.x, r.y + r.h + 8, r.w, 6, 3);
          g.fillStyle(rb >= 1 ? 0xff9a2a : 0x8a4a1a, 1).fillRoundedRect(r.x, r.y + r.h + 8, Math.max(6, r.w * rb), 6, 3);
          if (rb >= 1) { g.fillStyle(0xffd080, 0.3 + 0.3 * Math.sin(sc.time.now / 120)).fillRoundedRect(r.x - 2, r.y + r.h + 6, r.w + 4, 10, 5); }
        }
        pn.portrait.setAlpha(P.state === 'down' ? 0.35 : 1);
        pn.portrait.setTint(P.state === 'down' ? 0x808080 : (P.poison ? 0xb8ffb0 : 0xffffff));
        pn.name.setText(P.state === 'down' ? P.name + ' ✝' : P.name);
        i++;
      }
      for (const [id, pn] of [...this.panels]) if (!seen.has(id)) { this.destroyPanel(pn); this.panels.delete(id); }

      // skills
      const L = S.local, h = HEROES[L.char];
      const B = BINDS[S.scheme] || BINDS.wasd;
      for (const sk of this.skills) {
        const cd = Math.max(0, L.cds[sk.act] || 0), tot = h.skills[sk.act].cd;
        sk.key.setText(S.usingPad ? PADLBL[sk.act] : KEYLBL(B[sk.act]));
        if (cd > 0) {
          g.fillStyle(0x000000, 0.62); g.slice(sk.cx, sk.cy, 25, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (cd / tot), false); g.fillPath();
          sk.icon.setTint(0x8a8a9a);
          sk.cdText.setText(tot >= 2 ? Math.ceil(cd) : '');
        } else { sk.icon.clearTint(); sk.cdText.setText(''); }
        const ready = cd <= 0;
        if (ready && !sk.wasReady && tot >= 2) {   // "ready" flash
          const fl = sc.add.image(sk.cx, sk.cy, 'dot').setScale(4).setTint(0xffe9a0).setBlendMode(Phaser.BlendModes.ADD).setScrollFactor(0).setDepth(9070);
          sc.tweens.add({ targets: fl, alpha: 0, scale: 6, duration: 350, onComplete: () => fl.destroy() });
        }
        sk.wasReady = ready;
      }
      const me = w.players.get(S.myPid);
      if (L.char === 'soreen' && me) this.passive.setText(me.rebuke >= 1 ? '🔥 Адское возмездие готово' : 'Адское возмездие ' + Math.round((me.rebuke || 0) * 100) + '%').setColor(me.rebuke >= 1 ? '#ffb050' : '#b08060');
      else this.passive.setText('');

      // boss
      const boss = [...w.enemies.values()].find(e => ENEMY[e.kind].boss && e.hp > 0);
      this.boss.frame.setVisible(!!boss);
      if (boss) {
        const r = this.boss.inner, f = boss.hp / boss.maxhp;
        this.bossShown = this.bossShown === undefined ? f : this.bossShown + (f - this.bossShown) * Math.min(1, dt * 2.5);
        g.fillStyle(0x12060c, 1).fillRect(r.x, r.y, r.w, r.h);
        g.fillStyle(0xe8c070, 0.9).fillRect(r.x, r.y, r.w * Math.max(f, this.bossShown), r.h);
        g.fillGradientStyle(0xb04aff, 0xb04aff, 0x4a1078, 0x4a1078, 1).fillRect(r.x, r.y, r.w * f, r.h);
        g.fillStyle(0xffffff, 0.2).fillRect(r.x, r.y, r.w * f, r.h * 0.35);
        this.boss.name.setText(ENEMY[boss.kind].name);
      } else this.boss.name.setText('');
      this.netText.setText((S.isHost ? 'хост · комната ' + (S.net && S.net.code || '') : 'гость') + ' · игроков: ' + w.players.size);
    }
  }
})();
