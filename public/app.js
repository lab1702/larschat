(function () {
  'use strict';

  // State
  let currentName = null;
  let currentView = null; // 'channel' or 'dm'
  let currentChannelId = null;
  let currentDmName = null;
  let channels = [];
  let ws = null;
  let wsRetryDelay = 1000;
  let loadGeneration = 0;
  let currentDmPeerReadId = 0;

  // Unread message counts keyed by 'channel:<id>' or 'dm:<name>'
  const unreadCounts = new Map();

  function getUnread(key) {
    return unreadCounts.get(key) || 0;
  }

  function setUnread(key, count) {
    if (count > 0) {
      unreadCounts.set(key, count);
    } else {
      unreadCounts.delete(key);
    }
    updateDocumentTitle();
  }

  function incrementUnread(key) {
    unreadCounts.set(key, (unreadCounts.get(key) || 0) + 1);
    updateDocumentTitle();
  }

  function updateDocumentTitle() {
    let total = 0;
    for (const v of unreadCounts.values()) total += v;
    document.title = total > 0 ? `(${total}) LarsChat` : 'LarsChat';
  }

  // DOM refs
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const viewLogin = $('#view-login');
  const viewMain = $('#view-main');

  // Helpers
  const basePath = new URL(document.baseURI).pathname;

  async function api(method, path, body) {
    const opts = {
      method,
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'fetch' },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const url = path.startsWith('/') ? basePath + path.slice(1) : path;
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showView(el) {
    [viewLogin, viewMain].forEach(v => v.hidden = true);
    el.hidden = false;
  }

  function formatTime(isoStr) {
    const d = new Date(isoStr + 'Z');
    const date = d.toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const time = d.toLocaleTimeString(undefined, {
      hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
    });
    return date + ' at ' + time;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  const URL_RE = /https?:\/\/[^\s<>"']+/g;

  function linkify(text) {
    const parts = [];
    let lastIndex = 0;
    let match;
    URL_RE.lastIndex = 0;
    while ((match = URL_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(escapeHtml(text.slice(lastIndex, match.index)));
      }
      const url = match[0];
      let cleaned = url.replace(/[.,;:!?]+$/, '');
      // Strip trailing closing parens only when unbalanced (preserves Wikipedia-style URLs)
      while (cleaned.endsWith(')') &&
        (cleaned.match(/\(/g) || []).length < (cleaned.match(/\)/g) || []).length) {
        cleaned = cleaned.slice(0, -1);
      }
      const trailing = url.slice(cleaned.length);
      const safeUrl = escapeHtml(cleaned);
      parts.push(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a>${escapeHtml(trailing)}`);
      lastIndex = match.index + url.length;
    }
    if (lastIndex < text.length) {
      parts.push(escapeHtml(text.slice(lastIndex)));
    }
    return parts.join('');
  }

  function isAtBottom() {
    const el = $('#messages');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  }

  function scrollToBottom() {
    const el = $('#messages');
    el.scrollTop = el.scrollHeight;
  }

  // --- Auth ---
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#login-name').value.trim();
    const password = $('#login-password').value;
    const errEl = $('#login-error');
    errEl.hidden = true;

    try {
      const data = await api('POST', '/api/auth/login', { name, password });
      currentName = data.name;
      showView(viewMain);
      $('#settings-name').textContent = currentName;
      $('#sidebar-username').textContent = currentName;
      await loadChannels();
      loadDmConversations();
      connectWs();
    } catch (err) {
      errEl.textContent = err.data?.error || 'Something went wrong';
      errEl.hidden = false;
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    await api('POST', '/api/auth/logout');
    currentName = null;
    if (ws) ws.close();
    showView(viewLogin);
    closeAllModals();
  });

  // --- Init ---
  async function init() {
    try {
      const data = await api('GET', '/api/auth/check');
      currentName = data.name;
      showView(viewMain);
      $('#settings-name').textContent = currentName;
      $('#sidebar-username').textContent = currentName;
      await loadChannels();
      loadDmConversations();
      connectWs();
    } catch {
      showView(viewLogin);
    }
  }

  // --- Mobile Sidebar & Users Panel ---
  function closeSidebar() {
    $('.sidebar').classList.remove('open');
    $('#sidebar-overlay').classList.remove('open');
  }

  function closeUsersPanel() {
    $('.users-panel').classList.remove('open');
    $('#sidebar-overlay').classList.remove('open');
  }

  $('#btn-sidebar-toggle').addEventListener('click', () => {
    closeUsersPanel();
    const sidebar = $('.sidebar');
    const overlay = $('#sidebar-overlay');
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
  });

  $('#btn-users-toggle').addEventListener('click', () => {
    closeSidebar();
    const panel = $('.users-panel');
    const overlay = $('#sidebar-overlay');
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
  });

  $('#sidebar-overlay').addEventListener('click', () => {
    closeSidebar();
    closeUsersPanel();
  });

  // --- Channels ---
  async function loadChannels() {
    channels = await api('GET', '/api/channels');
    channels.forEach(ch => setUnread(`channel:${ch.id}`, ch.unread_count || 0));
    renderChannelList();
    // Auto-select #general if nothing selected
    if (!currentChannelId && channels.length > 0) {
      const general = channels.find(c => c.name === 'general') || channels[0];
      selectChannel(general.id);
    }
  }

  function renderChannelList() {
    const ul = $('#channel-list');
    ul.innerHTML = '';
    channels.forEach(ch => {
      const li = document.createElement('li');
      const count = getUnread(`channel:${ch.id}`);
      li.innerHTML = `<span class="channel-name"><span class="channel-prefix">#</span>${escapeHtml(ch.name)}</span>`;
      if (count > 0) {
        li.innerHTML += `<span class="unread-badge">${count > 99 ? '99+' : count}</span>`;
        li.classList.add('has-unread');
      }
      li.dataset.id = ch.id;
      if (currentView === 'channel' && currentChannelId === ch.id) li.classList.add('active');
      li.addEventListener('click', () => selectChannel(ch.id));
      ul.appendChild(li);
    });
  }

  function wsSubscribeChannel(channelId) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'subscribe_channel', channelId }));
    }
  }

  async function selectChannel(id) {
    closeSidebar();
    currentView = 'channel';
    currentChannelId = id;
    currentDmName = null;
    currentDmPeerReadId = 0;
    wsSubscribeChannel(id);
    setUnread(`channel:${id}`, 0);
    api('PUT', `/api/channels/${id}/read`).catch(() => {});
    const ch = channels.find(c => c.id === id);
    $('#chat-title').textContent = ch ? `# ${ch.name}` : '';
    const createdByEl = $('#chat-created-by');
    if (ch && ch.name !== 'general' && ch.created_by_name) {
      createdByEl.textContent = `created by ${ch.created_by_name}`;
      createdByEl.hidden = false;
    } else {
      createdByEl.hidden = true;
    }
    renderChannelList();
    renderDmList();

    // Show/hide delete button
    const delBtn = $('#btn-delete-channel');
    if (ch && ch.name !== 'general' && (ch.created_by_name === currentName || ch.created_by_name === 'system')) {
      delBtn.hidden = false;
    } else {
      delBtn.hidden = true;
    }

    await loadMessages();
  }

  async function loadMessagesFor(baseUrl, before) {
    const gen = before ? loadGeneration : ++loadGeneration;
    const list = $('#message-list');
    if (!before) list.innerHTML = '';
    const url = baseUrl + (before ? `?before=${before}` : '');
    const messages = await api('GET', url);

    // Discard stale response if the user switched channels/DMs during the fetch
    if (gen !== loadGeneration) return;

    const loadBtn = $('#btn-load-earlier');
    loadBtn.hidden = messages.length < 50;
    loadBtn.onclick = () => {
      const first = list.querySelector('.msg');
      if (first) loadMessagesFor(baseUrl, first.dataset.id);
    };

    if (before) {
      const fragment = document.createDocumentFragment();
      messages.forEach(m => fragment.appendChild(createMessageEl(m)));
      list.prepend(fragment);
    } else {
      messages.forEach(m => list.appendChild(createMessageEl(m)));
      scrollToBottom();
    }
  }

  function loadMessages(before) {
    return loadMessagesFor(`/api/channels/${currentChannelId}/messages`, before);
  }

  function createMessageEl(msg) {
    const div = document.createElement('div');
    div.className = 'msg' + (msg.name === currentName || msg.from_name === currentName ? ' own' : '');
    div.dataset.id = msg.id;
    div.dataset.name = msg.name || msg.from_name;
    const sender = msg.name || msg.from_name;
    div.innerHTML = `
      <div class="msg-header">
        <span class="msg-sender">${escapeHtml(sender)}</span>
        <span class="msg-time">${formatTime(msg.created_at)}</span>
      </div>
      <div class="msg-content">${linkify(msg.content)}</div>
    `;
    return div;
  }

  // Post message
  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  $('#message-input').addEventListener('input', function () {
    autoResize(this);
  });

  $('#message-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('#message-form').requestSubmit();
    }
  });

  $('#message-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#message-input');
    const content = input.value.trim();
    if (!content) return;

    input.value = '';
    autoResize(input);
    try {
      if (currentView === 'channel') {
        await api('POST', `/api/channels/${currentChannelId}/messages`, { content });
      } else if (currentView === 'dm') {
        await api('POST', '/api/dm', { to_name: currentDmName, content });
      }
    } catch (err) {
      input.value = content;
      autoResize(input);
    }
  });

  // Delete channel
  $('#btn-delete-channel').addEventListener('click', async () => {
    if (!confirm('Delete this channel and all its messages?')) return;
    try {
      await api('DELETE', `/api/channels/${currentChannelId}`);
    } catch (err) {
      alert(err.data?.error || 'Failed to delete channel');
    }
  });

  // New channel
  $('#btn-new-channel').addEventListener('click', () => {
    $('#modal-new-channel').hidden = false;
    $('#new-channel-name').value = '';
    $('#new-channel-error').hidden = true;
    $('#new-channel-name').focus();
  });

  $('#new-channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#new-channel-name').value.trim();
    const errEl = $('#new-channel-error');
    errEl.hidden = true;
    try {
      const ch = await api('POST', '/api/channels', { name });
      $('#modal-new-channel').hidden = true;
      selectChannel(ch.id);
    } catch (err) {
      errEl.textContent = err.data?.error || 'Failed to create channel';
      errEl.hidden = false;
    }
  });

  // --- Direct Messages ---
  let dmConversations = [];

  async function loadDmConversations() {
    try {
      dmConversations = await api('GET', '/api/dm/conversations');
      dmConversations.forEach(conv => setUnread(`dm:${conv.other_name}`, conv.unread_count || 0));
    } catch (err) {
      console.warn('Failed to load DM conversations:', err);
      dmConversations = [];
    }
    renderDmList();
  }

  function renderDmList() {
    const ul = $('#dm-list');
    ul.innerHTML = '';
    dmConversations.forEach(conv => {
      const li = document.createElement('li');
      const count = getUnread(`dm:${conv.other_name}`);
      li.innerHTML = `<span class="dm-name">${escapeHtml(conv.other_name)}</span>`;
      if (count > 0) {
        li.innerHTML += `<span class="unread-badge">${count > 99 ? '99+' : count}</span>`;
        li.classList.add('has-unread');
      }
      li.dataset.name = conv.other_name;
      if (currentView === 'dm' && currentDmName === conv.other_name) li.classList.add('active');
      li.addEventListener('click', () => selectDm(conv.other_name));
      ul.appendChild(li);
    });
  }

  async function selectDm(name) {
    closeSidebar();
    currentView = 'dm';
    currentDmName = name;
    currentChannelId = null;
    currentDmPeerReadId = 0;
    wsSubscribeChannel(null);
    setUnread(`dm:${name}`, 0);
    api('PUT', `/api/dm/${encodeURIComponent(name)}/read`).catch(() => {});
    $('#chat-title').textContent = name;
    $('#chat-created-by').hidden = true;
    $('#btn-delete-channel').hidden = true;
    renderChannelList();
    renderDmList();
    await loadDmMessages();
  }

  async function loadDmMessages(before) {
    const baseUrl = `/api/dm/${encodeURIComponent(currentDmName)}`;
    const gen = before ? loadGeneration : ++loadGeneration;
    const list = $('#message-list');
    if (!before) list.innerHTML = '';
    const url = baseUrl + (before ? `?before=${before}` : '');
    const data = await api('GET', url);

    if (gen !== loadGeneration) return;

    const messages = data.messages;
    if (!before) {
      currentDmPeerReadId = data.peer_read_id || 0;
    }

    const loadBtn = $('#btn-load-earlier');
    loadBtn.hidden = messages.length < 50;
    loadBtn.onclick = () => {
      const first = list.querySelector('.msg');
      if (first) loadDmMessages(first.dataset.id);
    };

    if (before) {
      const fragment = document.createDocumentFragment();
      messages.forEach(m => fragment.appendChild(createMessageEl(m)));
      list.prepend(fragment);
    } else {
      messages.forEach(m => list.appendChild(createMessageEl(m)));
      scrollToBottom();
    }
    applyDmReadReceipt();
  }

  function applyDmReadReceipt() {
    const existing = document.querySelector('.read-receipt');
    if (existing) existing.remove();
    if (currentView !== 'dm' || !currentDmPeerReadId) return;
    const ownMsgs = $$('#message-list .msg.own');
    let target = null;
    for (const el of ownMsgs) {
      if (Number(el.dataset.id) <= currentDmPeerReadId) target = el;
    }
    if (target) {
      const badge = document.createElement('span');
      badge.className = 'read-receipt';
      badge.textContent = 'Read';
      target.querySelector('.msg-header').appendChild(badge);
    }
  }

  // New DM
  let contactSearchTimer = null;
  let contactSearchGen = 0;

  async function loadContacts(query) {
    const gen = ++contactSearchGen;
    const listEl = $('#dm-contacts-list');
    const emptyEl = $('#dm-contacts-empty');
    try {
      const url = query ? `/api/dm/contacts?q=${encodeURIComponent(query)}` : '/api/dm/contacts';
      const contacts = await api('GET', url);
      if (gen !== contactSearchGen) return;
      listEl.innerHTML = '';
      emptyEl.hidden = true;
      if (contacts.length === 0) {
        emptyEl.textContent = query ? 'No users found.' : 'No other users registered yet.';
        emptyEl.hidden = false;
      } else {
        contacts.forEach(name => {
          const btn = document.createElement('button');
          btn.textContent = name;
          btn.addEventListener('click', () => {
            $('#modal-new-dm').hidden = true;
            if (!dmConversations.find(c => c.other_name === name)) {
              dmConversations.unshift({ other_name: name, last_message: '', last_message_at: '' });
            }
            selectDm(name);
          });
          listEl.appendChild(btn);
        });
      }
    } catch {
      listEl.innerHTML = '';
      emptyEl.textContent = 'Failed to load contacts';
      emptyEl.hidden = false;
    }
  }

  $('#btn-new-dm').addEventListener('click', () => {
    $('#modal-new-dm').hidden = false;
    const input = $('#dm-search-input');
    input.value = '';
    $('#dm-contacts-list').innerHTML = '';
    $('#dm-contacts-empty').hidden = true;
    input.focus();
    loadContacts('');
  });

  $('#dm-search-input').addEventListener('input', (e) => {
    clearTimeout(contactSearchTimer);
    contactSearchTimer = setTimeout(() => loadContacts(e.target.value.trim()), 200);
  });

  // --- Settings ---
  $('#btn-settings').addEventListener('click', () => {
    $('#modal-settings').hidden = false;
    $('#delete-confirm').hidden = true;
    $('#change-password-form').reset();
    $('#password-error').hidden = true;
    $('#password-success').hidden = true;
  });

  $('#change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#password-error');
    const successEl = $('#password-success');
    errEl.hidden = true;
    successEl.hidden = true;

    const currentPassword = $('#current-password').value;
    const newPassword = $('#new-password').value;
    const confirmPassword = $('#confirm-password').value;

    if (newPassword !== confirmPassword) {
      errEl.textContent = 'Passwords do not match';
      errEl.hidden = false;
      return;
    }

    try {
      await api('PUT', '/api/user/password', { currentPassword, newPassword });
      successEl.textContent = 'Password changed successfully';
      successEl.hidden = false;
      $('#change-password-form').reset();
    } catch (err) {
      errEl.textContent = err.data?.error || 'Failed to change password';
      errEl.hidden = false;
    }
  });

  $('#btn-delete-data').addEventListener('click', () => {
    $('#delete-confirm').hidden = false;
    $('#delete-password').value = '';
    $('#delete-error').hidden = true;
    $('#delete-password').focus();
  });

  $('#btn-delete-cancel').addEventListener('click', () => {
    $('#delete-confirm').hidden = true;
  });

  $('#btn-delete-confirm').addEventListener('click', async () => {
    const password = $('#delete-password').value;
    const errEl = $('#delete-error');
    errEl.hidden = true;
    if (!password) {
      errEl.textContent = 'Password is required';
      errEl.hidden = false;
      return;
    }
    try {
      await api('DELETE', '/api/user/data', { password });
      currentName = null;
      if (ws) ws.close();
      closeAllModals();
      showView(viewLogin);
    } catch (err) {
      errEl.textContent = err.data?.error || 'Failed to delete data';
      errEl.hidden = false;
    }
  });

  // --- Modals ---
  function closeAllModals() {
    $$('.modal').forEach(m => m.hidden = true);
  }

  $$('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.modal').hidden = true;
    });
  });

  $$('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.hidden = true;
    });
  });

  // --- WebSocket ---
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}${basePath}`);

    ws.addEventListener('open', () => {
      wsRetryDelay = 1000;
      if (currentView === 'channel' && currentChannelId) {
        wsSubscribeChannel(currentChannelId);
      }
    });

    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleWsMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.addEventListener('error', () => {
      // Error details are intentionally not exposed by the browser.
      // The subsequent 'close' event will trigger reconnection.
    });

    ws.addEventListener('close', () => {
      if (!currentName) return;
      const jitter = wsRetryDelay * (0.5 + Math.random());
      setTimeout(() => {
        wsRetryDelay = Math.min(wsRetryDelay * 2, 30000);
        connectWs();
      }, jitter);
    });
  }

  function handleWsMessage(msg) {
    switch (msg.type) {
      case 'channel_message':
        if (currentView === 'channel' && currentChannelId === msg.message.channel_id) {
          const atBottom = isAtBottom();
          $('#message-list').appendChild(createMessageEl(msg.message));
          if (atBottom) scrollToBottom();
          // Mark as read since we're viewing this channel
          api('PUT', `/api/channels/${msg.message.channel_id}/read`).catch(() => {});
        } else if (msg.message.name !== currentName) {
          // Race condition: subscription change crossed with in-flight message
          incrementUnread(`channel:${msg.message.channel_id}`);
          renderChannelList();
        }
        break;

      case 'channel_unread':
        if (msg.name !== currentName) {
          incrementUnread(`channel:${msg.channelId}`);
          renderChannelList();
        }
        break;

      case 'dm': {
        const other = msg.message.from_name === currentName
          ? msg.message.to_name
          : msg.message.from_name;

        // Update conversations list
        const existing = dmConversations.find(c => c.other_name === other);
        if (existing) {
          existing.last_message = msg.message.content;
          existing.last_message_at = msg.message.created_at;
          // Move to top
          dmConversations = [existing, ...dmConversations.filter(c => c !== existing)];
        } else {
          dmConversations.unshift({
            other_name: other,
            last_message: msg.message.content,
            last_message_at: msg.message.created_at,
          });
        }
        if (currentView === 'dm' && currentDmName === other) {
          const atBottom = isAtBottom();
          $('#message-list').appendChild(createMessageEl(msg.message));
          if (atBottom) scrollToBottom();
          // Mark as read since we're viewing this DM
          api('PUT', `/api/dm/${encodeURIComponent(other)}/read`).catch(() => {});
          applyDmReadReceipt();
        } else if (msg.message.from_name !== currentName) {
          incrementUnread(`dm:${other}`);
        }
        renderDmList();
        break;
      }

      case 'dm_read': {
        if (currentView === 'dm' && currentDmName === msg.reader) {
          currentDmPeerReadId = msg.last_read_id;
          applyDmReadReceipt();
        }
        break;
      }

      case 'channel_created':
        channels.push(msg.channel);
        renderChannelList();
        break;

      case 'channel_deleted': {
        channels = channels.filter(c => c.id !== msg.channelId);
        setUnread(`channel:${msg.channelId}`, 0);
        renderChannelList();
        if (currentView === 'channel' && currentChannelId === msg.channelId) {
          const general = channels.find(c => c.name === 'general') || channels[0];
          if (general) selectChannel(general.id);
        }
        break;
      }

      case 'presence': {
        const ul = $('#online-users');
        ul.innerHTML = '';
        msg.users.forEach(name => {
          const li = document.createElement('li');
          li.textContent = name;
          if (name !== currentName) {
            li.classList.add('clickable');
            li.addEventListener('click', () => {
              closeUsersPanel();
              if (!dmConversations.find(c => c.other_name === name)) {
                dmConversations.unshift({ other_name: name, last_message: '', last_message_at: '' });
              }
              selectDm(name);
            });
          }
          ul.appendChild(li);
        });
        break;
      }

      case 'user_data_deleted': {
        // Remove messages from the deleted user
        $$(`.msg[data-name="${CSS.escape(msg.name)}"]`).forEach(el => el.remove());
        // Refresh DM conversations
        loadDmConversations();
        break;
      }
    }
  }

  // --- Emoji Picker ---
  // Representative emoji for each tab
  const TAB_ICONS = {
    'Smileys & Emotion': '\u{1F600}',
    'People & Body': '\u{1F44B}',
    'Animals & Nature': '\u{1F43E}',
    'Food & Drink': '\u{1F354}',
    'Travel & Places': '\u2708\uFE0F',
    'Activities': '\u26BD',
    'Objects': '\u{1F4A1}',
    'Symbols': '\u{1F523}',
    'Flags': '\u{1F3C1}',
  };

  (function initEmojiPicker() {
    if (typeof EMOJI_DATA === 'undefined') return;
    const picker = $('#emoji-picker');
    const tabBar = document.createElement('div');
    tabBar.className = 'emoji-tabs';
    picker.appendChild(tabBar);

    const groups = Object.entries(EMOJI_DATA);
    const panels = {};

    groups.forEach(([group, emojis], i) => {
      // Tab button
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'emoji-tab' + (i === 0 ? ' active' : '');
      tab.textContent = TAB_ICONS[group] || emojis[0];
      tab.title = group;
      tab.addEventListener('click', () => switchEmojiTab(group));
      tabBar.appendChild(tab);

      // Panel
      const panel = document.createElement('div');
      panel.className = 'emoji-panel';
      if (i !== 0) panel.hidden = true;
      panel.dataset.group = group;

      const label = document.createElement('span');
      label.className = 'emoji-category-label';
      label.textContent = group;
      panel.appendChild(label);

      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      emojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = emoji;
        btn.addEventListener('click', () => insertEmoji(emoji));
        grid.appendChild(btn);
      });
      panel.appendChild(grid);
      picker.appendChild(panel);
      panels[group] = panel;
    });

    function switchEmojiTab(group) {
      tabBar.querySelectorAll('.emoji-tab').forEach((t, i) => {
        const g = groups[i][0];
        t.classList.toggle('active', g === group);
      });
      Object.entries(panels).forEach(([g, p]) => {
        p.hidden = g !== group;
      });
    }
  })();

  function insertEmoji(emoji) {
    const input = $('#message-input');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const val = input.value;
    input.value = val.slice(0, start) + emoji + val.slice(end);
    const pos = start + emoji.length;
    input.setSelectionRange(pos, pos);
    input.focus();
  }

  $('#btn-emoji').addEventListener('click', (e) => {
    e.stopPropagation();
    const picker = $('#emoji-picker');
    const btn = $('#btn-emoji');
    const open = !picker.hidden;
    picker.hidden = open;
    btn.classList.toggle('active', !open);
  });

  document.addEventListener('click', (e) => {
    const picker = $('#emoji-picker');
    if (picker.hidden) return;
    if (!e.target.closest('#emoji-picker') && !e.target.closest('#btn-emoji')) {
      picker.hidden = true;
      $('#btn-emoji').classList.remove('active');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const picker = $('#emoji-picker');
      if (!picker.hidden) {
        picker.hidden = true;
        $('#btn-emoji').classList.remove('active');
        return;
      }
      // Close the topmost open modal
      const openModal = [...$$('.modal')].reverse().find(m => !m.hidden);
      if (openModal) openModal.hidden = true;
    }
  });

  // Close picker on form submit
  $('#message-form').addEventListener('submit', () => {
    $('#emoji-picker').hidden = true;
    $('#btn-emoji').classList.remove('active');
  });

  // --- Start ---
  init();
})();
