// Host-authoritative simulation: enemies, projectiles, combat resolution, waves.
(function () {
  const G = window.GCONST = {
    W: 1280, H: 720, STAGE_W: 4300, Y_MIN: 530, Y_MAX: 668, LANE: 26,
    SEGS: [
      { x0: 0, x1: 1280, trigger: 380, wave: 'w1' },
      { x0: 1500, x1: 2780, trigger: 1850, wave: 'w2' },
      { x0: 3020, x1: 4300, trigger: 3350, wave: 'boss' },
    ],
    COLORS: [0xffd36b, 0x6bdcff, 0xff7ad9, 0x8dff8a],
  };

  const ENEMY = {
    warrior: { char: 'drow', hp: 55, speed: 150, reach: 120, dmg: 9, wind: 0.45, cd: [1.1, 2.0], name: 'Дроу-страж' },
    xbow: { char: 'drowxbow', hp: 38, speed: 140, reach: 520, dmg: 6, wind: 0.6, cd: [2.2, 3.4], name: 'Дроу-арбалетчик' },
    elite: { char: 'drow', hp: 110, speed: 175, reach: 130, dmg: 13, wind: 0.38, cd: [0.9, 1.6], name: 'Элитный дроу', scaleMul: 1.12, tint: 0xd9b3ff },
    priestess: { char: 'priestess', hp: 520, speed: 115, reach: 250, dmg: 15, wind: 0.6, cd: [1.4, 2.2], name: 'Жрица Ильвара', boss: true },
  };
  window.ENEMY = ENEMY;

  const WAVES = {
    w1: [['warrior', 'R'], ['warrior', 'R'], ['warrior', 'L'], ['warrior', 'R', 2.5], ['xbow', 'R', 4]],
    w2: [['warrior', 'R'], ['xbow', 'R'], ['warrior', 'L'], ['elite', 'R', 3], ['xbow', 'L', 4], ['warrior', 'R', 6], ['warrior', 'L', 6]],
    boss: [['priestess', 'R'], ['warrior', 'L', 1], ['xbow', 'R', 1.5]],
  };

  const rnd = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class Sim {
    constructor(world) { this.w = world; }

    nid() { return this.w.nextId++; }
    ev(e) { this.w.events.push(e); }
    alivePlayers() { return [...this.w.players.values()].filter(p => p.state === 'ok'); }
    scaleHp() { return 1 + 0.7 * Math.max(0, this.w.players.size - 1); }

    spawnEnemy(kind, side) {
      const d = ENEMY[kind], w = this.w;
      const seg = G.SEGS[w.seg];
      const x = side === 'L' ? seg.x0 - 80 : seg.x1 + 80;
      const e = {
        id: this.nid(), kind, x, y: rnd(G.Y_MIN + 20, G.Y_MAX - 20), z: 0, face: side === 'L' ? 1 : -1,
        hp: Math.round(d.hp * this.scaleHp()), maxhp: Math.round(d.hp * this.scaleHp()),
        anim: 'walk', p: 0, t: 0, state: 'enter', st: 0, cd: rnd(0.8, 1.6), target: null,
        ff: 0, slow: 0, frost: false, burn: 0, burnTick: 0, stun: 0, kx: 0, dark: 0, special: 6, summon: 14,
        offY: rnd(-1, 1),
      };
      w.enemies.set(e.id, e);
      return e;
    }

    startWave(name) {
      const w = this.w;
      w.pending = WAVES[name].map(([k, s, delay]) => ({ k, s, at: w.time + (delay || 0) + Math.random() * 0.6 }));
      for (let i = 2; i < w.players.size; i++) w.pending.push({ k: i === 3 ? 'xbow' : 'warrior', s: i % 2 ? 'L' : 'R', at: w.time + 3 + i });
      if (name === 'boss') this.ev({ e: 'msg', text: 'Жрица Ильвара: «Рабы сбежали? Ллос будет пировать!»', big: true });
      else if (name === 'w1') this.ev({ e: 'msg', text: 'Тревога! Стража Велкинвильва!' });
      else this.ev({ e: 'msg', text: 'Подкрепление дроу с подвесных мостов!' });
    }

    // ---------- damage helpers ----------
    hurtEnemy(e, dmg, opts = {}) {
      if (!e || e.hp <= 0) return;
      let mul = 1;
      if (e.ff > 0) mul *= 1.35;            // Faerie Fire: attacks have advantage
      if (opts.fromPid) {
        const p = this.w.players.get(opts.fromPid);
        if (p && p.dark > 0) mul *= 0.6;     // attacker blinded by Darkness
      }
      const v = Math.max(1, Math.round(dmg * mul));
      e.hp -= v;
      this.ev({ e: 'dmg', x: e.x, y: e.y, z: e.z + 120, v, c: opts.type || 'phys', id: e.id });
      const boss = ENEMY[e.kind].boss;
      if (opts.knock && !boss) e.kx = opts.knock * (opts.dir || 1);
      if (opts.knock && boss) e.kx = opts.knock * 0.25 * (opts.dir || 1);
      if (e.hp <= 0) {
        e.hp = 0; e.state = 'dying'; e.st = 0; e.anim = 'down';
        this.ev({ e: 'kill', id: e.id, x: e.x, y: e.y });
        return;
      }
      if (opts.stun || (!boss && dmg >= 4)) {
        if (opts.down && !boss) { e.state = 'down'; e.st = 1.0; e.anim = 'down'; }
        else if (e.state !== 'down') { e.state = 'hurt'; e.st = boss ? 0.12 : (opts.stun || 0.28); e.anim = 'hurt'; }
      }
    }

    hurtPlayer(p, dmg, src, opts = {}) {
      if (!p || p.state !== 'ok' || p.inv > 0) return;
      let v = dmg * (this.w.players.size === 1 ? 0.7 : 1);
      if (src && src.frost) { v *= 0.5; src.frost = false; }
      v = Math.max(1, Math.round(v));
      p.hp -= v;
      this.ev({ e: 'dmg', x: p.x, y: p.y, z: p.z + 100, v, c: 'enemy' });
      this.ev({ e: 'hurt', pid: p.id, kx: (opts.knock || 120) * (src ? Math.sign(p.x - src.x) || 1 : 1) });
      if (opts.poison) { p.poison = Math.max(p.poison || 0, opts.poison); }
      // Hellish Rebuke (warlock reaction)
      if (p.char === 'soreen' && p.rebuke >= 1 && src && src.hp > 0) {
        p.rebuke = 0;
        this.ev({ e: 'fx', k: 'rebuke', x: src.x, y: src.y, z: 60, id: src.id });
        this.hurtEnemy(src, 24, { type: 'fire', fromPid: p.id, stun: 0.5 });
        src.burn = 4;
        this.ev({ e: 'msg', text: 'Адское возмездие!', small: true, pid: p.id });
      }
      if (p.hp <= 0) {
        p.hp = 0; p.state = 'down'; p.revive = 0; p.downT = 0;
        this.ev({ e: 'msg', text: p.name + ' падает!', small: true });
      }
    }

    healPlayer(p, v, revive) {
      if (!p) return;
      if (p.state === 'down') {
        if (!revive) return;
        p.state = 'ok'; p.hp = Math.max(1, Math.round(p.maxhp * 0.3)); p.inv = 1.5;
        this.ev({ e: 'revive', pid: p.id, x: p.x, y: p.y });
      }
      const before = p.hp;
      p.hp = Math.min(p.maxhp, p.hp + v);
      this.ev({ e: 'heal', x: p.x, y: p.y, z: p.z + 100, v: Math.round(p.hp - before) });
    }

    meleeBox(p, reach, depth, back = 10) {
      return [...this.w.enemies.values()].filter(e => {
        if (e.hp <= 0 || e.state === 'down') return false;
        const dx = (e.x - p.x) * p.face;
        return dx > -back && dx < reach && Math.abs(e.y - p.y) < depth;
      });
    }

    // ---------- player actions (from any player, already validated by their client) ----------
    action(pid, a) {
      const w = this.w, p = w.players.get(pid);
      if (!p || p.state !== 'ok') return;
      const f = p.face;
      if (p.char === 'lukaris') {
        if (a.s === 'melee') this.ev({ e: 'fx', k: 'swing', x: p.x, y: p.y, f, c: 'lukaris', v: a.v });
        switch (a.s) {
          case 'melee': {
            const hit = this.meleeBox(p, 105, 30);
            for (const e of hit) this.hurtEnemy(e, a.v === 1 ? 9 : 7, { knock: a.v === 1 ? 140 : 50, dir: f, fromPid: pid, down: a.v === 1 && Math.random() < 0.3 });
            if (hit.length) this.ev({ e: 'fx', k: 'hit', x: hit[0].x, y: hit[0].y, z: 70 });
            break;
          }
          case 'k': // Ice Knife
            this.addProj('ice', p, { vx: 720 * f, dmg: 9, life: 0.85, z: p.z + 55 });
            break;
          case 'l': { // Faerie Fire: 20-ft cube in front
            const cx = p.x + f * 200;
            for (const e of w.enemies.values()) if (e.hp > 0 && Math.abs(e.x - cx) < 170 && Math.abs(e.y - p.y) < 80) e.ff = 8;
            this.ev({ e: 'fx', k: 'faerie', x: cx, y: p.y });
            break;
          }
          case 'i': { // Healing Word
            for (const q of w.players.values()) if (Math.hypot(q.x - p.x, (q.y - p.y) * 1.5) < 460) { this.healPlayer(q, 14, true); this.ev({ e: 'fx', k: 'healcol', x: q.x, y: q.y, s: 0.5 }); }
            this.ev({ e: 'fx', k: 'word', x: p.x, y: p.y });
            break;
          }
          case 'o': { // Cure Wounds (touch)
            let best = null, bd = 1e9;
            for (const q of w.players.values()) {
              if (q.id === p.id) continue;
              const d = Math.hypot(q.x - p.x, (q.y - p.y) * 1.5);
              if (d < 150 && (q.hp / q.maxhp) < 0.999 && d < bd) { bd = d; best = q; }
            }
            this.healPlayer(best || p, 34, true);
            this.ev({ e: 'fx', k: 'healcol', x: (best || p).x, y: (best || p).y, s: 0.8 });
            break;
          }
          case 'u': // Goodberry
            for (let i = 0; i < 4; i++) {
              const id = this.nid();
              w.pickups.set(id, { id, kind: 'berry', x: clamp(p.x + rnd(-110, 110), w.camL + 40, w.camL + G.W - 40), y: clamp(p.y + rnd(-50, 50), G.Y_MIN, G.Y_MAX), t: 0 });
            }
            this.ev({ e: 'fx', k: 'berries', x: p.x, y: p.y });
            break;
          case 'dash':
            this.ev({ e: 'fx', k: 'mist', x: a.fx, y: a.fy });
            this.ev({ e: 'fx', k: 'mist', x: p.x, y: p.y });
            break;
        }
      } else if (p.char === 'soreen') {
        if (a.s === 'melee') this.ev({ e: 'fx', k: 'swing', x: p.x, y: p.y, f, c: 'soreen', v: a.v });
        switch (a.s) {
          case 'melee': {
            const hit = this.meleeBox(p, 120, 30);
            for (const e of hit) this.hurtEnemy(e, 5, { knock: 300, dir: f, fromPid: pid, stun: 0.45 });
            if (hit.length) this.ev({ e: 'fx', k: 'hit', x: hit[0].x, y: hit[0].y, z: 80 });
            break;
          }
          case 'k': // Eldritch Blast
            this.addProj('eb', p, { vx: 1150 * f, dmg: 11, life: 0.6, z: p.z + 120 });
            break;
          case 'l': { // Frostbite: nearest enemy in front, CON save
            let best = null, bd = 1e9;
            for (const e of w.enemies.values()) {
              if (e.hp <= 0) continue;
              const dx = (e.x - p.x) * f;
              if (dx > -20 && dx < 650 && Math.abs(e.y - p.y) < 70 && dx < bd) { bd = dx; best = e; }
            }
            if (best) {
              this.hurtEnemy(best, 6, { type: 'cold', fromPid: pid, stun: 0.2 });
              best.slow = 3.5; best.frost = true;
              this.ev({ e: 'fx', k: 'frost', x: best.x, y: best.y, id: best.id });
            } else this.ev({ e: 'fx', k: 'frostmiss', x: p.x + f * 250, y: p.y });
            break;
          }
          case 'dash': break;
        }
      }
    }

    addProj(kind, owner, o) {
      const id = this.nid();
      this.w.projs.set(id, { id, kind, team: o.team || 'p', owner: owner.id, x: owner.x + Math.sign(o.vx) * 40, y: owner.y, z: o.z, vx: o.vx, dmg: o.dmg, life: o.life, t: 0 });
    }

    explodeIce(x, y, pid) {
      for (const e of this.w.enemies.values()) {
        if (e.hp <= 0) continue;
        if (Math.hypot(e.x - x, (e.y - y) * 2) < 110) this.hurtEnemy(e, 7, { type: 'cold', fromPid: pid, stun: 0.25 });
      }
      this.ev({ e: 'fx', k: 'iceburst', x, y });
    }

    // ---------- main tick ----------
    update(dt) {
      const w = this.w;
      w.time += dt;
      const players = [...w.players.values()];
      const alive = players.filter(p => p.state === 'ok');

      // players: timers, rebuke, poison, revive, berries
      for (const p of players) {
        if (p.inv > 0) p.inv -= dt;
        if (p.dark > 0) p.dark -= dt;
        if (p.char === 'soreen' && p.state === 'ok') p.rebuke = Math.min(1, (p.rebuke || 0) + dt / 12);
        if (p.poison > 0 && p.state === 'ok') {
          p.poison -= dt; p.pTick = (p.pTick || 0) + dt;
          if (p.pTick >= 1) { p.pTick = 0; p.hp -= 2; this.ev({ e: 'dmg', x: p.x, y: p.y, z: p.z + 100, v: 2, c: 'poison' }); if (p.hp <= 0) { p.hp = 0; p.state = 'down'; p.revive = 0; } }
        }
        if (p.state === 'down') {
          p.downT = (p.downT || 0) + dt;
          let helping = 0;
          for (const q of alive) if (Math.hypot(q.x - p.x, (q.y - p.y) * 1.5) < 90) helping = Math.max(helping, q.char === 'lukaris' ? 3 : 1);
          p.revive = helping ? p.revive + dt * helping / 3 : Math.max(0, p.revive - dt * 0.5);
          if (p.revive >= 1) this.healPlayer(p, 0, true);
        }
      }
      for (const k of w.pickups.values()) {
        k.t += dt;
        for (const p of alive) if (Math.hypot(p.x - k.x, (p.y - k.y) * 1.5) < 45 && p.hp < p.maxhp) { this.healPlayer(p, 8); w.pickups.delete(k.id); break; }
        if (k.t > 25) w.pickups.delete(k.id);
      }

      // game over / restart
      if (players.length && !alive.length && w.phase !== 'over' && w.phase !== 'win') {
        w.phase = 'over'; w.overT = 0;
        this.ev({ e: 'msg', text: 'Партия пала… Ллос довольна. Возвращаемся к началу участка.', big: true });
      }
      if (w.phase === 'over') {
        w.overT += dt;
        if (w.overT > 4) this.restartSegment();
        return;
      }

      // wave progression
      const seg = G.SEGS[w.seg];
      const lead = alive.length ? Math.max(...alive.map(p => p.x)) : 0;
      if (w.phase === 'walk' && seg && lead > seg.trigger) {
        w.phase = 'fight'; w.lock = true; w.camL = seg.x0; this.startWave(seg.wave);
      }
      if (w.pending && w.pending.length) {
        w.pending = w.pending.filter(s => { if (w.time >= s.at) { this.spawnEnemy(s.k, s.s); return false; } return true; });
      }
      if (w.phase === 'fight' && !(w.pending && w.pending.length) && ![...w.enemies.values()].some(e => e.hp > 0)) {
        w.lock = false;
        if (w.seg >= G.SEGS.length - 1) { w.phase = 'win'; this.ev({ e: 'msg', text: 'Велкинвильв позади. Впереди — Подземье…', big: true, win: true }); }
        else { w.seg++; w.phase = 'walk'; this.ev({ e: 'go' }); }
      }

      // camera (host decides)
      const avg = alive.length ? alive.reduce((s, p) => s + p.x, 0) / alive.length : w.camL + G.W / 2;
      if (!w.lock) {
        const nextSeg = G.SEGS[w.seg];
        const maxL = nextSeg ? nextSeg.x0 : G.STAGE_W - G.W;
        const want = clamp(avg - G.W / 2, 0, maxL);
        if (want > w.camL) w.camL += Math.min(want - w.camL, 600 * dt);
      }
      w.camL = clamp(w.camL, 0, G.STAGE_W - G.W);

      // enemies
      for (const e of w.enemies.values()) this.enemyTick(e, dt, alive);
      for (const e of [...w.enemies.values()]) if (e.state === 'dying' && e.st > 2.2) w.enemies.delete(e.id);

      this.darknessTick();
      // projectiles
      for (const pr of [...w.projs.values()]) {
        pr.t += dt; pr.x += pr.vx * dt;
        let hit = null;
        if (pr.team === 'p') {
          for (const e of w.enemies.values()) {
            if (e.hp <= 0 || e.state === 'down') continue;
            if (Math.abs(e.x - pr.x) < 40 && Math.abs(e.y - pr.y) < 30) { hit = e; break; }
          }
          if (hit) {
            if (pr.kind === 'ice') { this.hurtEnemy(hit, pr.dmg, { fromPid: pr.owner }); this.explodeIce(pr.x, pr.y, pr.owner); }
            else if (pr.kind === 'eb') { this.hurtEnemy(hit, pr.dmg, { type: 'force', knock: 70, dir: Math.sign(pr.vx), fromPid: pr.owner }); this.ev({ e: 'fx', k: 'ebhit', x: hit.x, y: hit.y, z: pr.z }); }
            w.projs.delete(pr.id); continue;
          }
        } else {
          for (const p of alive) if (Math.abs(p.x - pr.x) < 34 && Math.abs(p.y - pr.y) < 26 && p.inv <= 0) { hit = p; break; }
          if (hit) {
            const src = w.enemies.get(pr.owner);
            if (pr.kind === 'bolt') this.hurtPlayer(hit, pr.dmg, src, { knock: 60, poison: 3 });
            else if (pr.kind === 'spray') this.hurtPlayer(hit, pr.dmg, src, { knock: 90, poison: 4 });
            w.projs.delete(pr.id); continue;
          }
        }
        if (pr.t > pr.life) {
          if (pr.kind === 'ice') this.explodeIce(pr.x, pr.y, pr.owner);
          w.projs.delete(pr.id);
        }
      }
    }

    restartSegment() {
      const w = this.w;
      w.enemies.clear(); w.projs.clear(); w.pending = [];
      const seg = G.SEGS[w.seg];
      w.phase = 'walk'; w.lock = false;
      w.camL = seg.x0;
      let i = 0;
      for (const p of w.players.values()) {
        p.state = 'ok'; p.hp = p.maxhp; p.poison = 0; p.inv = 2;
        this.ev({ e: 'tp', pid: p.id, x: seg.x0 + 160 + i * 70, y: G.Y_MIN + 60 + i * 35 }); i++;
      }
      this.ev({ e: 'msg', text: 'Ещё попытка!' });
    }

    enemyTick(e, dt, alive) {
      const d = ENEMY[e.kind], w = this.w;
      e.t += dt; e.st += dt;
      if (e.ff > 0) e.ff -= dt;
      if (e.slow > 0) e.slow -= dt;
      if (e.burn > 0 && e.hp > 0) {
        e.burn -= dt; e.burnTick += dt;
        if (e.burnTick >= 1) { e.burnTick = 0; this.hurtEnemy(e, 3, { type: 'fire' }); }
      }
      // knockback slide
      if (e.kx) { e.x += e.kx * dt * 3; e.kx *= Math.pow(0.02, dt); if (Math.abs(e.kx) < 5) e.kx = 0; }
      e.x = clamp(e.x, w.camL - 200, w.camL + G.W + 200);
      if (e.hp <= 0) return;
      const spd = d.speed * (e.slow > 0 ? 0.5 : 1);

      if (e.state === 'enter') {
        e.anim = 'walk';
        const tx = e.face > 0 ? w.camL + 120 : w.camL + G.W - 120;
        e.x += Math.sign(tx - e.x) * spd * dt;
        if (Math.abs(tx - e.x) < 20 || (e.x > w.camL + 60 && e.x < w.camL + G.W - 60)) { e.state = 'idle'; e.st = 0; }
        return;
      }
      if (e.state === 'hurt') { if (e.st > 0.35) { e.state = 'idle'; e.anim = 'idle'; } e.p = Math.min(1, e.st / 0.35); return; }
      if (e.state === 'down') { if (e.st > 1.0) { e.state = 'idle'; e.anim = 'idle'; e.cd = Math.max(e.cd, 0.6); } return; }
      if (e.state === 'stun') { if (e.st > 0.5) e.state = 'idle'; return; }

      if (!alive.length) { e.anim = 'idle'; return; }
      // pick target: nearest, re-evaluated occasionally
      if (!e.target || !w.players.get(e.target) || w.players.get(e.target).state !== 'ok' || Math.random() < dt * 0.25) {
        let best = null, bd = 1e9;
        for (const p of alive) { const dd = Math.abs(p.x - e.x) + Math.abs(p.y - e.y) * 2 + Math.random() * 120; if (dd < bd) { bd = dd; best = p; } }
        e.target = best.id;
      }
      const T = w.players.get(e.target);
      e.cd -= dt;

      if (e.state === 'attack') {
        e.p = Math.min(1, e.st / e.dur);
        if (!e.fired && e.st >= e.hitAt) { e.fired = true; this.enemyStrike(e, T); }
        if (e.st >= e.dur) { e.state = 'idle'; e.anim = 'idle'; e.cd = rnd(d.cd[0], d.cd[1]); }
        return;
      }

      // boss specials
      if (d.boss) {
        e.special -= dt; e.summon -= dt;
        if (e.summon <= 0 && [...w.enemies.values()].filter(x => x.hp > 0 && x.id !== e.id).length < 3) {
          e.summon = 16; this.spawnEnemy('warrior', 'L'); this.spawnEnemy(Math.random() < 0.5 ? 'xbow' : 'warrior', 'R');
          this.ev({ e: 'msg', text: 'Ильвара: «Стража, ко мне!»' });
        }
        if (e.special <= 0) {
          e.special = rnd(7, 10);
          e.state = 'attack'; e.anim = 'cast'; e.st = 0; e.dur = 1.0; e.hitAt = 0.5; e.fired = false; e.mode = 'darkness';
          e.face = Math.sign(T.x - e.x) || 1;
          return;
        }
      }

      // movement + attack decision
      const dx = T.x - e.x, dy = T.y + e.offY * 20 - e.y;
      e.face = Math.sign(dx) || e.face;
      if (e.kind === 'xbow') {
        const want = 380 + (e.id % 3) * 50;
        const tx = T.x - Math.sign(dx || 1) * want;
        let mx = Math.abs(tx - e.x) > 30 ? Math.sign(tx - e.x) : 0;
        let my = Math.abs(dy) > 10 ? Math.sign(dy) : 0;
        e.x += mx * spd * dt * 0.9; e.y += my * spd * 0.6 * dt;
        e.anim = mx || my ? 'walk' : 'idle';
        if (e.cd <= 0 && Math.abs(dy) < 30 && Math.abs(dx) < d.reach) {
          e.state = 'attack'; e.anim = 'cast'; e.st = 0; e.dur = 0.95; e.hitAt = d.wind; e.fired = false; e.mode = 'bolt';
        }
      } else {
        const reach = d.reach * 0.8;
        const tx = T.x - Math.sign(dx || 1) * reach * 0.8;
        let mx = Math.abs(tx - e.x) > 14 ? Math.sign(tx - e.x) : 0;
        let my = Math.abs(dy) > 8 ? Math.sign(dy) : 0;
        // avoid stacking on other enemies
        for (const o of w.enemies.values()) if (o !== e && o.hp > 0 && Math.abs(o.x - e.x) < 50 && Math.abs(o.y - e.y) < 18) e.y += (e.y < o.y ? -1 : 1) * 40 * dt;
        e.x += mx * spd * dt; e.y += my * spd * 0.65 * dt;
        e.anim = mx || my ? 'walk' : 'idle';
        if (e.cd <= 0 && Math.abs(dy) < G.LANE && Math.abs(dx) < d.reach) {
          e.state = 'attack'; e.st = 0; e.fired = false;
          if (d.boss && Math.random() < 0.35) { e.anim = 'cast'; e.dur = 1.0; e.hitAt = 0.55; e.mode = 'spray'; }
          else { e.anim = 'melee'; e.dur = d.wind + 0.5; e.hitAt = d.wind + 0.1; e.mode = 'melee'; }
          this.ev({ e: 'tele', id: e.id });
        }
      }
      e.y = clamp(e.y, G.Y_MIN, G.Y_MAX);
    }

    enemyStrike(e, T) {
      const d = ENEMY[e.kind], w = this.w;
      if (e.mode === 'melee') {
        for (const p of w.players.values()) {
          if (p.state !== 'ok') continue;
          const dx = (p.x - e.x) * e.face;
          if (dx > -20 && dx < d.reach + 20 && Math.abs(p.y - e.y) < G.LANE + 6) this.hurtPlayer(p, d.dmg, e, { knock: d.boss ? 260 : 140, poison: d.boss ? 3 : 0 });
        }
        this.ev({ e: 'fx', k: d.boss ? 'whip' : 'slash', x: e.x + e.face * 70, y: e.y, z: 90, f: e.face });
      } else if (e.mode === 'bolt') {
        const id = this.nid();
        w.projs.set(id, { id, kind: 'bolt', team: 'e', owner: e.id, x: e.x + e.face * 50, y: e.y, z: 105, vx: 620 * e.face, dmg: d.dmg, life: 1.4, t: 0 });
      } else if (e.mode === 'spray') {
        const id = this.nid();
        w.projs.set(id, { id, kind: 'spray', team: 'e', owner: e.id, x: e.x + e.face * 60, y: e.y, z: 120, vx: 420 * e.face, dmg: 12, life: 1.1, t: 0 });
      } else if (e.mode === 'darkness') {
        const tgt = T || [...w.players.values()][0];
        const zone = { x: tgt.x, y: tgt.y, r: 170, until: w.time + 6 };
        w.dark = zone;
        this.ev({ e: 'fx', k: 'darkness', x: zone.x, y: zone.y, dur: 6 });
        this.ev({ e: 'msg', text: 'Ильвара призывает магическую Тьму!' });
      }
    }

    // apply darkness debuff each tick
    darknessTick() {
      const w = this.w;
      if (!w.dark) return;
      if (w.time > w.dark.until) { w.dark = null; return; }
      for (const p of w.players.values()) if (Math.hypot(p.x - w.dark.x, (p.y - w.dark.y) * 1.6) < w.dark.r) p.dark = 0.3;
    }
  }

  window.Sim = Sim;
})();
