import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { Auth } from './lib/auth.js';
import { CalendarCache, expand, fetchIcs, parseIcs, keyToUtc, overlaps } from './lib/ical.js';
import { getWeather, geocode } from './lib/weather.js';
import { PROVIDERS, OAuthFlows, RemoteCache, redirectUri, exchangeCode, accessToken, listCalendars, fetchEvents, revoke } from './lib/providers.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
try {
  if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'));
} catch {}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = resolve(ROOT, process.env.DATA_DIR || './data');
const PUBLIC_DIR = join(ROOT, 'public');
const PHOTO_DIR = join(DATA_DIR, 'photos');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

const store = new Store(DATA_DIR);
const auth = new Auth(store);
const cache = new CalendarCache();
const remote = new RemoteCache();
const flows = new OAuthFlows();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.json': 'application/json'
};
const PHOTO_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers
  });
  res.end(payload);
}

async function readJson(req, limit = 1024 * 1024) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw Object.assign(new Error('Expected application/json'), { status: 415 });
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

async function serveFile(res, file, extraHeaders = {}) {
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    });
    res.end(data);
  } catch {
    send(res, 404, 'Not found');
  }
}

function publicSettings() {
  const s = store.settings();
  return {
    version: store.version(),
    appVersion: VERSION,
    settings: s,
    calendars: store.calendars().filter((c) => c.enabled).map(({ id, name, color }) => ({ id, name, color }))
  };
}

function adminConfig() {
  const o = store.oauth();
  const base = o.publicUrl || '';
  const prov = (p) => ({
    clientId: o[p]?.clientId || '',
    hasSecret: Boolean(o[p]?.clientSecret),
    ready: Boolean(providerConfig(p)),
    redirectUri: base ? redirectUri(base, p) : '',
    ...(p === 'microsoft' ? { tenant: o[p]?.tenant || 'common' } : {})
  });
  return {
    appVersion: VERSION,
    settings: store.settings(),
    calendars: store.calendars().map((c) => ({ ...c, status: calStatus(c) })),
    accounts: store.accounts().map(({ id, provider, email, name }) => ({ id, provider, email, name })),
    oauth: { publicUrl: base, google: prov('google'), microsoft: prov('microsoft') }
  };
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return /^[a-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-f:]+\](:\d{1,5})?$/i.test(host) ? `${proto}://${host}` : '';
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}

async function oauthRoute(req, res, url, provider, action) {
  const publicUrl = store.oauth().publicUrl || '';
  if (action === 'start') {
    if (!auth.isAuthed(req)) return redirect(res, '/settings');
    const cfg = providerConfig(provider);
    const back = (msg) => redirect(res, `/settings?oauth=error&message=${encodeURIComponent(msg)}#accounts`);
    if (!publicUrl) return back('Set the public URL in Accounts first');
    if (!cfg) return back(`Enter the ${PROVIDERS[provider].label} client ID and secret first`);
    return redirect(res, flows.begin(provider, cfg, publicUrl, requestOrigin(req) || publicUrl));
  }
  const flow = flows.take(url.searchParams.get('state') || '', provider);
  const home = flow?.returnTo || publicUrl || '';
  const done = (ok, msg) => redirect(res, `${home}/settings?oauth=${ok ? 'ok' : 'error'}&message=${encodeURIComponent(msg)}#accounts`);
  if (!flow) return done(false, 'Sign-in expired or was started elsewhere. Try again.');
  const err = url.searchParams.get('error');
  if (err) return done(false, url.searchParams.get('error_description') || err);
  const cfg = providerConfig(provider);
  if (!cfg) return done(false, 'Sign-in is not configured');
  try {
    const info = await exchangeCode(provider, cfg, url.searchParams.get('code') || '', flow);
    store.upsertAccount(provider, info);
    done(true, `Connected ${info.email || PROVIDERS[provider].label}`);
  } catch (e) {
    done(false, e?.name === 'TimeoutError' ? 'Timed out talking to the provider' : e.message);
  }
}

async function listPhotos() {
  const s = store.settings();
  if (!s.photos.enabled) return [];
  let local = [];
  try {
    local = (await readdir(PHOTO_DIR))
      .filter((f) => PHOTO_EXT.has(extname(f).toLowerCase()) && !f.startsWith('.'))
      .sort()
      .map((f) => `photos/${encodeURIComponent(f)}`);
  } catch {}
  return [...local, ...s.photos.urls];
}

function providerConfig(provider) {
  const cfg = store.oauth()[provider] || {};
  return cfg.clientId && cfg.clientSecret ? cfg : null;
}

async function tokenFor(accountId) {
  const account = store.account(accountId);
  if (!account) throw new Error('Account is no longer connected');
  const cfg = providerConfig(account.provider);
  if (!cfg) throw new Error(`${PROVIDERS[account.provider].label} sign-in is not configured`);
  return { account, token: await accessToken(account, cfg, (a) => store.saveTokens(a)) };
}

function calStatus(c) {
  return c.type === 'ical' ? cache.status(c.id) : remote.status(c.id);
}

async function events(from, to) {
  const s = store.settings();
  const ttl = s.refreshMinutes * 60000;
  const all = store.calendars();
  const cals = all.filter((c) => c.enabled);
  cache.sync(all.filter((c) => c.type === 'ical'));
  remote.sync(all.filter((c) => c.type !== 'ical'));
  const fromMs = keyToUtc(from, s.timezone);
  const toMs = keyToUtc(to, s.timezone);
  const results = await Promise.all(
    cals.map((c) => {
      if (c.type === 'ical') return cache.get(c, ttl).then((entry) => ({ c, entry }));
      const loader = async (a, b) => {
        const { account, token } = await tokenFor(c.account_id);
        return fetchEvents(account.provider, token, c.remote_id, a, b, c.id);
      };
      return remote.get(c, fromMs, toMs, ttl, loader).then((entry) => ({ c, entry }));
    })
  );
  const out = [];
  const errors = [];
  for (const { c, entry } of results) {
    if (entry.error) errors.push({ cal: c.id, name: c.name, error: entry.error });
    if (c.type !== 'ical') {
      if (entry.events) out.push(...entry.events.filter((e) => overlaps(e, from, to, fromMs, toMs)));
      continue;
    }
    if (!entry.parsed) continue;
    try {
      out.push(...expand(entry.parsed, c.id, from, to, s.timezone));
    } catch (err) {
      errors.push({ cal: c.id, name: c.name, error: `Could not expand events: ${err.message}` });
    }
  }
  out.sort((a, b) => {
    const as = a.allDay ? `${a.start}T00` : '';
    const bs = b.allDay ? `${b.start}T00` : '';
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.allDay) return as < bs ? -1 : as > bs ? 1 : a.title.localeCompare(b.title);
    return a.start - b.start || a.title.localeCompare(b.title);
  });
  return { events: out, errors };
}

function requireAuth(req, res) {
  if (auth.isAuthed(req)) return true;
  send(res, 401, { error: auth.hasPassword() ? 'login' : 'setup' });
  return false;
}

const routes = {
  'GET /api/display': async (req, res) => send(res, 200, publicSettings()),

  'GET /api/events': async (req, res, url) => {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '') || from >= to) return send(res, 400, { error: 'from and to must be YYYY-MM-DD, from < to' });
    const span = (Date.parse(to) - Date.parse(from)) / 86400000;
    if (span > 120) return send(res, 400, { error: 'Range is limited to 120 days' });
    send(res, 200, await events(from, to));
  },

  'GET /api/weather': async (req, res) => {
    const s = store.settings();
    if (!s.weather.enabled) return send(res, 200, { disabled: true });
    try {
      send(res, 200, await getWeather(s.weather, s.timezone));
    } catch (err) {
      send(res, 502, { error: err.message });
    }
  },

  'GET /api/photos': async (req, res) => send(res, 200, { photos: await listPhotos(), intervalSeconds: store.settings().photos.intervalSeconds }),

  'GET /api/health': async (req, res) => send(res, 200, { ok: true, version: VERSION }),

  'GET /api/auth': async (req, res) => send(res, 200, { authed: auth.isAuthed(req), hasPassword: auth.hasPassword() }),

  'POST /api/auth/setup': async (req, res) => {
    if (auth.hasPassword()) return send(res, 409, { error: 'A password is already set' });
    const body = await readJson(req);
    try {
      auth.setPassword(body.password);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(auth.createSession(), req) });
  },

  'POST /api/auth/login': async (req, res) => {
    const ip = req.socket.remoteAddress || '';
    if (auth.throttled(ip)) return send(res, 429, { error: 'Too many attempts, wait a minute' });
    const body = await readJson(req);
    if (!auth.check(body.password)) {
      auth.fail(ip);
      return send(res, 401, { error: 'Wrong password' });
    }
    send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(auth.createSession(), req) });
  },

  'POST /api/auth/logout': async (req, res) => {
    auth.destroy(auth.tokenFrom(req));
    send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(null, req) });
  },

  'POST /api/auth/password': async (req, res) => {
    if (!requireAuth(req, res)) return;
    const body = await readJson(req);
    if (!auth.check(body.current)) return send(res, 401, { error: 'Current password is wrong' });
    try {
      auth.setPassword(body.password);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    send(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie(auth.createSession(), req) });
  },

  'GET /api/admin/config': async (req, res) => {
    if (!requireAuth(req, res)) return;
    send(res, 200, adminConfig());
  },

  'PUT /api/admin/config': async (req, res) => {
    if (!requireAuth(req, res)) return;
    const body = await readJson(req);
    try {
      if (body.oauth) store.saveOAuth(body.oauth);
      const calendars = body.calendars ? store.saveCalendars(body.calendars) : store.calendars();
      if (body.settings) store.saveSettings(body.settings);
      cache.sync(calendars.filter((c) => c.type === 'ical'));
      remote.sync(calendars.filter((c) => c.type !== 'ical'));
      send(res, 200, adminConfig());
    } catch (err) {
      send(res, 400, { error: err.message });
    }
  },

  'DELETE /api/admin/account': async (req, res, url) => {
    if (!requireAuth(req, res)) return;
    const account = store.account(url.searchParams.get('id') || '');
    if (!account) return send(res, 404, { error: 'No such account' });
    const cfg = providerConfig(account.provider);
    if (cfg) await revoke(account).catch(() => {});
    store.removeAccount(account.id);
    remote.sync(store.calendars().filter((c) => c.type !== 'ical'));
    send(res, 200, adminConfig());
  },

  'GET /api/admin/account-calendars': async (req, res, url) => {
    if (!requireAuth(req, res)) return;
    try {
      const { account, token } = await tokenFor(url.searchParams.get('id') || '');
      send(res, 200, { calendars: await listCalendars(account.provider, token) });
    } catch (err) {
      send(res, 502, { error: err?.name === 'TimeoutError' ? 'Timed out' : err.message });
    }
  },

  'POST /api/admin/test-calendar': async (req, res) => {
    if (!requireAuth(req, res)) return;
    const body = await readJson(req);
    const url = String(body.url || '').trim();
    if (!/^(https?|webcals?):\/\/\S+$/i.test(url)) return send(res, 400, { error: 'Enter an http(s) or webcal URL' });
    try {
      const parsed = parseIcs(await fetchIcs(url));
      send(res, 200, { ok: true, name: parsed.name, events: parsed.singles.length, recurring: parsed.masters.length });
    } catch (err) {
      send(res, 200, { ok: false, error: err?.name === 'TimeoutError' ? 'Timed out' : err.message });
    }
  },

  'GET /api/admin/geocode': async (req, res, url) => {
    if (!requireAuth(req, res)) return;
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return send(res, 400, { error: 'Type at least 2 characters' });
    try {
      send(res, 200, { results: await geocode(q) });
    } catch (err) {
      send(res, 502, { error: err.message });
    }
  }
};

const DISPLAY_HEADERS = { 'Content-Security-Policy': "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; connect-src 'self'" };
const SETTINGS_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
  'X-Frame-Options': 'SAMEORIGIN'
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  try {
    const handler = routes[`${req.method} ${path}`];
    if (handler) return await handler(req, res, url);
    const om = req.method === 'GET' && path.match(/^\/api\/oauth\/(google|microsoft)\/(start|callback)$/);
    if (om) return await oauthRoute(req, res, url, om[1], om[2]);
    if (path.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (path === '/' || path === '/index.html') return serveFile(res, join(PUBLIC_DIR, 'index.html'), DISPLAY_HEADERS);
    if (path === '/settings' || path === '/settings/') return serveFile(res, join(PUBLIC_DIR, 'settings.html'), SETTINGS_HEADERS);
    if (path.startsWith('/photos/')) {
      const name = decodeURIComponent(path.slice('/photos/'.length));
      if (!name || name.includes('/') || name.includes('\\') || name.startsWith('.') || !PHOTO_EXT.has(extname(name).toLowerCase())) return send(res, 404, 'Not found');
      const file = join(PHOTO_DIR, name);
      if (!(await stat(file).catch(() => null))?.isFile()) return send(res, 404, 'Not found');
      return serveFile(res, file);
    }
    const rel = path.replace(/^\/+/, '');
    if (!/^[a-z0-9._-]+$/i.test(rel) || rel.startsWith('.')) return send(res, 404, 'Not found');
    return serveFile(res, join(PUBLIC_DIR, rel));
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
    if (!err.status) console.error(err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Kalends ${VERSION} listening on http://${HOST}:${PORT} (data: ${DATA_DIR})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    store.db.close();
    process.exit(0);
  });
}
