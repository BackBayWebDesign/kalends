const $ = (id) => document.getElementById(id);
const form = $('config');
const PALETTE = ['#8b5cf6', '#f59e0b', '#38bdf8', '#34d399', '#fb7185', '#fb923c', '#a3e635', '#f472b6'];
let dirty = false;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

/* ---------- sign-in / first-run ---------- */

function showGate(mode) {
  $('config').hidden = true;
  $('logout').hidden = true;
  $('gate').hidden = false;
  const setup = mode === 'setup';
  $('gate-title').textContent = setup ? 'Create a password' : 'Sign in';
  $('gate-text').textContent = setup
    ? 'Kalends has no password yet. Choose one (8+ characters) to protect the settings. The display page stays open to everyone on your network.'
    : 'Enter the Kalends settings password.';
  $('gate-confirm-row').hidden = !setup;
  $('gate-pass').autocomplete = setup ? 'new-password' : 'current-password';
  $('gate-submit').textContent = setup ? 'Create password' : 'Sign in';
  $('gate-form').dataset.mode = mode;
  $('gate-pass').focus();
}

$('gate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.currentTarget.dataset.mode;
  const password = $('gate-pass').value;
  $('gate-error').textContent = '';
  if (mode === 'setup' && password !== $('gate-confirm').value) {
    $('gate-error').textContent = 'The passwords do not match.';
    return;
  }
  try {
    await api('POST', mode === 'setup' ? 'api/auth/setup' : 'api/auth/login', { password });
    $('gate-pass').value = '';
    $('gate-confirm').value = '';
    await load();
  } catch (err) {
    $('gate-error').textContent = err.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', 'api/auth/logout').catch(() => {});
  showGate('login');
});

/* ---------- calendars ---------- */

function describeStatus(st) {
  if (!st || st.state === 'pending') return ['', 'Not loaded yet (loads when the display asks for events).'];
  if (st.state === 'error') return ['err', `Error: ${st.error}`];
  const when = st.fetchedAt ? new Date(st.fetchedAt).toLocaleTimeString() : '';
  const warn = st.error ? ` Last refresh failed: ${st.error}.` : '';
  return ['ok', `${st.events} events loaded at ${when}.${warn}`];
}

function setStatus(row, cls, text) {
  const s = row.querySelector('.cal-status');
  s.className = `cal-status muted ${cls}`;
  s.textContent = text;
}

function addCalRow(cal = {}) {
  const list = $('cal-list');
  const row = $('cal-row').content.firstElementChild.cloneNode(true);
  row.dataset.id = cal.id || '';
  row.dataset.type = cal.type || 'ical';
  row.querySelector('.cal-color').value = /^#[0-9a-f]{6}$/i.test(cal.color || '') ? cal.color : PALETTE[list.children.length % PALETTE.length];
  row.querySelector('.cal-name').value = cal.name || '';
  row.querySelector('.cal-url').value = cal.url || '';
  row.querySelector('.cal-enabled').checked = cal.enabled !== false;
  if (row.dataset.type !== 'ical') {
    row.dataset.account = cal.account_id;
    row.dataset.remote = cal.remote_id;
    const acct = accounts.find((a) => a.id === cal.account_id);
    row.querySelector('.cal-url').hidden = true;
    row.querySelector('.cal-show').hidden = true;
    row.querySelector('.cal-test').hidden = true;
    const src = row.querySelector('.cal-source');
    src.hidden = false;
    src.textContent = `${PROVIDER_LABEL[row.dataset.type]} · ${acct ? acct.email || acct.name : 'disconnected account'}`;
  }
  const [cls, text] = cal.id ? describeStatus(cal.status) : ['', row.dataset.type === 'ical' ? 'New: press Test to check the link, then Save.' : 'New: press Save to add it.'];
  setStatus(row, cls, text);
  row.querySelector('.cal-show').addEventListener('click', (e) => {
    const input = row.querySelector('.cal-url');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Hide' : 'Show';
  });
  row.querySelector('.cal-test').addEventListener('click', async () => {
    const url = row.querySelector('.cal-url').value.trim();
    setStatus(row, '', 'Testing…');
    try {
      const r = await api('POST', 'api/admin/test-calendar', { url });
      if (r.ok) {
        setStatus(row, 'ok', `OK: ${r.events} events, ${r.recurring} recurring${r.name ? ` ("${r.name}")` : ''}.`);
        const name = row.querySelector('.cal-name');
        if (!name.value && r.name) {
          name.value = r.name;
          markDirty();
        }
      } else setStatus(row, 'err', `Failed: ${r.error}`);
    } catch (err) {
      setStatus(row, 'err', err.message);
    }
  });
  row.querySelector('.cal-up').addEventListener('click', () => {
    if (row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
    markDirty();
  });
  row.querySelector('.cal-down').addEventListener('click', () => {
    if (row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
    markDirty();
  });
  row.querySelector('.cal-del').addEventListener('click', () => {
    const name = row.querySelector('.cal-name').value || 'this calendar';
    if (confirm(`Remove ${name}?`)) {
      row.remove();
      markDirty();
    }
  });
  list.append(row);
  return row;
}

$('add-cal').addEventListener('click', () => {
  const row = addCalRow();
  row.querySelector('.cal-url').type = 'text';
  row.querySelector('.cal-show').textContent = 'Hide';
  row.querySelector('.cal-name').focus();
  markDirty();
});

function readCalendars() {
  return [...$('cal-list').children].map((row) => ({
    id: row.dataset.id || undefined,
    type: row.dataset.type,
    name: row.querySelector('.cal-name').value,
    url: row.dataset.type === 'ical' ? row.querySelector('.cal-url').value : undefined,
    account_id: row.dataset.account,
    remote_id: row.dataset.remote,
    color: row.querySelector('.cal-color').value,
    enabled: row.querySelector('.cal-enabled').checked
  }));
}

/* ---------- accounts (Google / Microsoft sign-in) ---------- */

const PROVIDER_LABEL = { google: 'Google', microsoft: 'Microsoft' };
let accounts = [];
let oauthState = {};

function fillOAuth(o) {
  oauthState = o;
  for (const el of form.querySelectorAll('[data-oauth]')) {
    const key = el.dataset.oauth;
    if (key.endsWith('clientSecret')) {
      el.value = '';
      el.placeholder = getPath(o, key.replace('clientSecret', 'hasSecret')) ? 'Saved (type to replace)' : '';
    } else el.value = getPath(o, key) ?? '';
  }
  $('ru-google').textContent = o.google.redirectUri || 'Set the public URL and save';
  $('ru-microsoft').textContent = o.microsoft.redirectUri || 'Set the public URL and save';
  for (const p of ['google', 'microsoft']) {
    const a = $(`connect-${p}`);
    const ready = o[p].ready && o.publicUrl;
    a.classList.toggle('disabled', !ready);
    a.title = ready ? `Sign in with ${PROVIDER_LABEL[p]}` : 'Fill in Sign-in setup and save first';
  }
  if (!o.publicUrl || (!o.google.ready && !o.microsoft.ready)) $('oauth-setup').open = true;
}

function readOAuth() {
  const o = {};
  for (const el of form.querySelectorAll('[data-oauth]')) {
    const v = el.value.trim();
    if (el.dataset.oauth.endsWith('clientSecret') && !v) continue;
    setPath(o, el.dataset.oauth, v);
  }
  return o;
}

for (const p of ['google', 'microsoft']) {
  $(`connect-${p}`).addEventListener('click', (e) => {
    if (dirty) {
      e.preventDefault();
      alert('Save your changes first.');
    } else if (!(oauthState[p]?.ready && oauthState.publicUrl)) {
      e.preventDefault();
      $('oauth-setup').open = true;
      notice('err', `Fill in the ${PROVIDER_LABEL[p]} part of Sign-in setup and press Save first.`);
    }
  });
}

function notice(cls, text) {
  const n = $('oauth-notice');
  n.hidden = !text;
  n.className = `notice ${cls}`;
  n.textContent = text;
}

function renderAccounts() {
  const list = $('acct-list');
  list.replaceChildren();
  for (const a of accounts) {
    const box = document.createElement('div');
    box.className = 'acct';
    const head = document.createElement('div');
    head.className = 'acct-head';
    const badge = document.createElement('span');
    badge.className = `badge ${a.provider}`;
    badge.textContent = PROVIDER_LABEL[a.provider];
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = a.email || a.name || '(account)';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'secondary';
    add.textContent = 'Add calendars';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon danger';
    del.textContent = 'Remove';
    const picker = document.createElement('div');
    picker.className = 'picker';
    add.addEventListener('click', () => showPicker(a, picker));
    del.addEventListener('click', async () => {
      if (dirty) return alert('Save your changes first.');
      if (!confirm(`Disconnect ${who.textContent}? Its calendars are removed from Kalends too.`)) return;
      try {
        render(await api('DELETE', `api/admin/account?id=${encodeURIComponent(a.id)}`));
        notice('ok', `Disconnected ${who.textContent}.`);
      } catch (err) {
        notice('err', err.message);
      }
    });
    head.append(badge, who, add, del);
    box.append(head, picker);
    list.append(box);
  }
}

async function showPicker(a, picker) {
  picker.replaceChildren('Loading calendars…');
  let cals;
  try {
    ({ calendars: cals } = await api('GET', `api/admin/account-calendars?id=${encodeURIComponent(a.id)}`));
  } catch (err) {
    picker.replaceChildren(`Could not list calendars: ${err.message}`);
    return;
  }
  const have = new Set([...$('cal-list').children].filter((r) => r.dataset.account === a.id).map((r) => r.dataset.remote));
  const fresh = cals.filter((c) => !have.has(c.id));
  picker.replaceChildren();
  if (!fresh.length) {
    picker.append(cals.length ? 'All of this account’s calendars are already added.' : 'This account has no calendars.');
    return;
  }
  const boxes = fresh.map((c) => {
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = c.primary;
    label.append(cb, ` ${c.name}${c.primary ? ' (main)' : ''}`);
    picker.append(label);
    return { cb, c };
  });
  const row = document.createElement('span');
  row.className = 'row';
  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'secondary';
  go.textContent = 'Add selected';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'link';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => picker.replaceChildren());
  go.addEventListener('click', () => {
    const picked = boxes.filter((b) => b.cb.checked);
    for (const { c } of picked) addCalRow({ type: a.provider, account_id: a.id, remote_id: c.id, name: c.name, color: c.color });
    picker.replaceChildren();
    if (picked.length) {
      markDirty();
      notice('ok', `Added ${picked.length} calendar${picked.length > 1 ? 's' : ''} below. Press Save to keep them.`);
    }
  });
  row.append(go, cancel);
  picker.append(row);
}

function showOAuthResult() {
  const q = new URLSearchParams(location.search);
  const r = q.get('oauth');
  if (!r) return;
  const msg = q.get('message') || (r === 'ok' ? 'Connected' : 'Sign-in failed');
  notice(r === 'ok' ? 'ok' : 'err', r === 'ok' ? `${msg}. Now press Add calendars next to the account.` : msg);
  history.replaceState(null, '', location.pathname + location.hash);
  $('accounts').scrollIntoView();
}

/* ---------- settings fields ---------- */

function fillTimezones(current) {
  const sel = $('tz');
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {}
  if (!zones.includes(current)) zones.unshift(current);
  if (!zones.includes('UTC')) zones.push('UTC');
  sel.replaceChildren(...zones.map((z) => new Option(z.replaceAll('_', ' '), z)));
  sel.value = current;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  keys.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
  o[keys.at(-1)] = value;
}

function fillSettings(s) {
  fillTimezones(s.timezone);
  for (const elx of form.querySelectorAll('[name]')) {
    const v = getPath(s, elx.name);
    if (elx.type === 'checkbox') elx.checked = Boolean(v);
    else if (elx.name === 'photos.urls') elx.value = (v || []).join('\n');
    else elx.value = v ?? '';
  }
}

function readSettings() {
  const s = {};
  for (const elx of form.querySelectorAll('[name]')) {
    let v;
    if (elx.type === 'checkbox') v = elx.checked;
    else if (elx.name === 'photos.urls') v = elx.value.split('\n').map((x) => x.trim()).filter(Boolean);
    else if (elx.type === 'number' || elx.name === 'weekStart') v = elx.value === '' ? undefined : Number(elx.value);
    else v = elx.value;
    if (v !== undefined) setPath(s, elx.name, v);
  }
  return s;
}

/* ---------- weather search ---------- */

async function geoSearch() {
  const q = $('geo-q').value.trim();
  const box = $('geo-results');
  box.textContent = 'Searching…';
  try {
    const { results } = await api('GET', `api/admin/geocode?q=${encodeURIComponent(q)}`);
    box.replaceChildren();
    if (!results.length) box.textContent = 'No matches.';
    for (const r of results) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.name;
      b.addEventListener('click', () => {
        form.elements['weather.name'].value = r.name;
        form.elements['weather.latitude'].value = r.latitude.toFixed(4);
        form.elements['weather.longitude'].value = r.longitude.toFixed(4);
        box.replaceChildren();
        markDirty();
      });
      box.append(b);
    }
  } catch (err) {
    box.textContent = err.message;
  }
}
$('geo-go').addEventListener('click', geoSearch);
$('geo-q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    geoSearch();
  }
});

/* ---------- password ---------- */

$('pw-save').addEventListener('click', async () => {
  const msg = $('pw-msg');
  try {
    await api('POST', 'api/auth/password', { current: $('pw-current').value, password: $('pw-new').value });
    $('pw-current').value = '';
    $('pw-new').value = '';
    msg.textContent = 'Password changed.';
  } catch (err) {
    msg.textContent = err.message;
  }
});

/* ---------- save / load ---------- */

function markDirty() {
  dirty = true;
  $('save-msg').className = 'muted';
  $('save-msg').textContent = 'Unsaved changes';
}
form.addEventListener('input', (e) => {
  if (!e.target.closest('#geo-q, #pw-current, #pw-new')) markDirty();
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) e.preventDefault();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('save-msg');
  msg.className = 'muted';
  msg.textContent = 'Saving…';
  try {
    const data = await api('PUT', 'api/admin/config', { settings: readSettings(), calendars: readCalendars(), oauth: readOAuth() });
    render(data);
    dirty = false;
    msg.className = 'ok';
    msg.textContent = 'Saved. Open displays update within a minute.';
  } catch (err) {
    if (err.status === 401) return showGate(err.data?.error === 'setup' ? 'setup' : 'login');
    msg.className = 'err';
    msg.textContent = err.message;
  }
});

function render(data) {
  accounts = data.accounts || [];
  fillSettings(data.settings);
  fillOAuth(data.oauth);
  renderAccounts();
  $('cal-list').replaceChildren();
  data.calendars.forEach((c) => addCalRow(c));
}

async function load() {
  try {
    const data = await api('GET', 'api/admin/config');
    $('gate').hidden = true;
    $('config').hidden = false;
    $('logout').hidden = false;
    render(data);
    dirty = false;
    showOAuthResult();
  } catch (err) {
    if (err.status === 401) showGate(err.data?.error === 'setup' ? 'setup' : 'login');
    else document.body.append(`Could not load settings: ${err.message}`);
  }
}

load();
