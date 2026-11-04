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
    // Login button in header area (append to body as floating)
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;top:8px;right:8px;z-index:9999;display:flex;gap:6px;align-items:center;font-family:sans-serif;font-size:12px;';
    bar.innerHTML = '<span id="nebula-user" style="color:#fff;opacity:.7"></span>' +
      '<button id="nebula-auth-btn" style="padding:4px 8px;border-radius:6px;border:1px solid #444;background:#1a1a2e;color:#fff;cursor:pointer">Sign in</button>' +
      '<button id="nebula-room-btn" style="padding:4px 8px;border-radius:6px;border:1px solid #444;background:#1a1a2e;color:#fff;cursor:pointer;display:none">Rooms</button>';
    document.body.appendChild(bar);

    const modal = document.createElement('div');
    modal.id = 'nebula-auth-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:none;align-items:center;justify-content:center;';
    modal.innerHTML = '<div style="background:#1a1a2e;color:#fff;padding:20px;border-radius:10px;width:320px;max-width:90vw;">' +
      '<h3 style="margin:0 0 12px">Nebula Account</h3>' +
      '<input id="na-email" placeholder="email" style="width:100%;margin:4px 0;padding:6px;box-sizing:border-box">' +
      '<input id="na-pass" type="password" placeholder="password (>=6)" style="width:100%;margin:4px 0;padding:6px;box-sizing:border-box">' +
      '<div style="display:flex;gap:6px;margin-top:10px">' +
      '<button id="na-login" style="flex:1;padding:6px;border-radius:6px;border:none;background:#6c5ce7;color:#fff;cursor:pointer">Log in</button>' +
      '<button id="na-reg" style="flex:1;padding:6px;border-radius:6px;border:none;background:#00b894;color:#fff;cursor:pointer">Register</button>' +
      '</div>' +
      '<button id="na-close" style="margin-top:8px;width:100%;padding:6px;border-radius:6px;border:1px solid #444;background:transparent;color:#fff;cursor:pointer">Close</button>' +
      '<div id="na-msg" style="margin-top:8px;font-size:12px;color:#ff7675"></div>' +
      '</div>';
    document.body.appendChild(modal);

    const roomPanel = document.createElement('div');
    roomPanel.id = 'nebula-room-panel';
    roomPanel.style.cssText = 'position:fixed;top:40px;right:8px;z-index:9999;background:#1a1a2e;color:#fff;padding:12px;border-radius:10px;width:300px;display:none;font-size:12px;';
    roomPanel.innerHTML = '<h4 style="margin:0 0 8px">Shared Rooms</h4>' +
      '<div id="nr-list"></div>' +
      '<button id="nr-create" style="margin-top:8px;padding:4px 8px;border-radius:6px;border:none;background:#00b894;color:#fff;cursor:pointer">+ New room</button>' +
      '<div style="margin-top:8px"><input id="nr-invite" placeholder="invite token" style="width:100%;padding:4px;box-sizing:border-box"><button id="nr-accept" style="margin-top:4px;padding:4px 8px;border-radius:6px;border:none;background:#6c5ce7;color:#fff;cursor:pointer">Accept invite</button></div>' +
      '<div id="nr-msg" style="margin-top:8px;font-size:11px;color:#ff7675"></div>';
    document.body.appendChild(roomPanel);

    // wire
    $('nebula-auth-btn').onclick = () => { modal.style.display = 'flex'; };
    $('na-close').onclick = () => { modal.style.display = 'none'; };
    $('na-login').onclick = async () => {
      try {
        const d = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: $('na-email').value, password: $('na-pass').value }) });
        setAuth(d.token, d.user); modal.style.display = 'none'; refreshAuthUI();
      } catch (e) { $('na-msg').textContent = e.message; }
    };
    $('na-reg').onclick = async () => {
      try {
        const d = await api('/auth/register', { method: 'POST', body: JSON.stringify({ email: $('na-email').value, password: $('na-pass').value }) });
        setAuth(d.token, d.user); modal.style.display = 'none'; refreshAuthUI();
      } catch (e) { $('na-msg').textContent = e.message; }
    };
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
      if (btn) { btn.textContent = 'Sign out'; btn.onclick = () => { clearAuth(); location.reload(); }; }
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
      if (btn) { btn.textContent = 'Sign in'; btn.onclick = () => { $('nebula-auth-modal').style.display = 'flex'; }; }
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
