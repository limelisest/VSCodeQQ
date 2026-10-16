(() => {
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const grids = { Favorites: $('favoriteFaces'), Recent: $('recentFaces'), Basic: $('basicFaces') };
  const previews = new Map();
  let state = {}, opened = false, active = 'Favorites', choosing = false, focusFavorites = false, faceCount = 48, more = false;
  const post = (type, extra = {}) => api.postMessage({ type, account: state.account, key: state.key, ...extra });
  const status = (id, text) => { $(id).textContent = text; $(id).hidden = !text; };
  const focus = button => { if (button) { button.focus(); button.scrollIntoView({ block: 'nearest' }); } };
  const tab = name => {
    active = name;
    for (const [key, grid] of Object.entries(grids)) { grid.hidden = key !== name; $('tab' + key).setAttribute('aria-selected', String(key === name)); }
    $('reloadFaces').hidden = name !== 'Favorites'; $('moreFaces').hidden = name !== 'Favorites' || !more;
    $('favoriteStatus').hidden = name !== 'Favorites' || !$('favoriteStatus').textContent;
  };
  const load = count => { faceCount = count; status('error', ''); status('favoriteStatus', '正在读取…'); post('faces', { count }); };
  const choose = (type, id) => { if (choosing) return; choosing = true; status('error', ''); post(type, { id }); };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); post('favoritePreview', { id: entry.target.dataset.id }); }
  }, { rootMargin: '60px' });
  const render = (grid, entries) => {
    for (const button of grid.querySelectorAll('button')) { observer.unobserve(button); previews.delete(button.dataset.id); }
    grid.replaceChildren();
    if (!entries.length) { const empty = document.createElement('span'); empty.className = 'empty'; empty.textContent = grid === grids.Recent ? '暂无最近使用' : '暂无表情'; grid.append(empty); }
    for (const entry of entries) {
      const button = document.createElement('button'); button.title = entry.label; button.setAttribute('aria-label', entry.label); button.dataset.id = entry.id;
      if (entry.faceId) { button.textContent = entry.icon; button.className = 'basicFace'; button.addEventListener('click', () => choose('basicFace', entry.faceId)); grid.append(button); continue; }
      const image = document.createElement('img'); image.alt = entry.label; image.hidden = true;
      const hint = document.createElement('span'); hint.textContent = '…';
      previews.set(entry.id, image); button.append(image, hint);
      image.onload = () => { image.hidden = false; hint.hidden = true; button.dataset.failed = ''; };
      image.onerror = () => { image.hidden = true; hint.hidden = false; hint.textContent = '重试'; button.dataset.failed = 'true'; };
      button.addEventListener('click', () => { if (button.dataset.failed) { hint.textContent = '…'; post('favoritePreview', { id: entry.id }); } else choose('favoriteFace', entry.id); });
      grid.append(button); observer.observe(button);
    }
  };
  for (const name of Object.keys(grids)) $('tab' + name).addEventListener('click', () => { focusFavorites = false; tab(name); focus(grids[name].querySelector('button')); });
  $('closeEmojis').addEventListener('click', () => post('closeEmojis'));
  $('reloadFaces').addEventListener('click', () => load(faceCount));
  $('moreFaces').addEventListener('click', () => load(Math.min(500, faceCount + 48)));
  $('emojiPanel').addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); post('closeEmojis'); return; }
    const button = event.target.closest('.faceGrid button'); if (!button) return;
    if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) button.click(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); focusFavorites = false;
    const items = [...button.parentElement.querySelectorAll('button')], index = items.indexOf(button);
    const columns = Math.max(1, items.filter(b => b.offsetTop === items[0].offsetTop).length);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns })[event.key];
    focus(items[Math.max(0, Math.min(items.length - 1, next))]);
  });
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') {
      const changed = state.account !== data.account || state.key !== data.key || state.ready !== data.ready;
      if (changed) { observer.disconnect(); previews.clear(); for (const grid of Object.values(grids)) grid.replaceChildren(); choosing = false; status('error', ''); }
      state = data;
      if (changed && opened && data.visible && data.account && data.key) {
        focusFavorites = false; more = false; tab(active); load(48);
      }
    } else if (data.type === 'showEmojis') { opened = true; choosing = false; focusFavorites = true; more = false; tab('Favorites'); $('closeEmojis').focus(); load(48); }
    else if (data.account === state.account && data.key === state.key) {
      if (data.type === 'selectionComplete') choosing = false;
      else if (data.type === 'error') { choosing = false; status('error', data.message); status('favoriteStatus', ''); }
      else if (data.type === 'basicFaces') render(grids.Basic, data.faces.map(f => ({ id: 'face:' + f.id, faceId: f.id, label: f.name, icon: f.icon })));
      else if (data.type === 'recentFaces') {
        const selected = grids.Recent.contains(document.activeElement) ? document.activeElement.dataset.id : undefined;
        render(grids.Recent, data.entries);
        if (selected) focus([...grids.Recent.querySelectorAll('button')].find(button => button.dataset.id === selected));
      }
      else if (data.type === 'favoriteFaces') {
        render(grids.Favorites, data.entries); status('favoriteStatus', ''); more = data.more; tab(active);
        if (focusFavorites) { focus(grids.Favorites.querySelector('button')); focusFavorites = false; }
      } else if (data.type === 'favoritePreview' && previews.has(data.id)) previews.get(data.id).src = data.src;
      else if (data.type === 'favoritePreviewError' && previews.has(data.id)) {
        const image = previews.get(data.id), button = image.parentElement, hint = button.querySelector('span');
        image.hidden = true; hint.hidden = false; hint.textContent = '重试'; button.dataset.failed = 'true'; button.title = data.message;
      }
    }
  });
  post('ready');
})();
