(() => {
  'use strict';
  const platforms = {
    woowtech: { label: 'Woowtech Smart', url: 'https://smart.woowtech.io' },
    apporo: { label: 'Apporo Smart', url: 'https://smart.apporo.ai' },
    paseo: { label: 'Paseo 官方版', url: 'https://app.paseo.sh' }
  };
  const storageKey = 'agent-connect-guide:manual-checks:v1';
  const checks = [...document.querySelectorAll('[data-check]')];
  const tabs = [...document.querySelectorAll('[data-platform]')];
  const panels = [...document.querySelectorAll('[data-panel]')];
  const form = document.querySelector('#report-form');
  const output = document.querySelector('#report-output');
  const status = document.querySelector('#action-status');
  let current = 'woowtech';
  let saved = {};
  const drafts = {};
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const id of Object.keys(platforms)) {
        saved[id] = {};
        for (const check of checks) saved[id][check.dataset.check] = raw[id]?.[check.dataset.check] === true;
      }
    }
  } catch (_) { /* Manual checks still work without browser storage. */ }
  function say(message) { status.textContent = message; }
  function report() {
    const data = new FormData(form);
    const clean = name => String(data.get(name) || '').trim();
    const rows = checks.map(check => `${check.checked ? '[已確認]' : '[尚未確認]'} ${check.nextElementSibling.textContent.trim()}`);
    return [
      'Agent Connect 手動實測回報',
      `產生時間：${new Date().toLocaleString('zh-TW', { hour12: false })}`,
      `本次平台：${platforms[current].label}`,
      `平台網址：${platforms[current].url}`,
      `測試者：${clean('tester') || '未填'}`,
      `主機顯示名稱：${clean('host') || '未填'}`,
      `瀏覽器／裝置：${clean('device') || '未填'}`,
      `實際模型：${clean('model') || '未填'}`,
      `結果判定（測試者填寫）：${clean('verdict')}`,
      '', '手動檢查項目（不代表系統自動驗證）：', ...rows, '',
      `測完最後停留的平台：${clean('finalPlatform')}`,
      `卡住步驟／錯誤／補充：${clean('notes') || '未填'}`, '',
      '教學版本：2026-11-26 · Agent Connect 外掛 rc.2／rc.3',
      '請先移除任何配對邀請、密碼、token 或金鑰，再交付回報。'
    ].join('\n');
  }
  function renderReport() { output.textContent = report(); }
  function progress() {
    const count = checks.filter(check => check.checked).length;
    document.querySelector('#check-count').textContent = `${count} / ${checks.length} 已確認`;
    document.querySelector('#check-progress').value = count;
    renderReport();
  }
  function activate(id, updateHash = false) {
    if (!Object.prototype.hasOwnProperty.call(platforms, id)) return;
    for (const name of ['verdict', 'notes', 'model', 'finalPlatform']) {
      (drafts[current] ||= {})[name] = form.elements[name].value;
    }
    current = id;
    for (const tab of tabs) {
      const selected = tab.dataset.platform === id;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const panel of panels) panel.hidden = panel.dataset.panel !== id;
    for (const name of document.querySelectorAll('[data-current-platform]')) name.textContent = platforms[id].label;
    for (const check of checks) check.checked = saved[id]?.[check.dataset.check] === true;
    if (updateHash) history.replaceState(null, '', `#${id}`);
    // Platform-specific drafts stay in memory only, so switching platforms cannot mix or discard a result.
    for (const name of ['verdict', 'notes', 'model', 'finalPlatform']) {
      form.elements[name].value = drafts[id]?.[name] ?? ({verdict:'尚未完成',finalPlatform:'未變更／同本次平台'}[name] || '');
    }
    say('');
    progress();
  }
  function persist() {
    saved[current] = Object.fromEntries(checks.map(check => [check.dataset.check, check.checked]));
    try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch (_) { /* Optional. */ }
    progress();
  }
  async function copy(value, message) {
    try { await navigator.clipboard.writeText(value); say(message); }
    catch (_) {
      const area = document.createElement('textarea');
      area.value = value; area.style.position = 'fixed'; area.style.opacity = '0';
      document.body.append(area); area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) { /* User can copy the preview. */ }
      area.remove();
      say(ok ? message : '瀏覽器不允許複製，請展開回報預覽並手動選取，或下載文字檔。');
    }
  }
  function safeReport() {
    const value = report();
    if (/#offer\s*=|access_token\s*[=:]|refresh_token\s*[=:]|BEGIN [A-Z ]*PRIVATE KEY/i.test(value)) {
      say('回報中可能有配對邀請或憑證，請先移除後再複製或下載。');
      return null;
    }
    return value;
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab.dataset.platform, true));
    tab.addEventListener('keydown', event => {
      const index = tabs.indexOf(tab);
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); activate(tabs[next].dataset.platform, true); tabs[next].focus(); }
    });
  }
  window.addEventListener('hashchange', () => activate(location.hash.slice(1)));
  for (const check of checks) check.addEventListener('change', persist);
  form.addEventListener('submit', event => event.preventDefault());
  form.addEventListener('input', renderReport);
  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', () => void copy(document.getElementById(button.dataset.copy).textContent, '測試訊息已複製，請貼到所選平台的對話中。'));
  }
  document.querySelector('#copy-report').addEventListener('click', () => {
    const value = safeReport();
    if (value) void copy(value, '實測回報已複製，請交給團隊指定的回報管道。');
  });
  document.querySelector('#download-report').addEventListener('click', () => {
    const value = safeReport(); if (!value) return;
    const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url; link.download = `agent-connect-${current}-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say('文字回報已下載，請透過團隊指定的管道交付。');
  });
  document.querySelector('#reset-checks').addEventListener('click', () => {
    for (const check of checks) check.checked = false;
    persist(); say('已清除本平台的六項勾選，其他平台保留。');
  });
  document.querySelector('#print-guide').addEventListener('click', () => window.print());
  activate(Object.prototype.hasOwnProperty.call(platforms, location.hash.slice(1)) ? location.hash.slice(1) : 'woowtech');
})();
