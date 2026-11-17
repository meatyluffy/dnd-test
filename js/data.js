// Game data: heroes, skills (D&D 5e spells adapted to Octopath-style shields/boost), enemies, areas.
(function () {
  const TYPES = {
    staff: { name: 'Посох', icon: 'staff' },
    book: { name: 'Книга', icon: 'book' },
    fire: { name: 'Огонь', icon: 'fire' },
    ice: { name: 'Лёд', icon: 'ice' },
    force: { name: 'Сила', icon: 'force' },
  };
  const TYPE_ORDER = ['staff', 'book', 'fire', 'ice', 'force'];

  // sprite strip frame indices
  const HERO_FR = { idle: [0, 1], walk: [2, 3, 4, 5], windup: 6, strike: 7, cast: 8, release: 9, hurt: 10, ko: 11 };
  const FOE_FR = { idle: [0, 1], windup: 2, strike: 3, cast: 4, hurt: 5 };

  const HEROES = {
    lukaris: {
      name: 'Лукарис', title: 'Фея-друид', weapon: 'staff', color: '#b9ff9c',
      stats: { hp: 260, sp: 90, atk: 52, mag: 78, def: 44, mdef: 66, spd: 74 },
      attack: { name: 'Удар посохом', type: 'staff' },
      skills: ['iceknife', 'faerie', 'word', 'cure', 'goodberry', 'misty', 'sparedying'],
      flyY: 10,
    },
    soreen: {
      name: 'Сорин', title: 'Полуэльф-колдун', weapon: 'book', color: '#d6a8ff',
      stats: { hp: 300, sp: 80, atk: 50, mag: 92, def: 50, mdef: 58, spd: 68 },
      attack: { name: 'Удар книгой', type: 'book' },
      skills: ['eldritch', 'frostbite', 'rebuke'],
    },
  };

  // target: enemy | enemies | ally | allies | self | ko
  const SKILLS = {
    iceknife: { name: 'Ледяной кинжал', sp: 8, target: 'enemy', type: 'ice', pow: 1.25, splash: 0.45, fx: 'iceknife',
      desc: 'Осколок льда в цель, затем взрыв холода задевает всех врагов. Усиление: мощнее.' },
    faerie: { name: 'Огонь фей', sp: 10, target: 'enemies', fx: 'faerie', debuff: { lit: 3 },
      desc: 'Враги светятся: видны все слабости, защита ниже (по ним легче попасть). Усиление: дольше.' },
    word: { name: 'Лечащее слово', sp: 6, target: 'ally', heal: 0.22, revive: true, fx: 'heal',
      desc: 'Быстрое лечение союзника, поднимает упавшего. Усиление: сильнее.' },
    cure: { name: 'Лечение ран', sp: 12, target: 'ally', heal: 0.45, fx: 'heal',
      desc: 'Сильное лечение касанием. Усиление: сильнее.' },
    goodberry: { name: 'Добрая ягода', sp: 14, target: 'allies', regen: 3, fx: 'berry',
      desc: 'Волшебные ягоды: вся партия восстанавливает здоровье в начале хода, 3 хода. Усиление: дольше.' },
    misty: { name: 'Туманный шаг', sp: 6, target: 'self', buff: { evade: 2 }, fx: 'mist',
      desc: 'Телепорт в серебристом тумане: следующая атака по Лукарису промахнётся.' },
    sparedying: { name: 'Спасение умирающего', sp: 0, target: 'ko', fx: 'heal',
      desc: 'Заговор: стабилизирует павшего союзника, он встаёт с 1 ед. здоровья.' },
    eldritch: { name: 'Мистический заряд', sp: 4, target: 'enemy', type: 'force', pow: 0.9, beams: true, fx: 'eldritch',
      desc: 'Луч силовой энергии. Усиление: больше лучей (по одному за каждое очко).' },
    frostbite: { name: 'Обморожение', sp: 5, target: 'enemy', type: 'ice', pow: 0.8, debuff: { weak: 2 }, fx: 'frost',
      desc: 'Холод сковывает врага: его атака слабее 2 хода. Усиление: мощнее.' },
    rebuke: { name: 'Адское возмездие', sp: 10, target: 'self', buff: { rebuke: 1 }, fx: 'rebukeReady',
      desc: 'Сорин готовит адское пламя: кто ударит его до следующего хода, сгорит (урон огнём). Усиление: сильнее.' },
  };

  const ENEMIES = {
    drow: { name: 'Дроу-страж', sprite: 'drow', hp: 240, atk: 58, mag: 40, def: 46, mdef: 40, spd: 66, shield: 3, weak: ['staff', 'fire', 'force'],
      moves: [{ id: 'slash', w: 6 }, { id: 'poisonbolt', w: 3 }, { id: 'darkness', w: 1, once: true }] },
    xbow: { name: 'Дроу-арбалетчик', sprite: 'xbow', hp: 170, atk: 54, mag: 40, def: 38, mdef: 44, spd: 76, shield: 2, weak: ['book', 'ice'],
      moves: [{ id: 'shot', w: 6 }, { id: 'poisonbolt', w: 4 }] },
    quaggoth: { name: 'Кваггот', sprite: 'quaggoth', hp: 360, atk: 68, mag: 20, def: 52, mdef: 30, spd: 52, shield: 4, weak: ['fire', 'staff'],
      moves: [{ id: 'claw', w: 6 }, { id: 'frenzy', w: 3 }] },
    spider: { name: 'Гигантский паук', sprite: 'spider', hp: 200, atk: 56, mag: 30, def: 40, mdef: 36, spd: 80, shield: 3, weak: ['fire', 'book', 'ice'],
      moves: [{ id: 'bite', w: 6 }, { id: 'web', w: 2 }] },
    ilvara: { name: 'Жрица Ильвара', sprite: 'ilvara', hp: 1050, atk: 62, mag: 70, def: 54, mdef: 62, spd: 70, shield: 6, weak: ['force', 'staff', 'ice'], boss: true,
      moves: [{ id: 'scourge', w: 5 }, { id: 'spray', w: 3 }, { id: 'litparty', w: 2 }, { id: 'darkness', w: 2 }] },
  };

  const MOVES = {
    slash: { name: 'Удар скимитаром', kind: 'phys', pow: 1.0, target: 'one' },
    shot: { name: 'Выстрел из арбалета', kind: 'phys', pow: 0.95, target: 'one' },
    poisonbolt: { name: 'Отравленный болт', kind: 'phys', pow: 0.7, target: 'one', status: { poison: 3 } },
    darkness: { name: 'Тьма', kind: 'status', target: 'all', status: { blind: 2 }, desc: 'Магическая тьма: ваши атаки оружием часто промахиваются' },
    claw: { name: 'Удар когтями', kind: 'phys', pow: 1.15, target: 'one' },
    frenzy: { name: 'Бешенство', kind: 'phys', pow: 0.6, target: 'random', hits: 2 },
    bite: { name: 'Ядовитый укус', kind: 'phys', pow: 0.85, target: 'one', status: { poison: 3 } },
    web: { name: 'Паутина', kind: 'status', target: 'one', status: { webbed: 1 }, desc: 'Опутан: пропускает ход' },
    scourge: { name: 'Бич со змеями', kind: 'phys', pow: 0.55, target: 'random', hits: 3, status: { poison: 2 } },
    spray: { name: 'Ядовитые брызги', kind: 'mag', pow: 0.9, target: 'all', status: { poison: 2 } },
    litparty: { name: 'Огонь фей', kind: 'status', target: 'all', status: { lit: 2 }, desc: 'Вы светитесь: по вам легче попасть' },
    summon: { name: 'Стража, ко мне!', kind: 'summon' },
  };

  const STATUS = {
    poison: { name: 'Яд', color: '#8dff6a' }, blind: { name: 'Тьма', color: '#8a7aa8' }, webbed: { name: 'Паутина', color: '#e8e0f0' },
    lit: { name: 'Подсвечен', color: '#e7a6ff' }, weak: { name: 'Ослаблен', color: '#9fe8ff' }, regen: { name: 'Ягоды', color: '#ff7a8a' },
    evade: { name: 'Туман', color: '#c8c0ff' }, rebuke: { name: 'Возмездие', color: '#ff9a3a' },
  };

  const ITEMS = {
    potion: { name: 'Зелье лечения', icon: 'potion', desc: 'Восстанавливает 35% здоровья', heal: 0.35 },
    ether: { name: 'Грибной настой', icon: 'berry', desc: 'Восстанавливает 40% очков умений', sp: 0.4 },
  };

  // native resolution 640x360
  const AREAS = {
    cell: {
      name: 'Велкинвильв · Загон для рабов', bg: 'cell', band: [288, 348], bfloor: [292, 348], next: 'bridge',
      lights: [[62, 32, 0xc77dff, 3], [221, 49, 0xc77dff, 3], [600, 40, 0xc77dff, 3], [137, 224, 0xb06bff, 2], [400, 224, 0xb06bff, 2], [583, 330, 0xb06bff, 2.5]],
      start: [[90, 318], [130, 300], [70, 340], [150, 334]],
      intro: [
        ['Рассказчик', 'Вы приходите в себя на холодном камне. Где-то капает вода, пахнет плесенью и грибами.'],
        ['Рассказчик', 'Велкинвильв — аванпост дроу, подвешенный на сталактитах высоко над Подземьем. Отсюда рабов гонят в Мензоберранзан.'],
        ['Сорин', 'Книга… она всё ещё со мной. И шёпот тоже. Оркус не отпускает.'],
        ['Лукарис', 'Дверь соседней клетки открыта. Дроу беспечны — грех этим не воспользоваться.'],
      ],
      chests: [{ id: 'c1', x: 505, y: 296, items: { potion: 2 } }],
      foes: [{ id: 'e1', x: 380, y: 318, group: ['drow', 'quaggoth'], patrol: 50 }],
      notes: [{ id: 'n1', x: 240, y: 300, text: [['Рассказчик', 'На стене нацарапаны сотни чёрточек. Кто-то считал дни. Последняя — совсем свежая.']] }],
    },
    bridge: {
      name: 'Велкинвильв · Подвесной мост', bg: 'bridge', band: [260, 282], bfloor: [262, 312], next: 'tower',
      lights: [[62, 170, 0xffb050, 3], [593, 170, 0xffb050, 3]],
      start: [[40, 270], [70, 264], [24, 278], [96, 276]],
      intro: [['Рассказчик', 'Мост из паучьего шёлка раскачивается над бездной. Внизу, в паутине, что-то шевелится.']],
      chests: [{ id: 'c2', x: 600, y: 268, items: { potion: 1, ether: 1 } }],
      foes: [
        { id: 'e2', x: 250, y: 270, group: ['drow', 'xbow'], patrol: 40 },
        { id: 'e3', x: 440, y: 272, group: ['spider', 'spider'], patrol: 30 },
      ],
      notes: [],
    },
    tower: {
      name: 'Велкинвильв · Сторожевая башня', bg: 'tower', band: [242, 266], bfloor: [246, 300], next: 'shrine',
      lights: [[367, 157, 0xc77dff, 3], [458, 157, 0xc77dff, 3], [50, 290, 0xb06bff, 2.5], [571, 90, 0x9fe8ff, 4]],
      start: [[40, 254], [70, 248], [24, 262], [96, 260]],
      intro: [['Рассказчик', 'Водопад шумит у края уступа. Квагготы таскают бочки с водой под надзором арбалетчика.']],
      chests: [{ id: 'c3', x: 150, y: 248, items: { ether: 1, potion: 1 } }],
      foes: [{ id: 'e4', x: 330, y: 254, group: ['quaggoth', 'xbow', 'quaggoth'], patrol: 40 }],
      notes: [{ id: 'n2', x: 560, y: 256, text: [['Лукарис', 'Внизу — пруд и подъёмник. Если доберёмся до жрицы, путь вниз свободен.']] }],
    },
    shrine: {
      name: 'Велкинвильв · Святилище Ллос', bg: 'shrine', band: [256, 308], bfloor: [262, 318], next: null,
      lights: [[250, 157, 0xd04aff, 3.5], [467, 157, 0xd04aff, 3.5], [146, 178, 0xd04aff, 2.5], [567, 178, 0xd04aff, 2.5], [358, 94, 0xff4a6a, 4]],
      start: [[60, 290], [90, 278], [40, 300], [110, 302]],
      intro: [['Рассказчик', 'У входа в святилище — тайник других рабов: фляга воды и горсть сушёных грибов. Вы переводите дух. Силы восстановлены.'], ['Рассказчик', 'Святилище Паучьей Королевы. Воздух густой от благовоний. У алтаря ждёт жрица.']],
      restore: true,
      chests: [],
      foes: [{ id: 'boss', x: 430, y: 282, group: ['ilvara', 'drow'], boss: true, patrol: 0,
        talk: [['Ильвара', 'Рабы, сбежавшие из загона… Ллос любит, когда добыча сопротивляется.'], ['Ильвара', 'На колени. Или я скормлю вас паукам по кусочку.'], ['Сорин', 'Мой покровитель страшнее твоей богини. Он уже шепчет мне твоё имя.']] }],
      notes: [],
      outro: [
        ['Рассказчик', 'Ильвара падает у алтаря. Её змеи-плети бессильно извиваются на мозаике из паутины.'],
        ['Рассказчик', 'Вы спускаетесь на подъёмнике к подземному пруду. Впереди — тьма Подземья и долгий путь домой.'],
        ['Рассказчик', 'Конец пробной главы. Продолжение следует…'],
      ],
    },
  };
  const AREA_ORDER = ['cell', 'bridge', 'tower', 'shrine'];

  window.DATA = { TYPES, TYPE_ORDER, HERO_FR, FOE_FR, HEROES, SKILLS, ENEMIES, MOVES, STATUS, ITEMS, AREAS, AREA_ORDER };
})();
