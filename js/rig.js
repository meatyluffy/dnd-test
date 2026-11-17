// Cutout puppet rig with 2D forward kinematics, spring-driven secondary motion and squash & stretch.
// Angles in degrees; 0 = limb hangs straight down; negative = swings forward (towards facing direction).
(function () {
  const D2R = Math.PI / 180;

  class Rig {
    constructor(scene, def, opts = {}) {
      this.scene = scene;
      this.def = def;
      this.container = scene.add.container(0, 0);
      this.sprites = {};
      this.scale = def.scale * (opts.scaleMul || 1);
      this.flip = 1; this.flipVis = 1;
      this.springs = {};
      for (const name of def.order) {
        const b = def.bones[name];
        if (!b) continue;
        const key = def.key + '_' + (b.part || name);
        const s = scene.add.image(0, 0, key);
        const m = def.meta[b.part || name];
        s.setOrigin(m.ox / m.w, m.oy / m.h);
        if (b.dark) s.setTint(0xa49cb4);
        this.sprites[name] = s;
        this.container.add(s);
      }
      this.container.setScale(this.scale, this.scale);
      this.lastWorld = null;
    }

    setFacing(dir, dt) {
      this.flip = dir >= 0 ? 1 : -1;
      // quick turn: animate the visible flip instead of snapping
      const k = Math.min(1, (dt || 0.016) * 22);
      this.flipVis += (this.flip - this.flipVis) * k;
      if (Math.abs(this.flipVis) < 0.15) this.flipVis = 0.15 * Math.sign(this.flip);
    }

    apply(pose, dt = 0.016) {
      const def = this.def;
      const world = {};
      const rootY = -def.hip + (pose.y || 0);
      const rootX = pose.x || 0;
      for (const name of def.fk) {
        const b = def.bones[name];
        let local = (pose.a && pose.a[name] !== undefined ? pose.a[name] : 0) + (b.base || 0);
        let px, py, pa;
        if (!b.parent) { px = rootX; py = rootY; pa = 0; }
        else {
          const P = world[b.parent];
          let ax, ay;
          if (b.at === 'end') { ax = 0; ay = def.meta[def.bones[b.parent].part || b.parent].len; }
          else { ax = b.at[0]; ay = b.at[1]; }
          const r = P.a * D2R;
          px = P.x + ax * Math.cos(r) - ay * Math.sin(r);
          py = P.y + ax * Math.sin(r) + ay * Math.cos(r);
          pa = P.a;
        }
        let a = pa + local;
        if (b.spring) {
          // secondary motion: world angle chases target with a damped spring (cloth, wings, bags)
          let sp = this.springs[name];
          if (!sp) sp = this.springs[name] = { a, v: 0 };
          const k = b.spring.k || 90, d = b.spring.d || 12;
          // body velocity adds drag
          const drag = (pose.vx || 0) * (b.spring.drag || 0) * this.flip;
          const target = a + drag;
          const acc = (target - sp.a) * k - sp.v * d;
          sp.v += acc * dt; sp.a += sp.v * dt;
          sp.a = Math.max(target - (b.spring.max || 35), Math.min(target + (b.spring.max || 35), sp.a));
          a = sp.a;
        }
        world[name] = { x: px, y: py, a };
        const s = this.sprites[name];
        if (s) {
          s.x = px; s.y = py; s.rotation = a * D2R;
          const k = b.scl || 1;
          const sx = pose.sx && pose.sx[name] !== undefined ? pose.sx[name] : 1;
          const sy = pose.sy && pose.sy[name] !== undefined ? pose.sy[name] : 1;
          s.setScale(sx * k, sy * k);
        }
      }
      this.world = world;
      const sq = pose.sq || 1;               // squash & stretch (volume preserving)
      this.container.scaleX = this.scale * this.flipVis / Math.sqrt(sq);
      this.container.scaleY = this.scale * sq;
      this.container.rotation = (pose.rot || 0) * D2R * this.flip;
    }

    point(name, along = 'end') {
      const w = this.world && this.world[name];
      if (!w) return { x: this.container.x, y: this.container.y };
      const len = along === 'end' ? (this.def.meta[this.def.bones[name].part || name].len || 0) : 0;
      const r = w.a * Math.PI / 180;
      const lx = w.x - len * Math.sin(r), ly = w.y + len * Math.cos(r);
      return { x: this.container.x + lx * this.container.scaleX, y: this.container.y + ly * this.container.scaleY };
    }

    setTintAll(color) {
      for (const n in this.sprites) {
        const b = this.def.bones[n];
        if (color === null) { if (b.dark) this.sprites[n].setTint(0xa49cb4); else this.sprites[n].clearTint(); }
        else this.sprites[n].setTint(color);
      }
    }
    setAlpha(a) { this.container.setAlpha(a); }
    destroy() { this.container.destroy(); }
  }

  // ---------- procedural animation library ----------
  const S = Math.sin, C = Math.cos;
  const clamp01 = (p) => p < 0 ? 0 : p > 1 ? 1 : p;
  const smooth = (p) => { p = clamp01(p); return p * p * (3 - 2 * p); };
  const outBack = (p) => { p = clamp01(p); const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
  const outCubic = (p) => { p = clamp01(p); return 1 - Math.pow(1 - p, 3); };
  const seg = (p, a, b) => clamp01((p - a) / (b - a));
  const mix = (a, b, t) => a + (b - a) * t;

  function basePose(def, t) {
    const br = S(t * 2.1), br2 = S(t * 2.1 + 0.9);
    const a = {
      torso: br * 1.5 - 2, head: -br2 * 2.2 + 1,
      uarm: -6 + br2 * 3.5, farm: -24 + br * 3, uarm2: 9 - br2 * 2.5, farm2: -20 + br * 2,
      thigh: -7, shin: 7, thigh2: 6, shin2: 4,
      weapon: def.w.idle + br * 2, weapon2: def.w2 ? def.w2.idle : 0, skirt: 0, wings: 0,
    };
    return { a, y: br * 1.6, sx: {}, sy: {}, sq: 1 + br * 0.008 };
  }

  function walkPose(def, t, speed) {
    const p = basePose(def, t);
    const f = t * (def.walkRate || 9);
    const amp = Math.min(1, speed);
    const sw = S(f), sw2 = S(f + Math.PI);
    p.a.thigh = -6 - 30 * sw * amp; p.a.shin = 8 + 34 * Math.max(0, S(f - 1.2)) * amp;
    p.a.thigh2 = -6 - 30 * sw2 * amp; p.a.shin2 = 8 + 34 * Math.max(0, S(f + Math.PI - 1.2)) * amp;
    p.a.uarm = -4 + 26 * sw * amp; p.a.farm = -28 - 10 * Math.max(0, sw) * amp;
    p.a.uarm2 = 6 + 26 * sw2 * amp; p.a.farm2 = -22 - 10 * Math.max(0, sw2) * amp;
    p.a.torso = -7 * amp + S(2 * f) * 1.5;
    p.a.head = 4 * amp - S(2 * f) * 2;
    p.y = -Math.abs(C(f)) * 9 * amp;
    p.sq = 1 + (Math.abs(C(f)) - 0.5) * 0.035 * amp;
    p.vx = 1;
    return p;
  }

  // melee: anticipation -> snap with overshoot -> follow-through -> recover
  function meleePose(def, t, p, variant) {
    const q = basePose(def, t);
    const ant = smooth(seg(p, 0, 0.32));        // wind-up
    const hit = outBack(seg(p, 0.32, 0.52));    // strike snaps through with overshoot
    const rec = smooth(seg(p, 0.62, 1));        // recover
    const up = variant % 2 === 0;
    const aW = up ? 150 : 60, aH = up ? -100 : -75; // upper arm wind / hit angles
    const arm = mix(mix(-6, aW, ant), aH, hit);
    q.a.uarm = mix(arm, -6, rec);
    q.a.farm = mix(mix(-24, up ? -70 : -40, ant), up ? -8 : -30, hit) * (1 - rec) + -24 * rec;
    q.a.torso = mix(mix(-2, 10, ant), -20, hit) * (1 - rec) - 2 * rec;
    q.a.head = mix(mix(1, 6, ant), -8, hit) * (1 - rec);
    q.a.thigh = mix(mix(-7, 4, ant), -32, hit) * (1 - rec) - 7 * rec;
    q.a.shin = mix(7, 26, hit) * (1 - rec) + 7 * rec;
    q.a.thigh2 = mix(mix(6, -4, ant), 24, hit) * (1 - rec) + 6 * rec;
    q.a.uarm2 = mix(mix(9, -30, ant), 40, hit) * (1 - rec) + 9 * rec;
    q.a.farm2 = mix(-20, -50, hit) * (1 - rec) - 20 * rec;
    q.a.weapon = def.w.idle + (def.w.swing || 0) * hit * (1 - rec);
    q.x = mix(mix(0, -10, ant), 22, hit) * (1 - rec);
    q.sq = 1 + 0.05 * ant * (1 - hit) - 0.06 * hit * (1 - rec);
    q.vx = 2 * hit * (1 - rec);
    return q;
  }

  function castPose(def, t, p) {
    const q = basePose(def, t);
    const gather = smooth(seg(p, 0, 0.25));
    const rel = outBack(seg(p, 0.25, 0.45));
    const back = smooth(seg(p, 0.7, 1));
    const v = (gather * 0.6 + rel * 0.4) * (1 - back);
    q.a.uarm = mix(-6, mix(-40, -95, rel), Math.max(gather, rel)) * (1 - back) - 6 * back;
    q.a.farm = mix(-24, mix(-60, -5, rel), gather) * (1 - back) - 24 * back;
    q.a.uarm2 = 9 - 50 * v; q.a.farm2 = -20 - 50 * v;
    q.a.torso = mix(8 * gather, -10, rel) * (1 - back);
    q.a.head = mix(-6 * gather, -10, rel) * (1 - back);
    q.a.weapon = def.w.idle + (def.w.cast - def.w.idle) * Math.max(gather, rel) * (1 - back);
    q.a.thigh = -14 * v; q.a.thigh2 = 14 * v; q.a.shin = 10 * v;
    q.y += -6 * gather * (1 - rel);
    q.sq = 1 + 0.04 * gather * (1 - rel) - 0.04 * rel * (1 - back);
    q.vx = -1.2 * rel * (1 - back);
    return q;
  }

  function hurtPose(def, t, p) {
    const q = basePose(def, t);
    const v = 1 - outCubic(seg(p, 0.15, 1));
    const jolt = Math.sin(seg(p, 0, 0.5) * Math.PI) * (1 - seg(p, 0, 1));
    q.a.torso = 22 * v; q.a.head = 28 * v - 10 * jolt; q.a.uarm = 55 * v; q.a.uarm2 = 65 * v;
    q.a.farm = -60 * v; q.a.farm2 = -40 * v; q.a.thigh = -18 * v; q.a.thigh2 = 16 * v; q.a.shin = 14 * v;
    q.x = -16 * v; q.sq = 1 - 0.08 * jolt;
    q.vx = -2 * v;
    return q;
  }

  function downPose(def, t, p) {
    const q = basePose(def, 0);
    const fall = outCubic(seg(p === undefined ? 1 : p, 0, 0.35));
    q.a.torso = 4; q.a.uarm = mix(-6, 80, fall); q.a.uarm2 = mix(9, 110, fall); q.a.farm = -30; q.a.farm2 = -20;
    q.a.thigh = -18 * fall; q.a.shin = 26 * fall; q.a.thigh2 = 12 * fall; q.a.shin2 = 10; q.a.head = 14 * fall;
    q.rot = -84 * fall;
    q.y = def.hover ? def.hover * 0.6 * fall : 0;
    // small bounce when hitting the floor
    const b = seg(p === undefined ? 1 : p, 0.35, 0.6);
    q.y -= Math.sin(b * Math.PI) * 18;
    q.lift = 38 * fall;
    q.vx = -1;
    return q;
  }

  function dashPose(def, t) {
    const q = basePose(def, t);
    q.a.torso = -26; q.a.thigh = -48; q.a.shin = 50; q.a.thigh2 = 40; q.a.shin2 = 36;
    q.a.uarm = 55; q.a.uarm2 = 70; q.a.farm = -50; q.a.head = 12;
    q.sq = 0.92; q.vx = -3;
    return q;
  }

  function animate(def, st) {
    let pose;
    switch (st.anim) {
      case 'walk': pose = walkPose(def, st.t, st.speed || 1); break;
      case 'melee': pose = meleePose(def, st.t, st.p, st.variant || 0); break;
      case 'cast': pose = castPose(def, st.t, st.p); break;
      case 'hurt': pose = hurtPose(def, st.t, st.p); break;
      case 'down': pose = downPose(def, st.t, st.p); break;
      case 'dash': pose = dashPose(def, st.t); break;
      default: pose = basePose(def, st.t);
    }
    if (def.hover) {
      pose.y += -def.hover + S(st.t * 3) * 8;
      if (st.anim !== 'down') {
        pose.a.thigh = (pose.a.thigh || 0) * 0.4 - 18; pose.a.shin = 30 + S(st.t * 3) * 8;
        pose.a.thigh2 = (pose.a.thigh2 || 0) * 0.4 - 6; pose.a.shin2 = 34 + S(st.t * 3 + 1) * 8;
        pose.a.torso = (pose.a.torso || 0) + (st.anim === 'walk' ? -10 : 0);
      } else pose.y += def.hover;
      const fast = st.anim === 'walk' || st.anim === 'dash' ? 15 : 9;
      const ph = S(st.t * fast);
      pose.sx.wings = st.anim === 'down' ? 0.85 : 0.6 + 0.4 * Math.abs(ph);
      pose.sy.wings = 1 + 0.06 * ph;
      pose.a.wings = -6 * ph;
    }
    if (def.post) def.post(pose, st);
    return pose;
  }

  window.Rig = Rig;
  window.RigAnim = { animate, seg, smooth, outBack };
})();
