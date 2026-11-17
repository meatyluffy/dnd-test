// Lobby: hero choice, hosting / joining a room, roster.
(function () {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let chosen = localStorage.getItem('velk_hero') || 'lukaris';
  try { $('name').value = localStorage.getItem('velk_name') || ''; } catch (e) {}

  const heroesEl = $('heroes');
  for (const key of ['lukaris', 'soreen']) {
    const h = HEROES[key];
    const div = document.createElement('div');
    div.className = 'hero' + (key === chosen ? ' sel' : '');
    div.dataset.key = key;
    const sk = Object.values(h.skills).map(s => `<li><b style="font-size:14px;font-family:inherit;color:#e8c27a">${s.name}</b>${s.desc ? ' — ' + s.desc : ''}</li>`).join('');
    div.innerHTML = `<div class="top"><img src="assets/ui/portrait_${key}.webp"><div><b>${h.name}</b><br><small>${h.cls} · ${h.hp} HP</small></div></div><ul>${sk}<li><i>${h.passive}</i></li></ul>`;
    div.onclick = () => { chosen = key; document.querySelectorAll('.hero').forEach(x => x.classList.toggle('sel', x.dataset.key === key)); try { localStorage.setItem('velk_hero', key); } catch (e) {} };
    heroesEl.appendChild(div);
  }

  // controls table
  const ACT = [['Движение', null], ['Ближний удар', 'melee'], ['Заклинание 1', 'k'], ['Заклинание 2', 'l'], ['Заклинание 3', 'i'], ['Заклинание 4', 'o'], ['Заклинание 5', 'u'], ['Рывок / уклонение', 'dash']];
  const PADN = { melee: 'X / □', k: 'Y / △', l: 'B / ○', i: 'A / ✕', o: 'LB / L1', u: 'LT / L2', dash: 'RB / R1 (или RT)' };
  const KL = (k) => ({ SPACE: 'Пробел', UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' }[k] || k);
  function renderKeys() {
    const sch = (() => { try { return localStorage.getItem('velk_scheme') || 'wasd'; } catch (e) { return 'wasd'; } })();
    document.querySelectorAll('input[name=scheme]').forEach(r => r.checked = r.value === sch);
    const B = BINDS[sch];
    const rows = ACT.map(([n, a]) => `<tr><td>${n}</td><td><kbd>${a ? KL(B[a]) : (sch === 'wasd' ? 'W A S D' : '← ↑ → ↓')}</kbd></td><td><kbd>${a ? PADN[a] : 'Левый стик / крестовина'}</kbd></td></tr>`).join('');
    $('keys').innerHTML = `<table><tr><th>Действие</th><th>Клавиатура</th><th>Геймпад (Xbox / PS)</th></tr>${rows}</table>
      <div style="margin-top:6px">У Сорина два заклинания, у Лукариса — пять. Упавшего союзника поднимают, встав рядом (Лукарис — втрое быстрее).</div>`;
  }
  document.querySelectorAll('input[name=scheme]').forEach(r => r.onchange = () => { try { localStorage.setItem('velk_scheme', r.value); } catch (e) {} S.scheme = r.value; renderKeys(); });
  renderKeys();

  const status = (t) => { $('status').textContent = t; };
  const myName = () => { const n = $('name').value.trim() || (chosen === 'lukaris' ? 'Лукарис' : 'Сорин'); try { localStorage.setItem('velk_name', n); } catch (e) {} return n; };

  function showWait(isHost) {
    $('menu').style.display = 'none'; $('wait').style.display = 'block';
    $('hostInfo').style.display = isHost ? 'flex' : 'none';
    $('btnStart').style.display = isHost ? 'inline-block' : 'none';
  }

  window.LOBBY = {
    roster(list) {
      $('roster').innerHTML = list.map(p => `<span style="color:#${p.color.toString(16).padStart(6, '0')}">● ${p.name}</span> — ${HEROES[p.char].name}`).join('<br>');
    },
    status,
  };

  $('btnHost').onclick = () => {
    status('Создаю комнату…');
    $('btnHost').disabled = true;
    GAME.hostGame({ name: myName(), char: chosen }, (err, code) => {
      if (err) {
        if (window.__hostShown) return;
        status('Сервер соединения недоступен (' + err + '). Можно сыграть одному или попробовать ещё раз.');
        $('btnHost').disabled = false; $('btnSolo').style.display = 'inline-block'; return;
      }
      window.__hostShown = true;
      showWait(true);
      $('roomcode').textContent = code;
      status('Отправь код друзьям. Начать можно и одному.');
    });
  };
  $('btnCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('roomcode').textContent); status('Код скопирован'); };
  $('btnStart').onclick = () => GAME.startAsHost();
  $('btnSolo').onclick = () => GAME.startAsHost();
  $('btnJoin').onclick = () => {
    const code = $('code').value.trim();
    if (code.length < 4) { status('Введи код комнаты'); return; }
    status('Подключаюсь…');
    $('btnJoin').disabled = true;
    GAME.joinGame(code, { name: myName(), char: chosen }, (err) => {
      if (err) { status('Не получилось подключиться (' + (err.type || err.message || err) + '). Проверь код или попробуй VPN-сеть вроде Radmin/Tailscale.'); $('btnJoin').disabled = false; return; }
      showWait(false);
      status('Подключено! Ждём, пока хост начнёт бой…');
    });
  };
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });

  // automation hooks for tests: ?auto=host / ?auto=join&code=XXXXX
  const auto = params.get('auto');
  if (params.get('hero')) chosen = params.get('hero');
  if (params.get('name')) $('name').value = params.get('name');
  if (auto === 'host') setTimeout(() => $('btnHost').click(), 300);
  if (auto === 'join') { $('code').value = params.get('code') || ''; setTimeout(() => $('btnJoin').click(), 300); }
  if (auto === 'solo') setTimeout(() => { GAME.hostGame({ name: myName(), char: chosen }, () => GAME.startAsHost()); }, 300);
})();
