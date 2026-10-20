(() => {
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const grids = { Favorites: $('favoriteFaces'), Recent: $('recentFaces'), Basic: $('basicFaces') };
  const previews = new Map();
  let favoriteEntries = [], order = 'original', preferenceKey = '', faceRequest, chosenOrder;
  const sortedFavorites = () => order === 'reverse' ? [...favoriteEntries].reverse() : favoriteEntries;
  let state = {}, opened = false, active = 'Favorites', choosing = false, focusFavorites = false, faceCount = 48, more = false;
  const post = (type, extra = {}) => api.postMessage({ type, account: state.account, key: state.key, ...extra });
  const status = (id, text) => { $(id).textContent = text; $(id).hidden = !text; };
  const focus = button => { if (button) { button.focus(); button.scrollIntoView({ block: 'nearest' }); } };
  const tab = name => {
    active = name;
    $('stickerList').hidden = name !== 'Favorites';
    grids.Basic.hidden = name !== 'Basic';
    grids.Favorites.hidden = grids.Recent.hidden = name !== 'Favorites';
    for (const key of ['Favorites','Basic']) $('tab' + key).setAttribute('aria-selected', String(key === name));
    $('emojiOrder').hidden = name !== 'Favorites'; document.querySelector('.order-label').hidden = name !== 'Favorites';
    $('reloadFaces').hidden = name !== 'Favorites';
    $('favoriteStatus').hidden = name !== 'Favorites' || !$('favoriteStatus').textContent;
    queueFill();
  };
  const load = count => { faceCount = count; faceRequest = crypto.randomUUID(); $('emojiOrder').disabled = true; status('error', ''); status('favoriteStatus', '正在读取…'); post('faces', { requestId: faceRequest }); };
  const choose = (type, id) => { if (choosing) return; choosing = true; status('error', ''); post(type, { id }); };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); post('favoritePreview', { id: entry.target.dataset.id }); }
  }, { rootMargin: '60px' });
  const render = (grid, entries, append = false) => {
    if (!append) {
      for (const button of grid.querySelectorAll('button')) { observer.unobserve(button); previews.delete(button.dataset.id); }
      grid.replaceChildren();
    }
    if (!append && !entries.length) { const empty = document.createElement('span'); empty.className = 'empty'; empty.textContent = grid === grids.Recent ? '暂无最近使用' : '暂无表情'; grid.append(empty); }
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
  const appendFavorites = (minimum = faceCount + 48) => {
    if (!more || active !== 'Favorites' || $('emojiOrder').disabled) return false;
    const start = faceCount;
    faceCount = Math.min(favoriteEntries.length, Math.max(faceCount + 48, minimum));
    render(grids.Favorites, sortedFavorites().slice(start, faceCount), true);
    more = favoriteEntries.length > faceCount;
    return true;
  };
  let fillScheduled = false;
  const queueFill = () => {
    if (fillScheduled) return;
    fillScheduled = true;
    requestAnimationFrame(() => {
      fillScheduled = false;
      const list = $('stickerList');
      if (list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight <= 8 && appendFavorites()) queueFill();
    });
  };
  $('stickerList').addEventListener('scroll', queueFill, { passive: true });
  new ResizeObserver(queueFill).observe($('stickerList'));
  const renderFavorites = () => {
    const scroll = $('stickerList').scrollTop;
    const selected = grids.Favorites.contains(document.activeElement) ? document.activeElement.dataset.id : undefined;
    render(grids.Favorites, sortedFavorites().slice(0, faceCount));
    more = favoriteEntries.length > faceCount; tab(active);
    if (selected) [...grids.Favorites.querySelectorAll('button')].find(button => button.dataset.id === selected)?.focus({ preventScroll: true });
    $('stickerList').scrollTop = scroll;
  };
  const firstSticker = () => grids.Recent.querySelector('button') || grids.Favorites.querySelector('button');
  const focusFirstSticker = () => { firstSticker()?.focus({ preventScroll: true }); $('stickerList').scrollTop = 0; };
  for (const name of ['Favorites', 'Basic']) $('tab' + name).addEventListener('click', () => { focusFavorites = false; tab(name); if (name === 'Favorites') focusFirstSticker(); else focus(grids.Basic.querySelector('button')); });
  $('emojiOrder').addEventListener('change', () => {
    order = $('emojiOrder').value; chosenOrder = { key: preferenceKey, order }; renderFavorites(); $('stickerList').scrollTop = 0;
    post('emojiOrder', { order, preferenceKey });
  });
  $('closeEmojis').addEventListener('click', () => post('closeEmojis'));
  $('reloadFaces').addEventListener('click', () => load(faceCount));
  $('emojiPanel').addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); post('closeEmojis'); return; }
    const button = event.target.closest('.faceGrid button'); if (!button) return;
    if (event.key === 'Enter') { event.preventDefault(); if (!event.repeat) button.click(); return; }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); focusFavorites = false;
    const section = [...button.parentElement.querySelectorAll('button')];
    let items = active === 'Basic' ? section : [...grids.Recent.querySelectorAll('button'), ...grids.Favorites.querySelectorAll('button')];
    const index = items.indexOf(button);
    const columns = Math.max(1, section.filter(b => b.offsetTop === section[0].offsetTop).length);
    let next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns })[event.key];
    if (active === 'Favorites' && (event.key === 'End' || next >= items.length) && appendFavorites(event.key === 'End' ? favoriteEntries.length : next - grids.Recent.querySelectorAll('button').length + 1)) {
      items = [...grids.Recent.querySelectorAll('button'), ...grids.Favorites.querySelectorAll('button')];
      if (event.key === 'End') next = items.length - 1;
    }
    if (active !== 'Basic' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const local = section.indexOf(button), other = button.parentElement === grids.Recent ? grids.Favorites : grids.Recent;
      if ((event.key === 'ArrowDown' && local + columns >= section.length && other === grids.Favorites) || (event.key === 'ArrowUp' && local - columns < 0 && other === grids.Recent)) {
        const candidates = [...other.querySelectorAll('button')];
        if (candidates.length) {
          const lastRow = candidates.filter(b => b.offsetTop === candidates[candidates.length - 1].offsetTop);
          const row = event.key === 'ArrowUp' ? lastRow : candidates.slice(0, columns);
          next = items.indexOf(row[Math.min(local % columns, row.length - 1)]);
        }
      }
    }
    focus(items[Math.max(0, Math.min(items.length - 1, next))]);
    queueFill();
  });
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') {
      const changed = state.account !== data.account || state.key !== data.key || state.ready !== data.ready;
      if (changed) { favoriteEntries = []; preferenceKey = ''; chosenOrder = undefined; $('emojiOrder').disabled = true; observer.disconnect(); previews.clear(); for (const grid of Object.values(grids)) grid.replaceChildren(); choosing = false; status('error', ''); }
      state = data;
      if (changed && opened && data.visible && data.account && data.key) {
        focusFavorites = false; more = false; tab(active); load(48);
      }
    } else if (data.type === 'showEmojis') { opened = true; choosing = false; focusFavorites = true; more = false; tab('Favorites'); $('closeEmojis').focus(); load(48); }
    else if (data.account === state.account && data.key === state.key) {
      if (data.requestId !== undefined && data.requestId !== faceRequest) return;
      if (data.type === 'selectionComplete') choosing = false;
      else if (data.type === 'error') { choosing = false; status('error', data.message); status('favoriteStatus', ''); }
      else if (data.type === 'basicFaces') render(grids.Basic, data.faces.map(f => ({ id: 'face:' + f.id, faceId: f.id, label: f.name, icon: f.icon })));
      else if (data.type === 'recentFaces') {
        const selected = grids.Recent.contains(document.activeElement) ? document.activeElement.dataset.id : undefined;
        render(grids.Recent, data.entries);
        if (selected) focus([...grids.Recent.querySelectorAll('button')].find(button => button.dataset.id === selected));
      }
      else if (data.type === 'favoriteFaces') {
        const selected = grids.Favorites.contains(document.activeElement) ? document.activeElement.dataset.id : undefined;
        favoriteEntries = data.entries; preferenceKey = data.preferenceKey; order = chosenOrder?.key === preferenceKey ? chosenOrder.order : data.order || 'original'; $('emojiOrder').value = order; $('emojiOrder').disabled = false;
        renderFavorites(); status('favoriteStatus', '');
        if (focusFavorites) { focusFirstSticker(); focusFavorites = false; }
        else if (selected) focus([...grids.Favorites.querySelectorAll('button')].find(button => button.dataset.id === selected));
      } else if (data.type === 'favoritePreview' && previews.has(data.id)) previews.get(data.id).src = data.src;
      else if (data.type === 'favoritePreviewError' && previews.has(data.id)) {
        const image = previews.get(data.id), button = image.parentElement, hint = button.querySelector('span');
        image.hidden = true; hint.hidden = false; hint.textContent = '重试'; button.dataset.failed = 'true'; button.title = data.message;
      }
    }
  });
  post('ready');
})();
