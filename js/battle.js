// Host-side battle engine: turn order, shields & weaknesses, Break, Boost Points, statuses, enemy AI.
(function () {
  const D = window.DATA;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  class Battle {
    // party: [{uid, owner, char, name, hp, sp}] ; foes: [kind] ; inv: {potion:n}
    constructor(party, foes, inv, opts = {}) {
      this.units = [];
      this.inv = inv;
      this.boss = !!opts.boss;
      this.round = 0;
      this.events = [];
      this.phase = 'start';
      this.nextUid = 100;
      const hpScale = 1 + 0.45 * Math.max(0, party.length - 1);
      party.forEach((p, i) => {
        const h = D.HEROES[p.char];
        this.units.push({
          uid: p.uid, side: 'hero', key: p.char, name: p.name, owner: p.owner, slot: i,
          hp: p.hp, maxhp: h.stats.hp, sp: p.sp, maxsp: h.stats.sp, bp: 1, boosted: false,
          atk: h.stats.atk, mag: h.stats.mag, def: h.stats.def, mdef: h.stats.mdef, spd: h.stats.spd,
          status: {}, defend: false, alive: p.hp > 0,
        });
      });
      foes.forEach((k, i) => this.addFoe(k, i, hpScale));
      this.hpScale = hpScale;
    }

    addFoe(kind, slot, hpScale) {
      const e = D.ENEMIES[kind];
      const u = {
        uid: 'f' + (this.nextUid++), side: 'foe', key: kind, name: e.name, slot,
        hp: Math.round(e.hp * hpScale), maxhp: Math.round(e.hp * hpScale), atk: e.atk, mag: e.mag, def: e.def, mdef: e.mdef, spd: e.spd,
        shield: e.shield, maxShield: e.shield, weak: e.weak.slice(), revealed: {}, broken: 0, status: {}, alive: true, used: {}, boss: !!e.boss,
      };
      this.units.push(u);
      return u;
    }

    get heroes() { return this.units.filter(u => u.side === 'hero'); }
    get foes() { return this.units.filter(u => u.side === 'foe'); }
    unit(uid) { return this.units.find(u => u.uid === uid); }
    ev(e) { this.events.push(e); }

    snapshot() {
      return {
        round: this.round, phase: this.phase, actor: this.actor || null, order: this.order || [], next: this.nextOrder || [],
        units: this.units.map(u => ({ uid: u.uid, side: u.side, key: u.key, name: u.name, owner: u.owner, slot: u.slot, hp: u.hp, maxhp: u.maxhp, sp: u.sp, maxsp: u.maxsp, bp: u.bp,
          shield: u.shield, maxShield: u.maxShield, weak: u.side === 'foe' ? u.weak.map(t => u.revealed[t] ? t : '?') : undefined, broken: u.broken, status: u.status, alive: u.alive, defend: u.defend, boss: u.boss })),
        inv: this.inv,
      };
    }

    calcOrder() {
      return this.units.filter(u => u.alive && !(u.side === 'foe' && u.broken > 0))
        .map(u => ({ u, s: u.spd * rnd(0.85, 1.15) + (u.defend ? 1000 : 0) }))
        .sort((a, b) => b.s - a.s).map(x => x.u.uid);
    }

    start() {
      this.ev({ type: 'msg', text: this.boss ? 'Бой с боссом!' : 'Враги атакуют!' });
      this.newRound();
    }

    newRound() {
      this.round++;
      // broken enemies recover after skipping the rest of the round they broke in and the whole next round
      for (const u of this.foes) if (u.alive && u.broken > 0) {
        u.broken--;
        if (u.broken === 0) { u.shield = u.maxShield; this.ev({ type: 'recover', target: u.uid }); }
      }
      this.order = this.nextOrder && this.round > 1 ? this.calcOrder() : this.calcOrder();
      this.nextOrder = this.calcOrder();
      this.turnIdx = -1;
      this.ev({ type: 'round', round: this.round });
      this.nextTurn();
    }

    // advances to the next actor; returns when waiting for a hero command or after resolving a foe turn
    nextTurn() {
      if (this.checkEnd()) return;
      this.turnIdx++;
      if (this.turnIdx >= this.order.length) return this.newRound();
      const u = this.unit(this.order[this.turnIdx]);
      if (!u || !u.alive || (u.side === 'foe' && u.broken > 0)) return this.nextTurn();
      this.actor = u.uid;
      u.defend = false;
      // start-of-turn effects
      if (u.status.poison) {
        const d = Math.max(1, Math.round(u.maxhp * (u.side === 'hero' ? 0.07 : 0.05)));
        u.hp = Math.max(0, u.hp - d);
        this.ev({ type: 'tick', target: u.uid, dmg: d, status: 'poison' });
        if (u.hp <= 0) { this.ko(u); return this.nextTurn(); }
      }
      if (u.status.regen) {
        const h = Math.round(u.maxhp * 0.08);
        u.hp = Math.min(u.maxhp, u.hp + h);
        this.ev({ type: 'tick', target: u.uid, heal: h, status: 'regen' });
      }
      if (u.side === 'hero') {
        if (!u.boosted) u.bp = Math.min(5, u.bp + (this.round === 1 && this.turnIdx < 99 && !u._first ? 0 : 1));
        u._first = true;
        u.boosted = false;
      }
      if (u.status.webbed) {
        this.ev({ type: 'skip', actor: u.uid, text: u.name + ' опутан паутиной!' });
        this.tickStatus(u);
        return this.nextTurn();
      }
      if (u.side === 'hero') {
        this.phase = 'command';
        this.ev({ type: 'turn', actor: u.uid });
        return;
      }
      this.phase = 'anim';
      this.ev({ type: 'turn', actor: u.uid });
      this.foeAct(u);
      if (u.boss && u.alive && u.hp < u.maxhp * 0.35) {
        if (!u.used.enrage) { u.used.enrage = 1; this.ev({ type: 'msg', text: 'Ильвара в ярости — она действует дважды!' }); }
        if (this.heroes.some(h => h.alive)) this.foeAct(u);
      }
      this.tickStatus(u);
      this.afterAction();
    }

    afterAction() {
      if (this.checkEnd()) return;
      this.phase = 'anim';
      this.pendingNext = true; // host calls continue() after animations
    }

    continue() {
      if (!this.pendingNext) return;
      this.pendingNext = false;
      this.nextTurn();
    }

    tickStatus(u) {
      for (const k of Object.keys(u.status)) {
        if (k === 'rebuke' || k === 'evade') continue; // consumed on trigger or next own turn
        u.status[k]--;
        if (u.status[k] <= 0) delete u.status[k];
      }
    }

    checkEnd() {
      if (this.phase === 'win' || this.phase === 'lose') return true;
      if (!this.foes.some(u => u.alive)) { this.phase = 'win'; this.ev({ type: 'win' }); return true; }
      if (!this.heroes.some(u => u.alive)) { this.phase = 'lose'; this.ev({ type: 'lose' }); return true; }
      return false;
    }

    ko(u) {
      u.alive = false; u.hp = 0; u.status = {}; u.broken = 0;
      this.ev({ type: 'ko', target: u.uid });
    }

    // ---------------- damage
    dmgCalc(src, dst, pow, kind, type) {
      const A = kind === 'mag' ? src.mag : src.atk, Df = kind === 'mag' ? dst.mdef : dst.def;
      let v = pow * Math.max(8, A * 2.2 - Df * 1.1) * rnd(0.92, 1.08) * (src.side === 'foe' ? 0.5 : 1);
      let weak = false, crit = false;
      if (dst.side === 'foe' && type && dst.weak.includes(type)) { weak = true; v *= 1.3; }
      if (dst.side === 'foe' && dst.broken > 0) v *= 2;
      if (dst.status.lit) v *= 1.3;
      if (src.status.weak) v *= 0.7;
      if (dst.defend) v *= 0.5;
      if (kind === 'phys' && Math.random() < 0.06) { crit = true; v *= 1.5; }
      return { v: Math.max(1, Math.round(v)), weak, crit };
    }

    // apply a hit from src to dst; returns hit record
    hit(src, dst, pow, kind, type) {
      const rec = { target: dst.uid };
      if (dst.side === 'hero' && dst.status.evade) { delete dst.status.evade; rec.miss = true; rec.text = 'Туман!'; return rec; }
      if (src.side === 'hero' && kind === 'phys' && src.status.blind && Math.random() < 0.5) { rec.miss = true; return rec; }
      const r = this.dmgCalc(src, dst, pow, kind, type);
      rec.dmg = r.v; rec.weak = r.weak; rec.crit = r.crit; rec.type = type;
      dst.hp = Math.max(0, dst.hp - r.v);
      if (dst.side === 'foe' && type) {
        if (r.weak && !dst.revealed[type]) { dst.revealed[type] = true; rec.reveal = type; }
        if (r.weak && dst.broken === 0 && dst.shield > 0) {
          dst.shield--; rec.shield = dst.shield;
          if (dst.shield === 0) {
            dst.broken = this.order.indexOf(dst.uid) > this.turnIdx ? 2 : 2; rec.broke = true;
          }
        }
      }
      if (dst.hp <= 0) { rec.ko = true; this.ko(dst); }
      return rec;
    }

    // ---------------- hero commands
    // cmd: {kind:'attack'|'skill'|'item'|'defend', skill, item, boost, target}
    heroCommand(uid, cmd) {
      if (this.phase !== 'command' || this.actor !== uid) return false;
      const u = this.unit(uid);
      const h = D.HEROES[u.key];
      const boost = Math.max(0, Math.min(3, Math.min(u.bp, cmd.boost | 0)));
      const evt = { type: 'action', actor: uid, hits: [], boost };
      const tgt = cmd.target ? this.unit(cmd.target) : null;
      const aliveFoe = (t) => t && t.side === 'foe' && t.alive ? t : this.foes.find(f => f.alive);

      if (cmd.kind === 'attack') {
        const t = aliveFoe(tgt);
        evt.name = h.attack.name; evt.anim = 'strike'; evt.fx = 'weapon';
        for (let i = 0; i < 1 + boost && t.alive; i++) { const r = this.hit(u, t, 0.95, 'phys', h.weapon); evt.hits.push(r); this.counterCheck(u, t, evt); }
      } else if (cmd.kind === 'defend') {
        u.defend = true; evt.name = 'Защита'; evt.anim = 'none'; evt.fx = 'defend';
      } else if (cmd.kind === 'item') {
        const it = D.ITEMS[cmd.item];
        if (!it || !(this.inv[cmd.item] > 0)) return false;
        const t = tgt && tgt.side === 'hero' && tgt.alive ? tgt : u;
        this.inv[cmd.item]--;
        evt.name = it.name; evt.anim = 'cast'; evt.fx = 'item';
        if (it.heal) { const v = Math.round(t.maxhp * it.heal); t.hp = Math.min(t.maxhp, t.hp + v); evt.hits.push({ target: t.uid, heal: v }); }
        if (it.sp) { const v = Math.round(t.maxsp * it.sp); t.sp = Math.min(t.maxsp, t.sp + v); evt.hits.push({ target: t.uid, sp: v }); }
      } else if (cmd.kind === 'skill') {
        const s = D.SKILLS[cmd.skill];
        if (!s || !h.skills.includes(cmd.skill) || u.sp < s.sp) return false;
        u.sp -= s.sp;
        evt.name = s.name; evt.anim = 'cast'; evt.fx = s.fx; evt.skill = cmd.skill;
        const powMul = 1 + 0.75 * boost;
        if (s.target === 'enemy') {
          const t = aliveFoe(tgt);
          evt.main = t.uid;
          if (s.beams) {
            for (let i = 0; i < 1 + boost && t.alive; i++) { const r = this.hit(u, t, s.pow, 'mag', s.type); evt.hits.push(r); }
          } else {
            const r = this.hit(u, t, s.pow * powMul, 'mag', s.type); evt.hits.push(r);
            if (s.splash) for (const f of this.foes.filter(f => f.alive)) { const r2 = this.hit(u, f, s.splash * powMul, 'mag', s.type); r2.splash = true; evt.hits.push(r2); }
            if (s.debuff && t.alive) for (const k in s.debuff) { t.status[k] = s.debuff[k] + (boost ? 1 : 0); evt.hits.push({ target: t.uid, status: k }); }
          }
        } else if (s.target === 'enemies') {
          for (const f of this.foes.filter(f => f.alive)) {
            for (const k in s.debuff) f.status[k] = s.debuff[k] + boost;
            const rev = f.weak.filter(t => !f.revealed[t]);
            f.weak.forEach(t => f.revealed[t] = true);
            evt.hits.push({ target: f.uid, status: 'lit', revealAll: rev });
          }
        } else if (s.target === 'ally' || s.target === 'ko') {
          let t = tgt && tgt.side === 'hero' ? tgt : u;
          if (s.target === 'ko') {
            if (!t || t.alive) t = this.heroes.find(x => !x.alive);
            if (!t) { u.sp += s.sp; return false; }
            t.alive = true; t.hp = 1; evt.hits.push({ target: t.uid, revive: true, heal: 1 });
          } else {
            if (!t.alive && !s.revive) t = u;
            const v = Math.round(t.maxhp * s.heal * (1 + 0.6 * boost) + u.mag * 0.4);
            const rev = !t.alive;
            t.alive = true; t.hp = Math.min(t.maxhp, t.hp + v);
            evt.hits.push({ target: t.uid, heal: v, revive: rev });
          }
        } else if (s.target === 'allies') {
          for (const t of this.heroes.filter(x => x.alive)) { t.status.regen = s.regen + boost; evt.hits.push({ target: t.uid, status: 'regen' }); }
        } else if (s.target === 'self') {
          for (const k in s.buff) u.status[k] = s.buff[k];
          if (cmd.skill === 'rebuke') u.rebukePow = 1.5 * (1 + 0.75 * boost);
          evt.hits.push({ target: u.uid, status: Object.keys(s.buff)[0] });
        }
      }
      if (boost) { u.bp -= boost; u.boosted = true; }
      if (u.status.evade === undefined && cmd.skill !== 'misty') {}
      this.ev(evt);
      this.tickStatus(u);
      this.afterAction();
      return true;
    }

    // Hellish Rebuke reaction: enemy damaged the warlock -> fire counter
    counterCheck() {}
    rebukeCheck(attacker, victim, evt) {
      if (victim.side !== 'hero' || !victim.alive && victim.hp > 0) return;
      if (!victim.status.rebuke || !attacker.alive) return;
      delete victim.status.rebuke;
      const r = this.hit(victim, attacker, victim.rebukePow || 1.5, 'mag', 'fire');
      r.counter = true; r.by = victim.uid;
      evt.counter = evt.counter || [];
      evt.counter.push(r);
    }

    // ---------------- enemy AI
    foeAct(u) {
      const e = D.ENEMIES[u.key];
      const heroes = this.heroes.filter(h => h.alive);
      if (!heroes.length) return;
      // boss summons guards once when wounded
      if (u.boss && !u.used.summon && u.hp < u.maxhp * 0.6 && this.foes.filter(f => f.alive).length < 4) {
        u.used.summon = 1;
        const slots = [0, 1, 2, 3, 4].filter(s => !this.foes.some(f => f.alive && f.slot === s));
        const added = [];
        const nSum = this.heroes.length >= 3 ? 2 : 1;
        for (let i = 0; i < nSum && slots.length; i++) added.push(this.addFoe('drow', slots.shift(), this.hpScale * 0.8));
        this.order.push(...added.map(a => a.uid));
        this.ev({ type: 'summon', actor: u.uid, name: D.MOVES.summon.name, units: added.map(a => this.snapUnit(a)) });
        return;
      }
      const opts = e.moves.filter(m => !(m.once && u.used[m.id]));
      let tot = opts.reduce((s, m) => s + m.w, 0), r = Math.random() * tot, mv = opts[0];
      for (const m of opts) { r -= m.w; if (r <= 0) { mv = m; break; } }
      if (mv.once) u.used[mv.id] = 1;
      const M = D.MOVES[mv.id];
      const evt = { type: 'action', actor: u.uid, name: M.name, anim: M.kind === 'status' ? 'cast' : M.kind === 'mag' ? 'cast' : 'strike', fx: mv.id, hits: [] };
      const lowFirst = heroes.slice().sort((a, b) => a.hp / a.maxhp - b.hp / b.maxhp);
      const choose = () => Math.random() < 0.35 ? lowFirst[0] : pick(heroes);
      const targets = M.target === 'all' ? heroes : [choose()];
      const hits = M.hits || 1;
      for (let i = 0; i < hits; i++) {
        const list = M.target === 'random' ? [pick(this.heroes.filter(h => h.alive))].filter(Boolean) : targets.filter(t => t.alive);
        for (const t of list) {
          if (M.kind === 'phys' || M.kind === 'mag') {
            const rec = this.hit(u, t, M.pow, M.kind, null); evt.hits.push(rec);
            if (!rec.miss && M.status && t.alive) for (const k in M.status) { t.status[k] = Math.max(t.status[k] || 0, M.status[k]); rec.status = k; }
            if (!rec.miss) this.rebukeCheck(u, t, evt);
          } else if (M.kind === 'status') {
            for (const k in M.status) t.status[k] = M.status[k];
            evt.hits.push({ target: t.uid, status: Object.keys(M.status)[0] });
          }
        }
        if (!u.alive) break;
      }
      this.ev(evt);
    }

    snapUnit(u) { return this.snapshot().units.find(x => x.uid === u.uid); }
  }

  window.Battle = Battle;
})();
