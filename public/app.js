const $ = (sel) => document.querySelector(sel);

// Small DOM helper. Uses textContent only, so track metadata can never inject HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) el.append(c instanceof Node ? c : document.createTextNode(c ?? ''));
  return el;
}

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------- API (session cookie is sent automatically) ----------
async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = {};
  if (body && !raw) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: raw ? body : body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fail = (e) => alert(e.message);

// ---------- State ----------
const state = { view: 'library', tracks: [], queue: [], index: -1, playlists: [], licenses: [], user: null };
const audio = $('#audio');

// ---------- Account ----------
// ---------- Install as an app ----------
let installEvent = null; // Chrome/Edge/Android fire this when the app is installable
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS =
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  renderAccount();
});
window.addEventListener('appinstalled', () => {
  installEvent = null;
  renderAccount();
});

async function installApp() {
  if (installEvent) {
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    renderAccount();
  } else {
    alert('To install OpenWave: tap the Share button, then "Add to Home Screen".');
  }
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

function renderAccount() {
  const box = $('#account');
  const items = [];
  if (state.user) {
    items.push(
      h('div', { class: 'who', title: state.user.email }, state.user.email),
      h('button', { class: 'link-btn', onclick: signOut }, 'Sign out'),
    );
  } else {
    items.push(h('button', { class: 'link-btn', onclick: () => openAuth('login') }, 'Sign in / Create account'));
  }
  if (!isStandalone && (installEvent || isIOS)) {
    items.push(h('button', { class: 'link-btn', onclick: installApp }, 'Install app'));
  }
  box.replaceChildren(...items);
  $('#new-playlist').hidden = !state.user;
  $('#upload-form').hidden = !state.user;
  $('#upload-gate').hidden = !!state.user;
}

async function refreshSession() {
  state.user = (await api('/api/me')).user;
  renderAccount();
  await loadPlaylists();
}

async function signOut() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch (e) { return fail(e); }
  state.user = null;
  renderAccount();
  await loadPlaylists();
  if (state.view !== 'library' && state.view !== 'upload') showView('library');
  else renderTracks();
}

let authMode = 'login';
function openAuth(mode) {
  setAuthMode(mode);
  $('#auth-error').textContent = '';
  $('#auth-form').reset();
  $('#auth-dialog').showModal();
}
function setAuthMode(mode) {
  authMode = mode;
  const reg = mode === 'register';
  $('#auth-title').textContent = reg ? 'Create account' : 'Sign in';
  $('#auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('#auth-toggle').textContent = reg ? 'I already have an account' : 'Create an account';
  $('#auth-form').elements.password.autocomplete = reg ? 'new-password' : 'current-password';
}
$('#auth-toggle').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
$('#auth-cancel').addEventListener('click', () => $('#auth-dialog').close());
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-auth]')) openAuth('login');
});
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const btn = $('#auth-submit');
  btn.disabled = true;
  $('#auth-error').textContent = '';
  try {
    await api(authMode === 'register' ? '/api/register' : '/api/login', {
      method: 'POST',
      body: { email: fd.get('email'), password: fd.get('password') },
    });
    $('#auth-dialog').close();
    await refreshSession();
    renderTracks(); // show per-user controls
  } catch (err) {
    $('#auth-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Library / playlists ----------
async function loadTracks() {
  if (state.view === 'library') {
    const q = $('#search').value.trim();
    const data = await api(`/api/tracks${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    state.tracks = data.tracks;
    if (!state.licenses.length) {
      state.licenses = data.licenses;
      $('#license').replaceChildren(...data.licenses.map((l) => h('option', { value: l }, l)));
    }
  } else {
    state.tracks = (await api(`/api/playlists/${state.view}`)).tracks;
  }
  renderTracks();
}

async function loadPlaylists() {
  state.playlists = (await api('/api/playlists')).playlists;
  $('#playlists').replaceChildren(
    ...state.playlists.map((p) =>
      h('button', {
        class: `nav-item${state.view === p.id ? ' active' : ''}`,
        'data-view': p.id,
        onclick: () => showView(p.id),
      }, `${p.name} (${p.track_count})`),
    ),
  );
}

function renderTracks() {
  const box = $('#tracks');
  if (!state.tracks.length) {
    box.replaceChildren(h('p', { class: 'empty' },
      state.view === 'library' ? 'No tracks yet. Sign in and upload one, or run "npm run demo".' : 'This playlist is empty.'));
    return;
  }
  const current = state.queue[state.index]?.id;
  box.replaceChildren(...state.tracks.map((t, i) => {
    const actions = [];

    if (state.user && state.view === 'library') {
      actions.push(h('select', {
        class: 't-add', 'aria-label': 'Add to playlist',
        onchange: async (e) => {
          const pid = e.target.value;
          e.target.value = '';
          if (!pid) return;
          try {
            await api(`/api/playlists/${pid}/tracks`, { method: 'POST', body: { track_id: t.id } });
            await loadPlaylists();
          } catch (err) { fail(err); }
        },
      },
      h('option', { value: '' }, '+ Playlist'),
      ...state.playlists.map((p) => h('option', { value: p.id }, p.name))));
    }

    if (state.view !== 'library') {
      actions.push(h('button', {
        class: 'icon-btn', title: 'Remove from playlist', 'aria-label': 'Remove from playlist',
        onclick: async () => {
          try {
            await api(`/api/playlists/${state.view}/tracks/${t.id}`, { method: 'DELETE' });
            await Promise.all([loadTracks(), loadPlaylists()]);
          } catch (err) { fail(err); }
        },
      }, '✕'));
    } else if (t.mine) {
      actions.push(h('button', {
        class: 'icon-btn', title: 'Delete my upload', 'aria-label': `Delete ${t.title}`,
        onclick: async () => {
          if (!confirm(`Delete "${t.title}" permanently?`)) return;
          try {
            await api(`/api/tracks/${t.id}`, { method: 'DELETE' });
            await Promise.all([loadTracks(), loadPlaylists()]);
          } catch (err) { fail(err); }
        },
      }, '🗑'));
    }

    return h('div', { class: `track${t.id === current ? ' playing' : ''}` },
      h('button', { class: 'icon-btn', 'aria-label': `Play ${t.title}`, onclick: () => playFrom(i) }, '▶'),
      h('div', { class: 'min0' },
        h('div', { class: 't-title' }, t.title),
        h('div', { class: 't-sub' }, [t.artist, t.album].filter(Boolean).join(' · ')),
      ),
      h('span', { class: 'badge' }, t.license),
      h('div', { class: 'row-actions' }, actions),
      h('span', { class: 't-dur' }, fmt(t.duration)),
    );
  }));
}

function showView(view) {
  state.view = view;
  const isList = view !== 'upload';
  $('#view-library').hidden = !isList;
  $('#view-upload').hidden = isList;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (isList) {
    const pl = state.playlists.find((p) => p.id === view);
    $('#view-title').textContent = pl ? pl.name : 'Library';
    $('#search').hidden = view !== 'library';
    loadTracks().catch(fail);
  }
}

// ---------- Playback ----------
function playFrom(i) {
  state.queue = [...state.tracks];
  state.index = i;
  loadCurrent(true);
}

function loadCurrent(autoplay) {
  const t = state.queue[state.index];
  if (!t) return;
  audio.src = t.stream_url;
  $('#now-title').textContent = t.title;
  $('#now-artist').textContent = t.artist;
  document.title = `${t.title} · ${t.artist}`;
  if (autoplay) audio.play().catch(() => {});
  renderTracks();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album || '' });
  }
}

const step = (d) => {
  if (!state.queue.length) return;
  state.index = (state.index + d + state.queue.length) % state.queue.length;
  loadCurrent(true);
};

$('#play').addEventListener('click', () => {
  if (!audio.src && state.tracks.length) return playFrom(0);
  audio.paused ? audio.play() : audio.pause();
});
$('#prev').addEventListener('click', () => (audio.currentTime > 3 ? (audio.currentTime = 0) : step(-1)));
$('#next').addEventListener('click', () => step(1));
$('#volume').addEventListener('input', (e) => (audio.volume = Number(e.target.value)));

audio.addEventListener('play', () => ($('#play').textContent = '⏸'));
audio.addEventListener('pause', () => ($('#play').textContent = '▶'));
audio.addEventListener('ended', () => step(1));
audio.addEventListener('loadedmetadata', () => ($('#dur').textContent = fmt(audio.duration)));
audio.addEventListener('timeupdate', () => {
  $('#cur').textContent = fmt(audio.currentTime);
  if (audio.duration) $('#seek').value = Math.round((audio.currentTime / audio.duration) * 1000);
});
$('#seek').addEventListener('input', (e) => {
  if (audio.duration) audio.currentTime = (Number(e.target.value) / 1000) * audio.duration;
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => step(-1));
  navigator.mediaSession.setActionHandler('nexttrack', () => step(1));
}

// ---------- UI wiring ----------
document.querySelectorAll('.nav-item[data-view]').forEach((b) =>
  b.addEventListener('click', () => showView(b.dataset.view)));

let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadTracks().catch(fail), 250);
});

$('#new-playlist').addEventListener('click', async () => {
  const name = prompt('Playlist name');
  if (!name?.trim()) return;
  try {
    await api('/api/playlists', { method: 'POST', body: { name } });
    await loadPlaylists();
    renderTracks();
  } catch (e) { fail(e); }
});

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const fd = new FormData(form);
  const file = fd.get('file');
  const status = $('#upload-status');
  const btn = form.querySelector('button[type=submit]');
  const params = new URLSearchParams();
  for (const k of ['title', 'artist', 'album', 'license', 'source_url']) {
    if (fd.get(k)) params.set(k, fd.get(k));
  }
  btn.disabled = true;
  status.className = 'hint';
  status.textContent = 'Uploading and transcoding…';
  try {
    const t = await api(`/api/tracks?${params}`, { method: 'POST', body: file, raw: true });
    status.textContent = `Added "${t.title}".`;
    form.reset();
  } catch (err) {
    status.className = 'hint error';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Boot ----------
let retryTimer;
async function boot() {
  clearTimeout(retryTimer);
  try {
    await refreshSession();
    showView('library');
  } catch {
    // Offline or server down: the app shell still opens, with a clear message, and keeps retrying.
    $('#tracks').replaceChildren(
      h('p', { class: 'empty' }, "You're offline, or the server can't be reached. OpenWave will reconnect automatically."),
    );
    retryTimer = setTimeout(boot, 4000);
  }
}
window.addEventListener('online', boot);
await boot();
