(() => {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let busy = true;

  if ($('fields')) $('fields').disabled = true;

  // Alert & Feedback Banner
  function showAlert(msg, type = 'info') {
    const alert = $('statusAlert');
    if (!alert) return;
    alert.className = `status-alert ${type}`;
    const textNode = $('statusMsg');
    if (textNode) textNode.textContent = msg;
    const iconNode = $('statusIcon');
    if (iconNode) {
      iconNode.textContent = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
    }
  }

  function hideAlert() {
    const alert = $('statusAlert');
    if (alert) alert.className = 'status-alert hidden';
  }

  const alertCloseBtn = $('statusClose');
  if (alertCloseBtn) alertCloseBtn.addEventListener('click', hideAlert);

  // Realtime Color & Syntax Previews
  function updateColorPreviews() {
    const mention = $('mentionColor')?.value || '#E5A030';
    const reply = $('replyColor')?.value || '#409CFF';

    if ($('mentionColorVal')) $('mentionColorVal').textContent = mention.toUpperCase();
    if ($('replyColorVal')) $('replyColorVal').textContent = reply.toUpperCase();

    const prevMention = $('prevMention');
    if (prevMention) {
      prevMention.style.borderLeftColor = mention;
      prevMention.style.backgroundColor = mention + '22';
    }

    const prevReply = $('prevReply');
    if (prevReply) {
      prevReply.style.borderLeftColor = reply;
      prevReply.style.backgroundColor = reply + '22';
    }
  }

  for (const id of ['mentionColor', 'replyColor']) {
    const el = $(id);
    if (el) {
      el.addEventListener('input', updateColorPreviews);
      el.addEventListener('change', updateColorPreviews);
    }
  }

  // Update Status Badge
  function updateBadge(connected, note) {
    const badge = $('connBadge');
    const text = $('connBadgeText');
    if (!badge || !text) return;
    badge.className = `conn-badge ${connected ? 'connected' : 'disconnected'}`;
    text.textContent = note || (connected ? '已就绪' : '未连接');
  }

  // Action Dispatcher
  const send = action => {
    if (busy) return;
    if (!['import', 'cleanCache'].includes(action) && !$('settings').reportValidity()) return;
    busy = true;
    if ($('fields')) $('fields').disabled = true;

    const actionText = action === 'test' ? '正在测试连接…'
      : action === 'import' ? '正在等待选择配置文件…'
      : action === 'cleanCache' ? '正在清理缓存…'
      : '正在保存配置…';
    showAlert(actionText, 'info');

    vscode.postMessage({
      action,
      codeLanguage: $('codeLanguage').value,
      historyCount: Number($('historyCount').value),
      messageLimit: Number($('messageLimit').value),
      cacheRetentionDays: Number($('cacheRetentionDays').value),
      notifications: $('notifications').value,
      mentionColor: $('mentionColor').value,
      replyColor: $('replyColor').value,
      url: $('url').value,
      token: $('token').value,
      clearToken: $('clearToken').checked,
      autoConnect: $('autoConnect').checked
    });
  };

  $('settings').addEventListener('submit', event => {
    event.preventDefault();
    send('connect');
  });

  for (const action of ['save', 'test', 'import', 'cleanCache']) {
    const btn = $(action);
    if (btn) btn.addEventListener('click', () => send(action));
  }

  $('clearToken').addEventListener('change', () => {
    $('token').disabled = $('clearToken').checked;
  });

  // Message Handler from Host
  window.addEventListener('message', event => {
    const data = event.data;
    if (data.state) {
      for (const key of ['historyCount', 'messageLimit', 'cacheRetentionDays', 'notifications', 'mentionColor', 'replyColor']) {
        if ($(key)) $(key).value = data.state[key];
      }
      if ($('cacheInfo')) {
        $('cacheInfo').textContent = `${data.state.cache.count} 个文件 · ${(data.state.cache.bytes / 1048576).toFixed(1)} MB`;
      }
      if ($('url')) $('url').value = data.state.url;
      if ($('autoConnect')) $('autoConnect').checked = data.state.autoConnect;
      if ($('codeLanguage')) $('codeLanguage').value = data.state.codeLanguage;

      if ($('token')) {
        $('token').value = '';
        $('token').placeholder = data.state.hasToken ? '已保存 Token（留空保持不变）' : '未启用鉴权可直接留空';
        $('token').disabled = false;
      }
      if ($('clearToken')) $('clearToken').checked = false;

      updateColorPreviews();
      updateBadge(true, '已就绪');
    }

    if (data.error) {
      showAlert(data.error, 'error');
      if (data.error.includes('连接失败')) updateBadge(false, '连接失败');
    } else if (data.message) {
      showAlert(data.message, 'success');
      if (data.message.includes('连接成功') || data.message.includes('已连接')) {
        updateBadge(true, '连接成功');
      }
    } else {
      hideAlert();
    }

    busy = false;
    if ($('fields')) $('fields').disabled = false;
  });

  vscode.postMessage({ action: 'ready' });
})();
