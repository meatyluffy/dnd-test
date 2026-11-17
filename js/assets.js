// Asset loading shared by game and viewer.
window.loadAllAssets = function (scene) {
  const D = window.ASSET_DATA;
  if (D) { for (const k in D) scene.load.image(k, D[k]); return; }
  const M = window.PART_META;
  for (const c in M) for (const p in M[c]) scene.load.image(c + '_' + p, 'assets/' + c + '/' + p + '.webp');
  const st = ['ground', 'web_strand', 'lantern', 'stalactite', 'cobweb', 'banner', 'crates', 'mushrooms', 'barrel'];
  for (const s of st) scene.load.image('st_' + s, 'assets/stage/' + s + '.webp');
  scene.load.image('st_bg', 'assets/stage/bg_far.jpg');
  for (const n of ['medallion', 'hpbar', 'bossbar', 'slot', 'plaque', 'nameplate', 'portrait_lukaris', 'portrait_soreen',
    'icon_staff', 'icon_iceknife', 'icon_faerie', 'icon_word', 'icon_cure', 'icon_berry', 'icon_misty', 'icon_book', 'icon_eb', 'icon_frostbite', 'icon_rebuke', 'icon_backstep'])
    scene.load.image('ui_' + n, 'assets/ui/' + n + '.webp');
  for (const n of ['circle', 'ebolt', 'iceshard', 'iceburst', 'hellfire', 'healcol', 'motes', 'mist', 'poison', 'slash', 'spark', 'snowflake'])
    scene.load.image('fx_' + n, 'assets/fx/' + n + '.webp');
};
