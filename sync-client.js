// Nebula sync client — auth + rooms + Yjs binding (Phase 3/4)
(function () {
  const WORKER = 'https://nebula-sync.billiethomasonsound.workers.dev';

  const $ = (id) => document.getElementById(id);
  const tokenKey = 'nebula-auth-token';
  const userKey = 'nebula-auth-user';
  const roomKey = 'nebula-active-room';

  function getToken() { return localStorage.getItem(tokenKey); }
  function setAuth(token, user) { localStorage.setItem(tokenKey, token); localStorage.setItem(userKey, JSON.stringify(user)); }
  function clearAuth() { localStorage.removeItem(tokenKey); localStorage.removeItem(userKey); localStorage.removeItem(roomKey); }
  function getUser() { try { return JSON.parse(localStorage.getItem(userKey) || 'null'); } catch (e) { return null; } }

  // ---------- sign-in panel state (anchored to the top bar) ----------
  function syncAuthAria() {
    const b = $('nebula-auth-btn'), p = $('nebula-auth-panel');
    if (b && p) b.setAttribute('aria-expanded', p.classList.contains('open') ? 'true' : 'false');
  }
  function openAuthPanel() { const p = $('nebula-auth-panel'); if (p) p.classList.add('open'); syncAuthAria(); }
  function closeAuthPanel() { const p = $('nebula-auth-panel'); if (p) p.classList.remove('open'); syncAuthAria(); }
  function toggleAuthPanel() { const p = $('nebula-auth-panel'); if (p) p.classList.toggle('open'); syncAuthAria(); }

  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const t = getToken();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const res = await fetch(WORKER + path, Object.assign({}, opts, { headers }));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // ---------- Yjs state ----------
  let ydoc = null;
  let provider = null;
  let yNotes = null;
  let yBoard = null;
  let pushing = false;

  function bindRoom(roomId) {
    if (provider) { try { provider.destroy(); } catch (e) {} provider = null; }
    if (ydoc) { try { ydoc.destroy(); } catch (e) {} }
    ydoc = new Y.Doc();
    yNotes = ydoc.getMap('notes');
    yBoard = ydoc.getMap('board');

    api('/rooms/' + roomId + '/ws-ticket', { method: 'POST' }).then((r) => {
      const url = WORKER.replace(/^https/, 'wss').replace(/^http/, 'ws');
      provider = new WebsocketProvider(url, '/sync/' + roomId + '?ticket=' + r.ticket, ydoc, { connect: true });
      // Wait, y-websocket expects (serverUrl, roomname, doc). Adjust:
    }).catch((e) => { console.error('ticket err', e); });

    // The above is wrong shape; redo properly below by not using provider yet.
  }

  // Redo bindRoom correctly:
  async function bindRoom2(roomId) {
    if (provider) { try { provider.destroy(); } catch (e) {} provider = null; }
    if (ydoc) { try { ydoc.destroy(); } catch (e) {} }
    ydoc = new Y.Doc();
    yNotes = ydoc.getMap('notes');
    yBoard = ydoc.getMap('board');

    let r;
    try { r = await api('/rooms/' + roomId + '/ws-ticket', { method: 'POST' }); }
    catch (e) { console.error(e); return; }

    const wsBase = WORKER.replace(/^https/, 'wss').replace(/^http/, 'ws');
    // y-websocket provider takes (serverUrl, roomName, doc). Room name includes path? Library builds url as serverUrl + '/' + roomName.
    // Our endpoint is /sync/:roomId?ticket=... so pass roomName = 'sync/' + roomId + '?ticket=' + ticket
    provider = new WebsocketProvider(wsBase, 'sync/' + roomId + '?ticket=' + encodeURIComponent(r.ticket), ydoc);

    provider.on('status', (ev) => { console.log('sync status', ev.status); });

    // Pull initial state into app
    ydoc.on('update', () => {
      if (pushing) return;
      try {
        if (yNotes.size) {
          const shared = [];
          yNotes.forEach((v) => { try { shared.push(JSON.parse(v)); } catch (e) {} });
          // merge: replace shared notes, keep private ones
          const privateNotes = (notes || []).filter((n) => !n.shared);
          // update shared notes that changed
          const byId = {};
          (notes || []).forEach((n) => { byId[n.id] = n; });
          shared.forEach((s) => {
            normalizeNote(s);
            byId[s.id] = s;
          });
          notes = privateNotes.concat(shared.filter((s) => !privateNotes.find((p) => p.id === s.id)));
          // rebuild unique
          const seen = new Set();
          notes = notes.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
        }
        const b = yBoard.get('state');
        if (b) {
          try { board = JSON.parse(b); } catch (e) {}
        }
        if (typeof renderNotes === 'function') renderNotes();
        if (typeof renderBoard === 'function') renderBoard();
        if (typeof migrateBoard === 'function' && board) board = migrateBoard(board);
      } catch (e) { console.error('pull err', e); }
    });
  }

  window.nebulaSyncPush = function () {
    if (!ydoc || !provider) return;
    pushing = true;
    try {
      const ymap = ydoc.getMap('notes');
      ydoc.transact(() => {
        Array.from(ymap.keys()).forEach((k) => ymap.delete(k));
        (notes || []).filter((n) => n.shared).forEach((n) => { ymap.set(String(n.id), JSON.stringify(n)); });
        ydoc.getMap('board').set('state', JSON.stringify(board));
      });
    } catch (e) { console.error('push err', e); }
    pushing = false;
  };

  // ---------- UI injection ----------
  function injectUI() {
    // Inject Sign in / Rooms buttons into the existing header top bar
    const right = document.querySelector('.header-right');
    if (!right) { console.warn('header-right not found'); return; }
    const userSpan = document.createElement('span');
    userSpan.id = 'nebula-user';
    userSpan.style.cssText = 'color:#fff;opacity:.7;font-size:12px;margin-right:4px;';
    right.insertBefore(userSpan, right.firstChild);

    const authBtn = document.createElement('button');
    authBtn.id = 'nebula-auth-btn';
    authBtn.className = 'header-btn';
    authBtn.title = 'Sign in';
    authBtn.textContent = '🔑';
    authBtn.setAttribute('aria-haspopup', 'true');
    authBtn.setAttribute('aria-controls', 'nebula-auth-panel');
    authBtn.setAttribute('aria-expanded', 'false');
    right.insertBefore(authBtn, right.firstChild);

    const roomBtn = document.createElement('button');
    roomBtn.id = 'nebula-room-btn';
    roomBtn.className = 'header-btn';
    roomBtn.title = 'Rooms';
    roomBtn.textContent = '👥';
    roomBtn.style.display = 'none';
    right.insertBefore(roomBtn, right.firstChild);

    // Sign-in panel — anchored to the top bar (not a full-screen modal)
    const style = document.createElement('style');
    style.id = 'nebula-auth-panel-style';
    style.textContent = [
      '#nebula-auth-panel{position:absolute;top:calc(100% + 10px);right:0;width:300px;max-width:calc(100vw - 32px);',
      'background:var(--glass-bg);color:var(--text-primary);border:1px solid var(--glass-border);border-radius:14px;',
      'padding:14px;z-index:10000;box-shadow:var(--glow-purple);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);',
      'font-size:13px;display:none;}',
      '#nebula-auth-panel.open{display:block;}',
      '#nebula-auth-panel h3{margin:0 0 10px;font-size:14px;font-weight:600;}',
      '#nebula-auth-panel input{width:100%;margin:4px 0;padding:8px;box-sizing:border-box;background:rgba(0,0,0,.28);',
      'border:1px solid var(--glass-border);border-radius:8px;color:var(--text-primary);font-size:14px;font-family:inherit;}',
      '#nebula-auth-panel input:focus{outline:none;border-color:var(--nebula-purple);box-shadow:0 0 0 2px rgba(155,89,255,.25);}',
      '#nebula-auth-panel .na-row{display:flex;gap:6px;margin-top:10px;}',
      '#nebula-auth-panel .na-btn{flex:1;padding:7px;border-radius:8px;border:none;color:#fff;cursor:pointer;font-size:13px;font-family:inherit;}',
      '#nebula-auth-panel .na-login{background:#6c5ce7;}',
      '#nebula-auth-panel .na-login:hover{background:#7d6df0;}',
      '#nebula-auth-panel .na-reg{background:#00b894;}',
      '#nebula-auth-panel .na-reg:hover{background:#00d2a0;}',
      '#nebula-auth-panel .na-close{margin-top:8px;width:100%;padding:7px;border-radius:8px;border:1px solid var(--glass-border);',
      'background:transparent;color:var(--text-primary);cursor:pointer;font-size:13px;font-family:inherit;}',
      '#nebula-auth-panel .na-msg{margin-top:8px;font-size:12px;color:#ff7675;}',
    ].join('');
    document.head.appendChild(style);

    const authPanel = document.createElement('div');
    authPanel.id = 'nebula-auth-panel';
    authPanel.setAttribute('role', 'dialog');
    authPanel.setAttribute('aria-label', 'Nebula account');
    authPanel.innerHTML = '<h3>Nebula Account</h3>' +
      '<input id="na-email" type="email" placeholder="email" aria-label="email" autocomplete="email">' +
      '<input id="na-pass" type="password" placeholder="password (min 6)" aria-label="password" autocomplete="current-password">' +
      '<div class="na-row">' +
      '<button id="na-login" class="na-btn na-login">Log in</button>' +
      '<button id="na-reg" class="na-btn na-reg">Register</button>' +
      '</div>' +
      '<button id="na-close" class="na-close">Close</button>' +
      '<div id="na-msg" class="na-msg" role="alert"></div>';
    document.querySelector('.header').appendChild(authPanel);

    const roomPanel = document.createElement('div');
    roomPanel.id = 'nebula-room-panel';
    roomPanel.style.cssText = 'position:fixed;top:104px;right:8px;z-index:9999;background:#1a1a2e;color:#fff;padding:12px;border-radius:10px;width:300px;display:none;font-size:12px;';
    roomPanel.innerHTML = '<h4 style="margin:0 0 8px">Shared Rooms</h4>' +
      '<div id="nr-list"></div>' +
      '<button id="nr-create" style="margin-top:8px;padding:4px 8px;border-radius:6px;border:none;background:#00b894;color:#fff;cursor:pointer">+ New room</button>' +
      '<div style="margin-top:8px"><input id="nr-invite" placeholder="invite token" style="width:100%;padding:4px;box-sizing:border-box"><button id="nr-accept" style="margin-top:4px;padding:4px 8px;border-radius:6px;border:none;background:#6c5ce7;color:#fff;cursor:pointer">Accept invite</button></div>' +
      '<div id="nr-msg" style="margin-top:8px;font-size:11px;color:#ff7675"></div>';
    document.body.appendChild(roomPanel);

    // wire
    $('nebula-auth-btn').onclick = () => { toggleAuthPanel(); };
    $('na-close').onclick = () => { closeAuthPanel(); };
    $('na-login').onclick = async () => {
      try {
        const d = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: $('na-email').value, password: $('na-pass').value }) });
        setAuth(d.token, d.user); closeAuthPanel(); refreshAuthUI();
      } catch (e) { $('na-msg').textContent = e.message; }
    };
    $('na-reg').onclick = async () => {
      try {
        const d = await api('/auth/register', { method: 'POST', body: JSON.stringify({ email: $('na-email').value, password: $('na-pass').value }) });
        setAuth(d.token, d.user); closeAuthPanel(); refreshAuthUI();
      } catch (e) { $('na-msg').textContent = e.message; }
    };
    // dismissal paths: outside click + Escape (APG disclosure pattern)
    document.addEventListener('click', (e) => {
      const p = $('nebula-auth-panel');
      if (!p || !p.classList.contains('open')) return;
      if (p.contains(e.target)) return;
      if (e.target.closest && e.target.closest('#nebula-auth-btn')) return;
      closeAuthPanel();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAuthPanel();
    });
    $('nebula-room-btn').onclick = () => { roomPanel.style.display = roomPanel.style.display === 'none' ? 'block' : 'none'; loadRooms(); };
    $('nr-create').onclick = async () => {
      const name = prompt('Room name?', 'Shared Board') || 'Shared Board';
      try {
        const d = await api('/rooms', { method: 'POST', body: JSON.stringify({ name }) });
        await loadRooms();
        await activateRoom(d.room.id);
      } catch (e) { $('nr-msg').textContent = e.message; }
    };
    $('nr-accept').onclick = async () => {
      const tok = $('nr-invite').value.trim();
      // accept via invite token: need full token; our accept endpoint takes token in URL
      try {
        const d = await api('/invites/' + tok + '/accept', { method: 'POST' });
        $('nr-msg').textContent = 'Joined room';
        await loadRooms();
        await activateRoom(d.roomId);
      } catch (e) { $('nr-msg').textContent = e.message; }
    };

    refreshAuthUI();
  }

  async function loadRooms() {
    const list = $('nr-list');
    if (!list) return;
    try {
      const d = await api('/rooms');
      list.innerHTML = (d.rooms || []).map((r) =>
        '<div style="padding:4px;border-bottom:1px solid #333;cursor:pointer" data-rid="' + r.id + '">' +
        r.name + ' <span style="opacity:.5">(' + r.role + ')</span>' +
        ' <button data-inv="' + r.id + '" style="margin-left:6px;font-size:10px;padding:2px 4px;border-radius:4px;border:none;background:#fdcb6e;color:#000;cursor:pointer">invite</button>' +
        ' <button data-open="' + r.id + '" style="margin-left:2px;font-size:10px;padding:2px 4px;border-radius:4px;border:none;background:#74b9ff;color:#000;cursor:pointer">open</button>' +
        '</div>'
      ).join('');
      list.querySelectorAll('[data-open]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); activateRoom(b.getAttribute('data-open')); };
      });
      list.querySelectorAll('[data-inv]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          try {
            const d = await api('/rooms/' + b.getAttribute('data-inv') + '/invite', { method: 'POST', body: '{}' });
            prompt('Invite link (share with partner):', d.inviteUrl);
          } catch (err) { $('nr-msg').textContent = err.message; }
        };
      });
    } catch (e) { list.textContent = 'err: ' + e.message; }
  }

  async function activateRoom(roomId) {
    localStorage.setItem(roomKey, roomId);
    await bindRoom2(roomId);
    $('nr-msg').textContent = 'Active room: ' + roomId.slice(0, 8);
  }

  function refreshAuthUI() {
    const u = getUser();
    const btn = $('nebula-auth-btn');
    const user = $('nebula-user');
    const rbtn = $('nebula-room-btn');
    if (u && getToken()) {
      if (user) user.textContent = u.email;
      if (btn) { btn.textContent = 'Sign out'; btn.setAttribute('aria-expanded', 'false'); btn.onclick = () => { clearAuth(); location.reload(); }; }
      if (rbtn) rbtn.style.display = 'inline-block';
      // auto-accept invite from URL
      const params = new URLSearchParams(location.search);
      const inv = params.get('invite');
      if (inv) {
        api('/invites/' + inv + '/accept', { method: 'POST' }).then((d) => {
          activateRoom(d.roomId);
          // clean url
          const u2 = new URL(location.href); u2.searchParams.delete('invite'); history.replaceState({}, '', u2.toString());
        }).catch((e) => { console.error(e); });
      }
      // restore active room
      const rid = localStorage.getItem(roomKey);
      if (rid) bindRoom2(rid);
    } else {
      if (user) user.textContent = '';
      if (btn) { btn.textContent = 'Sign in'; btn.onclick = () => { openAuthPanel(); }; }
      if (rbtn) rbtn.style.display = 'none';
    }
  }

  // ---------- boot ----------
  function boot() {
    if (typeof Y === 'undefined' || typeof WebsocketProvider === 'undefined') {
      console.warn('Yjs bundle not loaded');
    }
    injectUI();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
