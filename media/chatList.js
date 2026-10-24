const vscode = acquireVsCodeApi(), input = document.getElementById('search'), results = document.getElementById('results');
let palette = {}, rows = [], account = '', selected = '', active = '', showAvatars = true, composing = false, touched = false, collapsed = !!vscode.getState()?.collapsed;
const avatarImages = new Map();
function save() { vscode.setState({ query: input.value, collapsed }); }
input.value = vscode.getState()?.query || '';
function send(type, key) { vscode.postMessage({ type, key, account }); }
function icon(name) { const node = document.createElement('span'); node.className = 'codicon codicon-' + name; node.setAttribute('aria-hidden', 'true'); node.textContent = String.fromCodePoint({ account: 0xeb99, organization: 0xea7e, mail: 0xeb1c, 'star-full': 0xeb59, 'star-empty': 0xea6a, archive: 0xea98, discard: 0xeae2, search: 0xea6d, close: 0xea76 }[name]); return node; }
function boxIcon() { return icon('archive'); }
function unreadBadge(unread, muted, prefix = '') { const count = document.createElement('span'); count.className = 'count' + (muted ? ' muted' : ''); count.textContent = prefix + (unread > 99 ? '99+' : unread); if (!muted) {
    const color = palette[prefix.startsWith('@') ? 'mentionColor' : prefix.startsWith('↩') ? 'replyColor' : 'unreadColor'];
    if (/^#[0-9a-f]{6}$/i.test(color)) {
        count.style.backgroundColor = color;
        const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
        count.style.color = (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 150 ? '#111827' : '#ffffff';
    }
} count.title = unread + ' 条未读' + (muted ? ' · 不提醒' : ''); return count; }
function avatar(row, kind) {
    const node = document.createElement('div');
    node.className = 'avatar';
    node.append(kind);
    if (showAvatars && row.avatar) {
        let image = avatarImages.get(row.avatar);
        if (!image) {
            image = document.createElement('img');
            image.alt = '';
            image.loading = 'lazy';
            image.decoding = 'async';
            image.referrerPolicy = 'no-referrer';
            image.draggable = false;
            image.onload = () => { image.hidden = false; };
            image.onerror = () => { image.hidden = true; };
            image.src = row.avatar;
            avatarImages.set(row.avatar, image);
        }
        node.append(image);
    }
    return node;
}
function messageTime(seconds) {
    if (!seconds)
        return;
    const date = new Date(seconds * 1000), now = new Date(), yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const node = document.createElement('time');
    node.className = 'time';
    node.dateTime = date.toISOString();
    node.title = date.toLocaleString();
    node.textContent = date.toDateString() === now.toDateString() ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : date.toDateString() === yesterday.toDateString() ? '昨天' : date.getFullYear() === now.getFullYear() ? (date.getMonth() + 1) + '/' + date.getDate() : date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();
    return node;
}
function render() {
    const focused = results.contains(document.activeElement), scroll = results.scrollTop, terms = input.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const visible = rows.filter(row => terms.every(term => row.search.includes(term)) && (terms.length > 0 || row.hasMessages && row.collapsed === collapsed));
    const entry = document.getElementById('collapsed');
    if (entry) {
        const folded = rows.filter(row => row.collapsed && row.hasMessages), unread = folded.reduce((n, row) => n + row.unread, 0);
        entry.replaceChildren(boxIcon(), document.createTextNode((collapsed ? '← 返回列表 · ' : '') + '收纳箱 (' + folded.length + ')'));
        if (unread)
            entry.append(unreadBadge(unread, !folded.some(row => row.unread && !row.muted)));
        entry.setAttribute('aria-pressed', String(collapsed));
        results.setAttribute('aria-label', collapsed ? '收纳箱' : '会话列表');
    }
    if (!visible.some(row => row.key === selected))
        selected = visible.find(row => row.key === active)?.key || visible[0]?.key || '';
    const fragment = document.createDocumentFragment();
    for (const row of visible) {
        const item = document.createElement('div');
        item.className = 'row' + (row.key === selected ? ' selected' : '') + (row.favorite ? ' starred' : '') + (row.key === active ? ' active' : '') + (row.muted ? ' muted' : '') + (row.unread ? ' unread' : '');
        item.dataset.key = row.key;
        item.tabIndex = row.key === selected ? 0 : -1;
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(row.key === selected));
        if (row.key === active)
            item.setAttribute('aria-current', 'true');
        item.title = row.tooltip || row.name;
        item.dataset.vscodeContext = JSON.stringify({ webviewSection: 'qq-chat-row', key: row.key, account, chatType: row.kind, preventDefaultContextMenuItems: true });
        const kind = icon(row.system ? 'mail' : row.kind === 'group' ? 'organization' : 'account');
        kind.classList.add('kind');
        kind.title = row.system ? '系统通知' : row.kind === 'group' ? '群聊' : '好友';
        kind.removeAttribute('aria-hidden');
        kind.setAttribute('role', 'img');
        kind.setAttribute('aria-label', kind.title);
        const text = document.createElement('div');
        text.className = 'text';
        const heading = document.createElement('div');
        heading.className = 'row-heading';
        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = row.name;
        heading.append(name);
        if (row.favorite) {
            const favorite = icon('star-full');
            favorite.classList.add('favorite-indicator');
            favorite.title = '已收藏';
            heading.append(favorite);
        }
        const preview = document.createElement('div');
        preview.className = 'preview';
        preview.textContent = (row.muted ? '◦ ' : '') + (row.preview || row.id);
        text.append(heading, preview);
        item.append(avatar(row, kind), text);
        const meta = document.createElement('div');
        meta.className = 'row-meta';
        const time = messageTime(row.lastTime);
        if (time)
            meta.append(time);
        if (row.unread)
            meta.append(unreadBadge(row.unread, row.muted, row.mention ? '@ ' : row.reply ? '↩ ' : ''));
        const actions = document.createElement('div');
        actions.className = 'row-actions';
        const star = document.createElement('button');
        star.className = 'favorite' + (row.favorite ? ' saved' : '');
        star.append(icon(row.favorite ? 'star-full' : 'star-empty'));
        star.title = row.favorite ? '取消收藏' : '收藏';
        star.setAttribute('aria-label', star.title);
        star.dataset.action = 'favorite';
        actions.append(star);
        if (row.kind === 'group') {
            const fold = document.createElement('button');
            fold.className = 'fold';
            fold.append(icon(row.collapsed ? 'discard' : 'archive'));
            fold.title = row.collapsed ? '移出收纳箱' : '放入收纳箱';
            fold.setAttribute('aria-label', fold.title);
            fold.dataset.action = 'collapse';
            actions.append(fold);
        }
        meta.append(actions);
        item.append(meta);
        fragment.append(item);
    }
    results.replaceChildren(fragment);
    results.scrollTop = scroll;
    if (focused)
        [...results.children].find(row => row.dataset.key === selected)?.focus({ preventScroll: true });
    document.getElementById('empty').textContent = visible.length ? '' : input.value.trim() ? '没有匹配的会话' : collapsed ? '收纳箱暂无消息' : account ? '暂无消息记录，可搜索好友或群聊' : '请在下方设置中连接 OneBot 服务';
    document.getElementById('count').textContent = input.value.trim() ? visible.length + ' 个结果' : '';
}
function revealActive() { [...results.children].find(row => row.dataset.key === active)?.scrollIntoView({ block: 'nearest' }); }
function filter() { touched = true; save(); render(); vscode.postMessage({ type: 'filter', query: input.value }); }
function openChat(key) { if (input.value) {
    collapsed = false;
    input.value = '';
    filter();
} send('open', key); }
input.addEventListener('compositionstart', () => composing = true);
input.addEventListener('compositionend', () => { composing = false; filter(); });
input.addEventListener('input', () => { if (!composing)
    filter(); });
document.getElementById('clear').onclick = () => { input.value = ''; filter(); input.focus(); };
const collapsedEntry = document.getElementById('collapsed');
if (collapsedEntry)
    collapsedEntry.onclick = () => { collapsed = !collapsed; input.value = ''; filter(); save(); };
results.onclick = event => { const row = event.target.closest('.row'); if (!row)
    return; selected = row.dataset.key; const action = event.target.closest('[data-action]')?.dataset.action; if (action)
    send(action, selected);
else
    openChat(selected); };
document.addEventListener('keydown', event => {
    if (composing || event.isComposing)
        return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
        event.preventDefault();
        input.focus();
        input.select();
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        input.value = '';
        filter();
        input.focus();
        return;
    }
    const items = [...results.children];
    let index = items.findIndex(row => row.dataset.key === selected);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        index = document.activeElement === input ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
        const row = items[index];
        if (row) {
            selected = row.dataset.key;
            render();
            [...results.children][index].focus();
        }
        return;
    }
    if (event.key === 'Enter' && selected && document.activeElement.tagName !== 'BUTTON') {
        event.preventDefault();
        openChat(selected);
    }
});
window.addEventListener('message', ({ data }) => { if (data.type === 'rows') {
    const changed = active !== data.active || account !== data.account;
    if (account !== data.account || !data.showAvatars)
        avatarImages.clear();
    showAvatars = data.showAvatars;
    document.body.classList.toggle('show-avatars', showAvatars);
    rows = data.rows;
    palette = data.palette || {};
    account = data.account;
    active = data.active || '';
    if (changed && active)
        selected = active;
    render();
    if (changed || data.revealActive)
        revealActive();
}
else if (data.type === 'active') {
    if (data.account !== account)
        return;
    active = data.key;
    if (active)
        selected = active;
    render();
    revealActive();
}
else if (data.type === 'filter' || (data.type === 'initialFilter' && !touched)) {
    input.value = data.query;
    save();
    render();
}
else if (data.type === 'focus') {
    input.focus();
    input.select();
    vscode.postMessage({ type: 'focused' });
} });
document.querySelector('.search-field').prepend(icon('search'));
document.getElementById('clear').replaceChildren(icon('close'));
vscode.postMessage({ type: 'ready' });
