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
    };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
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
    return escapeHtml(text).replace(URL_RE, url => {
      const cleaned = url.replace(/[.,;:!?\)]+$/, '');
      const trailing = url.slice(cleaned.length);
      return `<a href="${cleaned}" target="_blank" rel="noopener noreferrer">${cleaned}</a>${trailing}`;
    });
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

  // --- Mobile Sidebar ---
  function closeSidebar() {
    $('.sidebar').classList.remove('open');
    $('#sidebar-overlay').classList.remove('open');
  }

  $('#btn-sidebar-toggle').addEventListener('click', () => {
    const sidebar = $('.sidebar');
    const overlay = $('#sidebar-overlay');
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    overlay.classList.toggle('open', open);
  });

  $('#sidebar-overlay').addEventListener('click', closeSidebar);

  // --- Channels ---
  async function loadChannels() {
    channels = await api('GET', '/api/channels');
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
      li.innerHTML = `<span class="channel-prefix">#</span>${escapeHtml(ch.name)}`;
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
    wsSubscribeChannel(id);
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
    if (ch && ch.name !== 'general' && ch.created_by_name === currentName) {
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
      li.textContent = conv.other_name;
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
    wsSubscribeChannel(null);
    $('#chat-title').textContent = name;
    $('#chat-created-by').hidden = true;
    $('#btn-delete-channel').hidden = true;
    renderChannelList();
    renderDmList();
    await loadDmMessages();
  }

  function loadDmMessages(before) {
    return loadMessagesFor(`/api/dm/${encodeURIComponent(currentDmName)}`, before);
  }

  // New DM
  $('#btn-new-dm').addEventListener('click', async () => {
    $('#modal-new-dm').hidden = false;
    const listEl = $('#dm-contacts-list');
    const emptyEl = $('#dm-contacts-empty');
    listEl.innerHTML = '';
    emptyEl.hidden = true;

    try {
      const contacts = await api('GET', '/api/dm/contacts');
      if (contacts.length === 0) {
        emptyEl.hidden = false;
      } else {
        contacts.forEach(name => {
          const btn = document.createElement('button');
          btn.textContent = name;
          btn.addEventListener('click', () => {
            $('#modal-new-dm').hidden = true;
            // Add to conversations if not there
            if (!dmConversations.find(c => c.other_name === name)) {
              dmConversations.unshift({ other_name: name, last_message: '', last_message_at: '' });
            }
            selectDm(name);
          });
          listEl.appendChild(btn);
        });
      }
    } catch {
      emptyEl.textContent = 'Failed to load contacts';
      emptyEl.hidden = false;
    }
  });

  // --- Settings ---
  $('#btn-settings').addEventListener('click', () => {
    $('#modal-settings').hidden = false;
    $('#delete-confirm').hidden = true;
  });

  $('#btn-delete-data').addEventListener('click', () => {
    $('#delete-confirm').hidden = false;
  });

  $('#btn-delete-cancel').addEventListener('click', () => {
    $('#delete-confirm').hidden = true;
  });

  $('#btn-delete-confirm').addEventListener('click', async () => {
    try {
      await api('DELETE', '/api/user/data');
      currentName = null;
      if (ws) ws.close();
      closeAllModals();
      showView(viewLogin);
    } catch (err) {
      alert(err.data?.error || 'Failed to delete data');
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
        renderDmList();

        if (currentView === 'dm' && currentDmName === other) {
          const atBottom = isAtBottom();
          $('#message-list').appendChild(createMessageEl(msg.message));
          if (atBottom) scrollToBottom();
        }
        break;
      }

      case 'channel_created':
        channels.push(msg.channel);
        renderChannelList();
        break;

      case 'channel_deleted': {
        channels = channels.filter(c => c.id !== msg.channelId);
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
