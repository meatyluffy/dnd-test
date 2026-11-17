// Lobby: hero choice, host / join, roster.
(function () {
  const $ = (id) => document.getElementById(id);
  const D = window.DATA;
  const params = new URLSearchParams(location.search);
  let chosen = (() => { try { return localStorage.getItem('velk_hero') || 'lukaris'; } catch (e) { return 'lukaris'; } })();
  try { $('name').value = localStorage.getItem('velk_name') || ''; } catch (e) {}
  if (params.get('hero')) chosen = params.get('hero');
  if (params.get('name')) $('name').value = params.get('name');

  for (const key of ['lukaris', 'soreen']) {
    const h = D.HEROES[key];
    const div = document.createElement('div');
    div.className = 'hero' + (key === chosen ? ' sel' : '');
    div.dataset.key = key;
    const sk = h.skills.map(k => `<li><span style="color:#e8c27a">${D.SKILLS[k].name}</span> (${D.SKILLS[k].sp} ОУ)</li>`).join('');
    div.innerHTML = `<div class="top"><img src="assets/spr/${key}_big.png"><div><b>${h.name}</b><br><small>${h.title} · оружие: ${D.TYPES[h.weapon].name.toLowerCase()}</small></div></div><ul>${sk}</ul>`;
    div.onclick = () => { chosen = key; document.querySelectorAll('.hero').forEach(x => x.classList.toggle('sel', x.dataset.key === key)); try { localStorage.setItem('velk_hero', key); } catch (e) {} };
    $('heroes').appendChild(div);
  }
  const status = (t) => { $('status').textContent = t; };
  const myName = () => { const n = $('name').value.trim() || D.HEROES[chosen].name; try { localStorage.setItem('velk_name', n); } catch (e) {} return n; };
  const showWait = (host) => { $('menu').style.display = 'none'; $('wait').style.display = 'block'; $('hostInfo').style.display = host ? 'flex' : 'none'; $('btnStart').style.display = host ? 'inline-block' : 'none'; };

  window.LOBBY = {
    roster(list) { $('roster').innerHTML = list.map(p => `<span style="color:#${p.color.toString(16).padStart(6, '0')}">● ${p.name}</span> — ${D.HEROES[p.char].name}`).join('<br>'); },
    status,
  };

  $('btnHost').onclick = () => {
    status('Создаю комнату…'); $('btnHost').disabled = true;
    GAME.hostGame({ name: myName(), char: chosen }, (err, code) => {
      if (err) { status('Сервер соединения недоступен (' + err + '). Можно сыграть одному.'); $('btnHost').disabled = false; $('btnSolo').style.display = 'inline-block'; return; }
      showWait(true); $('roomcode').textContent = code; status('Отправь код друзьям. Начать можно и одному.');
    });
  };
  $('btnCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('roomcode').textContent); status('Код скопирован'); };
  $('btnStart').onclick = () => GAME.startAsHost();
  $('btnSolo').onclick = () => GAME.startAsHost();
  $('btnJoin').onclick = () => {
    const code = $('code').value.trim();
    if (code.length < 4) { status('Введи код комнаты'); return; }
    status('Подключаюсь…'); $('btnJoin').disabled = true;
    GAME.joinGame(code, { name: myName(), char: chosen }, (err) => {
      if (err) { status('Не получилось подключиться (' + (err.type || err.message || err) + '). Проверь код или попробуй Radmin VPN / Tailscale.'); $('btnJoin').disabled = false; return; }
      showWait(false); status('Подключено! Ждём, пока хост начнёт игру…');
    });
  };
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

  const auto = params.get('auto');
  if (auto === 'host') setTimeout(() => $('btnHost').click(), 300);
  if (auto === 'join') { $('code').value = params.get('code') || ''; setTimeout(() => $('btnJoin').click(), 300); }
  if (auto === 'solo') setTimeout(() => GAME.hostGame({ name: myName(), char: chosen }, () => GAME.startAsHost()), 300);
})();
