// Character rig definitions and gameplay stats.
(function () {
  const M = window.PART_META;
  const limbs = (o) => o;

  function humanoid(key, cfg) {
    const bones = {
      torso: { part: 'torso' },
      head: { parent: 'torso', at: cfg.neck },
      uarm: { parent: 'torso', at: cfg.sh },
      farm: { parent: 'uarm', at: 'end' },
      uarm2: { parent: 'torso', at: cfg.sh2, part: 'uarm2', dark: true },
      farm2: { parent: 'uarm2', at: 'end', part: 'farm2', dark: true },
      weapon: { parent: 'farm', at: 'end', part: cfg.weaponPart || 'weapon' },
    };
    if (cfg.thighs !== false) {
      Object.assign(bones, {
        thigh: { parent: 'torso', at: cfg.hip },
        shin: { parent: 'thigh', at: 'end' },
        thigh2: { parent: 'torso', at: cfg.hip2, part: 'thigh2', dark: true },
        shin2: { parent: 'thigh2', at: 'end', part: 'shin2', dark: true },
      });
    } else {
      Object.assign(bones, {
        shin: { parent: 'torso', at: cfg.hip },
        shin2: { parent: 'torso', at: cfg.hip2, part: 'shin2', dark: true },
      });
    }
    if (cfg.skirt) bones.skirt = { parent: 'torso', at: cfg.skirt };
    if (cfg.wings) bones.wings = { parent: 'torso', at: cfg.wings };
    if (cfg.bag) bones.weapon2 = { parent: 'farm2', at: 'end', part: 'bag', dark: true };
    const fk = ['torso', 'head', 'uarm', 'farm', 'uarm2', 'farm2', 'weapon', 'weapon2', 'thigh', 'shin', 'thigh2', 'shin2', 'skirt', 'wings'].filter(n => bones[n]);
    const order = cfg.order || ['wings', 'weapon2', 'uarm2', 'farm2', 'thigh2', 'shin2', 'thigh', 'shin', 'torso', 'skirt', 'head', 'uarm', 'farm', 'weapon'];
    return Object.assign({ key, meta: M[key], bones, fk, order: order.filter(n => bones[n]) }, cfg.extra);
  }

  const CHARS = {};

  const ORDER = ['wings', 'weapon2', 'farm2', 'uarm2', 'shin2', 'thigh2', 'shin', 'thigh', 'skirt', 'torso', 'head', 'weapon', 'farm', 'uarm'];
  CHARS.lukaris = humanoid('lukaris', {
    neck: [-2, -200], sh: [18, -168], sh2: [-28, -170], hip: [14, -18], hip2: [-18, -18],
    wings: [-14, -150], bag: true, order: ORDER,
    extra: {
      scale: 0.22, hip: 262, hover: 170, walkRate: 7,
      w: { idle: 26, cast: 175, swing: -40 }, w2: { idle: 20 },
    },
  });
  CHARS.lukaris.bones.weapon.scl = 1.25;
  CHARS.lukaris.bones.weapon2.spring = { k: 45, d: 5, drag: 8, max: 45 };
  CHARS.lukaris.bones.wings.spring = { k: 120, d: 10, drag: 3, max: 15 };
  CHARS.soreen = humanoid('soreen', {
    neck: [4, -188], sh: [20, -160], sh2: [-26, -162], hip: [12, -22], hip2: [-14, -22], skirt: [0, -42],
    order: ['farm2', 'uarm2', 'shin2', 'thigh2', 'shin', 'thigh', 'skirt', 'torso', 'head', 'weapon', 'farm', 'uarm'],
    extra: {
      scale: 0.44, hip: 228, walkRate: 8,
      w: { idle: -15, cast: -70, swing: -30 },
    },
  });
  CHARS.soreen.bones.skirt.spring = { k: 55, d: 8, drag: 5, max: 22 };
  CHARS.drow = humanoid('drow', {
    neck: [0, -194], sh: [22, -172], sh2: [-26, -174], hip: [12, -16], hip2: [-14, -16], skirt: [0, -24],
    order: ORDER,
    extra: {
      scale: 0.4, hip: 328, walkRate: 9,
      w: { idle: 150, cast: 120, swing: -134 },
    },
  });
  CHARS.drow.bones.skirt.spring = { k: 60, d: 8, drag: 5, max: 20 };
  CHARS.drowxbow = Object.assign({}, CHARS.drow, {
    bones: Object.assign({}, CHARS.drow.bones, { weapon: { parent: 'farm', at: 'end', part: 'crossbow' } }),
    w: { idle: 40, cast: 90, swing: -20 },
  });
  CHARS.priestess = humanoid('priestess', {
    neck: [0, -220], sh: [22, -176], sh2: [-28, -178], hip: [10, 88], hip2: [-12, 88], skirt: [0, -18], thighs: false,
    order: ['farm2', 'uarm2', 'shin2', 'shin', 'skirt', 'torso', 'head', 'weapon', 'farm', 'uarm'],
    extra: {
      scale: 0.45, hip: 280, walkRate: 6,
      w: { idle: -100, cast: -150, swing: 140 },
    },
  });
  CHARS.priestess.bones.skirt.spring = { k: 40, d: 6, drag: 6, max: 18 };

  // ---------- gameplay stats ----------
  const HEROES = {
    lukaris: {
      name: 'Лукарис', cls: 'Фея-друид', hp: 80, speed: 270, depthSpeed: 180,
      skills: {
        melee: { name: 'Удар посохом', cd: 0.45, icon: 'staff' },
        k: { icon: 'iceknife', name: 'Ледяной кинжал', cd: 1.6, desc: 'Осколок льда (1d10 колющего), затем взрыв холода по площади' },
        l: { icon: 'faerie', name: 'Огонь фей', cd: 9, desc: 'Враги в зоне светятся: по ним легче попасть (+35% урона)' },
        i: { icon: 'word', name: 'Лечащее слово', cd: 7, desc: 'Лечит союзников рядом и поднимает упавших' },
        o: { icon: 'cure', name: 'Лечение ран', cd: 11, desc: 'Сильное лечение касанием (ближайший союзник или себя)' },
        u: { icon: 'berry', name: 'Добрая ягода', cd: 18, desc: 'Роняет ягоды — каждая восстанавливает здоровье' },
        dash: { icon: 'misty', name: 'Туманный шаг', cd: 3, desc: 'Телепорт в направлении движения' },
      },
      passive: 'Спасение умирающих: поднимает упавших союзников втрое быстрее',
    },
    soreen: {
      name: 'Сорин', cls: 'Полуэльф-колдун', hp: 95, speed: 240, depthSpeed: 160,
      skills: {
        melee: { name: 'Удар книгой', cd: 0.5, icon: 'book' },
        k: { icon: 'eb', name: 'Мистический заряд', cd: 0.42, desc: 'Луч силовой энергии, средний урон' },
        l: { icon: 'frostbite', name: 'Обморожение', cd: 2.4, desc: 'Холод: замедляет врага, его следующая атака слабее' },
        dash: { icon: 'backstep', name: 'Отскок', cd: 1.2, desc: 'Быстрый отскок назад' },
      },
      passive: 'Адское возмездие: копится со временем; когда полное — ударившего охватывает пламя',
    },
  };

  window.CHARS = CHARS;
  window.HEROES = HEROES;
})();
