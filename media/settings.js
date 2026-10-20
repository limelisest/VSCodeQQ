(() => {
  const api = acquireVsCodeApi(), $ = id => document.getElementById(id);
  const pages = ['connection', 'appearance', 'config', 'cache'];
  let groups = {}, defaults = {}, active = 'connection', initialized = false, serial = 0, pending, queuedCache = false;
  const baseline = {}, restored = api.getState() || {};
  const value = id => $(id)?.hasAttribute('data-options') ? [...$(id).querySelectorAll('input:checked')].map(el => el.value) : $(id)?.type === 'checkbox' ? $(id).checked : $(id)?.type === 'number' ? Number($(id).value) : $(id)?.value;
  function setValue(id, next) {
    if ($(id).hasAttribute('data-options')) { for (const el of $(id).querySelectorAll('input')) el.checked = next.includes(el.value); }
    else if ($(id).type === 'checkbox') $(id).checked = next;
    else $(id).value = next;
  }
  const fields = page => page === 'connection' ? ['url', 'autoConnect', 'token', 'clearToken'] : groups[page] || [];
  const dirty = id => $(id)?.type === 'color' ? String(baseline[id] || '').toLowerCase() !== String(value(id)).toLowerCase() : JSON.stringify(Array.isArray(baseline[id]) ? [...baseline[id]].sort() : baseline[id]) !== JSON.stringify(Array.isArray(value(id)) ? value(id).sort() : value(id));
  function alert(message, error = false) {
    $('statusAlert').className = message ? 'status-alert ' + (error ? 'error' : 'success') : 'status-alert hidden';
    $('statusMsg').textContent = message || '';
  }
  function remember() {
    const drafts = {};
    for (const page of pages) {
      const changed = fields(page).some(dirty);
      document.querySelector(`[data-dirty="${page}"]`).textContent = changed ? '有未保存修改' : '';
      for (const id of fields(page)) if (id !== 'token' && id !== 'clearToken' && dirty(id)) drafts[id] = value(id);
    }
    api.setState({ page: active, drafts });
  }
  function previews() {
    for (const row of document.querySelectorAll('[data-preview]')) {
      const id = row.dataset.preview, color = $(id).value;
      $(id + 'Val').textContent = color.toUpperCase();
      row.style.borderLeftColor = color; row.style.backgroundColor = color + '22';
    }
  }
  function connection(state) {
    if (!state) return;
    $('connBadge').className = 'conn-badge ' + (state.connected ? 'connected' : 'disconnected');
    $('connBadgeText').textContent = state.status;
    $('connectionAccount').textContent = state.account ? '当前账号：' + state.account : '当前未连接账号';
    $('disconnect').hidden = !state.connected;
  }
  function cache(info) {
    if (!info) return;
    $('cacheInfo').textContent = info.ready === false ? '尚未加载账号缓存' : `${info.count} 个文件 · ${(info.bytes / 1048576).toFixed(1)} MB`;
    $('cacheBreakdown').textContent = (info.categories || []).map(item => `${item.name}：${(item.bytes / 1048576).toFixed(1)} MB`).join(' · ');
    $('cacheProtected').textContent = info.reclaimableBytes === undefined ? '' : `可清理 ${(info.reclaimableBytes / 1048576).toFixed(1)} MB · 受保护 ${(info.protectedBytes / 1048576).toFixed(1)} MB`;
    for (const action of ['cleanCache', 'openCache']) document.querySelector(`[data-action="${action}"]`).disabled = info.ready === false;
  }
  function select(page, notify = true) {
    active = pages.includes(page) ? page : 'connection';
    for (const id of pages) {
      $('page-' + id).hidden = id !== active;
      $('tab-' + id).setAttribute('aria-selected', String(id === active));
      $('tab-' + id).tabIndex = id === active ? 0 : -1;
    }
    if (initialized) {
      remember();
      if (notify) api.postMessage({ action: 'page', page: active });
      if (active === 'cache') request('cacheInfo');
    }
  }
  function renderState(state, savedPage) {
    for (const page of pages) for (const id of fields(page)) {
      if (id === 'token' || id === 'clearToken' || state[id] === undefined) continue;
      const keep = initialized && dirty(id) && savedPage !== page;
      baseline[id] = state[id];
      if (!keep) setValue(id, state[id]);
    }
    if (!initialized || savedPage === 'connection') { $('token').value = ''; $('clearToken').checked = false; baseline.token = ''; baseline.clearToken = false; }
    $('token').placeholder = state.hasToken ? '已保存 Token（留空保留）' : '未设置 Token';
    $('token').disabled = $('clearToken').checked;
    if (!initialized) for (const [id, draft] of Object.entries(restored.drafts || {})) if (id in baseline && id !== 'token' && id !== 'clearToken') {
      setValue(id, draft);
    }
    connection(state.connection); cache(state.cache); previews();
  }
  function request(action) {
    if (!initialized || pending) { if (action === 'cacheInfo') queuedCache = true; return; }
    if (action === 'defaults') { for (const id of fields(active)) if (id in defaults) setValue(id, defaults[id]); previews(); remember(); alert('已恢复默认值'); return; }
    const form = $('page-' + active);
    if (['save', 'connect', 'test'].includes(action) && !form.reportValidity()) return;
    const data = { action, page: active, requestId: ++serial };
    if (['save', 'connect', 'test'].includes(action)) for (const id of fields(active)) data[id] = value(id);
    pending = data;
    form.querySelector('fieldset').disabled = true;
    alert(action === 'cacheInfo' ? '正在计算缓存…' : action === 'test' ? '正在测试连接…' : '正在处理…');
    api.postMessage(data);
  }
  for (const page of pages) {
    $('tab-' + page).addEventListener('click', () => select(page));
    $('page-' + page).addEventListener('submit', event => { event.preventDefault(); request('save'); });
    $('page-' + page).addEventListener('input', () => { previews(); remember(); });
    $('page-' + page).addEventListener('change', () => { previews(); remember(); });
  }
  document.querySelector('.settings-tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = pages.indexOf(active), next = event.key === 'Home' ? 0 : event.key === 'End' ? pages.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + pages.length) % pages.length;
    select(pages[next]); $('tab-' + active).focus();
  });
  for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => request(button.dataset.action));
  $('statusClose').addEventListener('click', () => alert(''));
  $('clearToken').addEventListener('change', () => { $('token').disabled = $('clearToken').checked; });
  window.addEventListener('message', ({ data }) => {
    if (data.connection) connection(data.connection);
    if (!data.requestId) return;
    if (!pending || data.requestId !== pending.requestId) return;
    if (data.groups) groups = data.groups;
    if (data.defaults) defaults = data.defaults;
    if (data.state) renderState(data.state, data.savedPage);
    if (data.cache) cache(data.cache);
    const first = !initialized;
    initialized = true;
    for (const form of document.querySelectorAll('[data-page]')) form.querySelector('fieldset').disabled = false;
    $('token').disabled = $('clearToken').checked;
    pending = undefined;
    alert(data.error || data.message, !!data.error);
    remember();
    if (first) select(restored.page || data.page || 'connection', false);
    if (queuedCache && !pending) { queuedCache = false; if (active === 'cache') request('cacheInfo'); }
  });
  pending = { action: 'ready', requestId: ++serial };
  api.postMessage(pending);
})();
