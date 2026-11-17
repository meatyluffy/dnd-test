// Asset list (generated)
window.SPRITE_META = {"lukaris": {"fw": 56, "fh": 50, "n": 12}, "soreen": {"fw": 72, "fh": 64, "n": 12}, "drow": {"fw": 75, "fh": 70, "n": 6}, "xbow": {"fw": 58, "fh": 67, "n": 6}, "quaggoth": {"fw": 83, "fh": 76, "n": 6}, "spider": {"fw": 79, "fh": 53, "n": 6}, "ilvara": {"fw": 94, "fh": 91, "n": 6}};
window.loadAssets = function (scene) {
  const D = window.ASSET_DATA;
  const img = (key, path) => scene.load.image(key, D && D[key] ? D[key] : path);
  for (const k in window.SPRITE_META) img('spr_' + k, 'assets/spr/' + k + '.png');
  for (const b of ['cell', 'bridge', 'tower', 'shrine', 'title']) img('bg_' + b, 'assets/bg/' + b + '.png');
  for (const n of ["berry", "book", "broken", "chest", "dark", "fire", "force", "ice", "light", "potion", "staff", "sword"]) img('ic_' + n, 'assets/icons/' + n + '.png');
  for (const n of ["circle", "ebolt", "healcol", "hellfire", "iceburst", "iceshard", "mist", "motes", "poison", "slash", "snowflake", "spark"]) img('fx_' + n, 'assets/fx/' + n + '.png');
};
