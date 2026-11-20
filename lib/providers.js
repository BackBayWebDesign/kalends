import { createHash, randomBytes } from 'node:crypto';

const DAY_MS = 86400000;

// Kalends' own app registrations. Both are "public" clients: Google's Desktop-app
// secret is not confidential by design (Google: installed apps can't keep secrets), and
// the Microsoft app has no secret at all. Set the env vars to use your own instead.
const BUILTIN = {
  google: {
    clientId: '38977148168-ncog3vb8a0icrf7p5ep859cj2qipgt0g.apps.googleusercontent.com',
    clientSecret: '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'
  },
  microsoft: { clientId: '' }
};

export const PROVIDERS = {
  google: {
    label: 'Google',
    scope: 'openid email https://www.googleapis.com/auth/calendar.readonly',
    authUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token'
  },
  microsoft: {
    label: 'Microsoft',
    scope: 'openid email profile offline_access https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read',
    deviceUrl: (cfg) => `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/devicecode`,
    tokenUrl: (cfg) => `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`
  }
};

// Google only lets Desktop-app clients redirect to a loopback address. Nothing listens
// there, so the browser shows "can't connect" and the user pastes that address back.
export const GOOGLE_REDIRECT = 'http://127.0.0.1:47613/kalends-sign-in';

export function providerConfig(provider, env = process.env) {
  if (provider === 'google') {
    const clientId = env.KALENDS_GOOGLE_CLIENT_ID || BUILTIN.google.clientId;
    const clientSecret = env.KALENDS_GOOGLE_CLIENT_SECRET || (env.KALENDS_GOOGLE_CLIENT_ID ? '' : BUILTIN.google.clientSecret);
    return clientId ? { clientId, clientSecret } : null;
  }
  if (provider === 'microsoft') {
    const clientId = env.KALENDS_MICROSOFT_CLIENT_ID || BUILTIN.microsoft.clientId;
    return clientId ? { clientId, tenant: env.KALENDS_MICROSOFT_TENANT || 'common' } : null;
  }
  return null;
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Microsoft appends trace/correlation ids and timestamps to every error description.
const cleanError = (j, fallback) => String(j.error_description || j.error || fallback).split(/\r?\n| Trace ID:/)[0].trim();

async function tokenRequest(provider, cfg, body) {
  const p = PROVIDERS[provider];
  const params = new URLSearchParams({ client_id: cfg.clientId, ...body });
  if (cfg.clientSecret) params.set('client_secret', cfg.clientSecret);
  const res = await fetch(p.tokenUrl(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params,
    signal: AbortSignal.timeout(20000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(cleanError(j, `Token request failed (HTTP ${res.status})`));
    err.code = j.error;
    throw err;
  }
  return j;
}

/**
 * Sign-ins in progress, keyed by an unguessable id.
 * Google: begin → user signs in → paste the loopback address back → finish.
 * Microsoft: device code shown in Kalends → user enters it at microsoft.com/link → we poll.
 */
export class SignIns {
  constructor(onConnected, { unitMs = 1000 } = {}) {
    this.pending = new Map();
    this.onConnected = onConnected;
    this.unitMs = unitMs;
  }

  prune() {
    for (const [k, v] of this.pending) if (v.expires < Date.now() - 10 * 60000) this.pending.delete(k);
  }

  beginGoogle(cfg) {
    this.prune();
    const id = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    this.pending.set(id, { provider: 'google', verifier, redirect: GOOGLE_REDIRECT, status: 'pending', expires: Date.now() + 15 * 60000 });
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: GOOGLE_REDIRECT,
      response_type: 'code',
      scope: PROVIDERS.google.scope,
      state: id,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent select_account'
    });
    return { id, url: `${PROVIDERS.google.authUrl()}?${params}` };
  }

  async finishGoogle(cfg, pasted) {
    let u;
    try {
      u = new URL(String(pasted || '').trim());
    } catch {
      throw new Error('That is not the address. Copy the whole address from the tab Google sent you to (it starts with http://127.0.0.1).');
    }
    const id = u.searchParams.get('state') || '';
    const flow = this.pending.get(id);
    if (!flow || flow.provider !== 'google' || flow.expires < Date.now()) throw new Error('This sign-in expired or was already used. Press Sign in with Google again.');
    const err = u.searchParams.get('error');
    if (err) {
      this.pending.delete(id);
      throw new Error(err === 'access_denied' ? 'Access was not allowed. Press Sign in with Google to try again.' : err);
    }
    const code = u.searchParams.get('code');
    if (!code) throw new Error('That address has no sign-in code in it. Copy it again from the tab Google sent you to.');
    this.pending.delete(id);
    let info;
    try {
      info = await exchangeCode('google', cfg, code, flow);
    } catch (err) {
      err.message = `${err.message} Press Sign in with Google to try again.`;
      throw err;
    }
    return this.onConnected('google', info);
  }

  async beginMicrosoft(cfg) {
    this.prune();
    const res = await fetch(PROVIDERS.microsoft.deviceUrl(cfg), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: cfg.clientId, scope: PROVIDERS.microsoft.scope }),
      signal: AbortSignal.timeout(20000)
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.device_code) throw new Error(cleanError(j, `Microsoft sign-in failed (HTTP ${res.status})`));
    const id = b64url(randomBytes(24));
    const flow = { provider: 'microsoft', status: 'pending', expires: Date.now() + (Number(j.expires_in) || 900) * 1000 };
    this.pending.set(id, flow);
    this.pollMicrosoft(cfg, flow, j.device_code, Math.max(Number(j.interval) || 5, 2));
    return { id, code: j.user_code, verifyUrl: j.verification_uri || 'https://microsoft.com/devicelogin', expiresIn: Number(j.expires_in) || 900 };
  }

  async pollMicrosoft(cfg, flow, deviceCode, interval) {
    while (flow.status === 'pending') {
      await sleep(interval * this.unitMs);
      if (flow.status !== 'pending') return;
      if (Date.now() > flow.expires) {
        Object.assign(flow, { status: 'error', message: 'The code expired. Press Sign in with Microsoft again.' });
        return;
      }
      try {
        const t = await tokenRequest('microsoft', cfg, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
        const name = await this.onConnected('microsoft', tokensToInfo(t));
        Object.assign(flow, { status: 'ok', message: `Connected ${name}` });
      } catch (err) {
        if (err.code === 'authorization_pending') continue;
        if (err.code === 'slow_down') {
          interval += 5;
          continue;
        }
        const message =
          err.code === 'authorization_declined' ? 'Sign-in was cancelled.' : err.code === 'expired_token' ? 'The code expired. Press Sign in with Microsoft again.' : err.name === 'TimeoutError' ? null : err.message;
        if (message === null) continue;
        Object.assign(flow, { status: 'error', message });
      }
    }
  }

  status(id) {
    const f = this.pending.get(id);
    if (!f) return { status: 'error', message: 'This sign-in is no longer active.' };
    return { status: f.status, message: f.message || '' };
  }

  cancel(id) {
    const f = this.pending.get(id);
    if (f) f.status = 'cancelled';
    this.pending.delete(id);
  }
}

function decodeIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function tokensToInfo(t) {
  if (!t.refresh_token) throw new Error('No refresh token came back, so Kalends could not stay signed in. Try again.');
  const claims = decodeIdToken(t.id_token || '');
  return {
    email: claims.email || claims.preferred_username || claims.upn || '',
    name: claims.name || '',
    subject: claims.sub || claims.oid || '',
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000
  };
}

export async function exchangeCode(provider, cfg, code, flow) {
  const t = await tokenRequest(provider, cfg, { code, redirect_uri: flow.redirect, grant_type: 'authorization_code', code_verifier: flow.verifier });
  return tokensToInfo(t);
}

export async function accessToken(account, cfg, save) {
  if (account.access_token && account.expires_at - 60000 > Date.now()) return account.access_token;
  const body = { grant_type: 'refresh_token', refresh_token: account.refresh_token };
  if (account.provider === 'microsoft') body.scope = PROVIDERS.microsoft.scope;
  let t;
  try {
    t = await tokenRequest(account.provider, cfg, body);
  } catch (err) {
    if (err.code === 'invalid_grant') err.message = 'Signed out (expired or access removed). Remove the account in Settings and sign in again.';
    throw err;
  }
  account.access_token = t.access_token;
  account.expires_at = Date.now() + (Number(t.expires_in) || 3600) * 1000;
  if (t.refresh_token) account.refresh_token = t.refresh_token;
  save(account);
  return account.access_token;
}

export async function revoke(account) {
  if (account.provider !== 'google') return;
  await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: account.refresh_token }),
    signal: AbortSignal.timeout(10000)
  });
}

async function getJson(url, token, headers = {}) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(20000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || j.error_description || `HTTP ${res.status}`);
  return j;
}

export async function listCalendars(provider, token) {
  if (provider === 'google') {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250' });
      if (pageToken) params.set('pageToken', pageToken);
      const j = await getJson(`https://www.googleapis.com/calendar/v3/users/me/calendarList?${params}`, token);
      for (const c of j.items || []) out.push({ id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || null, primary: Boolean(c.primary) });
      pageToken = j.nextPageToken || '';
    } while (pageToken && out.length < 1000);
    return out;
  }
  const out = [];
  let url = 'https://graph.microsoft.com/v1.0/me/calendars?$top=100&$select=id,name,hexColor,isDefaultCalendar';
  while (url && out.length < 1000) {
    const j = await getJson(url, token);
    for (const c of j.value || []) out.push({ id: c.id, name: c.name, color: c.hexColor || null, primary: Boolean(c.isDefaultCalendar) });
    url = j['@odata.nextLink'] || '';
  }
  return out;
}

export async function fetchEvents(provider, token, remoteId, fromMs, toMs, calId) {
  const out = [];
  if (provider === 'google') {
    let pageToken = '';
    let pages = 0;
    do {
      const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: new Date(fromMs).toISOString(),
        timeMax: new Date(toMs).toISOString(),
        maxResults: '2500',
        fields: 'items(status,summary,location,start,end),nextPageToken'
      });
      if (pageToken) params.set('pageToken', pageToken);
      const j = await getJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(remoteId)}/events?${params}`, token);
      for (const e of j.items || []) {
        if (e.status === 'cancelled' || !e.start) continue;
        const title = (e.summary || '').trim() || '(No title)';
        const location = (e.location || '').trim();
        if (e.start.date) {
          out.push({ cal: calId, title, location, allDay: true, start: e.start.date, end: e.end?.date || e.start.date });
        } else {
          const s = Date.parse(e.start.dateTime);
          const en = Date.parse(e.end?.dateTime || e.start.dateTime);
          out.push({ cal: calId, title, location, allDay: false, start: s, end: Math.max(s, en) });
        }
      }
      pageToken = j.nextPageToken || '';
    } while (pageToken && ++pages < 10);
    return out;
  }
  const params = new URLSearchParams({
    startDateTime: new Date(fromMs).toISOString(),
    endDateTime: new Date(toMs).toISOString(),
    $top: '250',
    $select: 'subject,start,end,isAllDay,location,isCancelled'
  });
  let url = `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(remoteId)}/calendarView?${params}`;
  let pages = 0;
  while (url && pages++ < 20) {
    const j = await getJson(url, token, { Prefer: 'outlook.timezone="UTC"' });
    for (const e of j.value || []) {
      if (e.isCancelled || !e.start) continue;
      const title = (e.subject || '').trim() || '(No title)';
      const location = (e.location?.displayName || '').trim();
      if (e.isAllDay) {
        const s = e.start.dateTime.slice(0, 10);
        const en = (e.end?.dateTime || e.start.dateTime).slice(0, 10);
        out.push({ cal: calId, title, location, allDay: true, start: s, end: en > s ? en : s });
      } else {
        const s = Date.parse(`${e.start.dateTime.replace(/Z$/, '')}Z`);
        const en = Date.parse(`${(e.end?.dateTime || e.start.dateTime).replace(/Z$/, '')}Z`);
        out.push({ cal: calId, title, location, allDay: false, start: s, end: Math.max(s, en) });
      }
    }
    url = j['@odata.nextLink'] || '';
  }
  return out;
}

export class RemoteCache {
  constructor() {
    this.entries = new Map();
  }

  status(id) {
    const e = this.entries.get(id);
    if (!e) return { state: 'pending' };
    return { state: e.error && !e.events ? 'error' : 'ok', error: e.error || null, fetchedAt: e.fetchedAt || null, events: e.events ? e.events.length : 0 };
  }

  async get(cal, fromMs, toMs, ttlMs, loader) {
    const now = Date.now();
    const e = this.entries.get(cal.id);
    const key = `${cal.account_id}|${cal.remote_id}`;
    const usable = e && e.key === key;
    if (usable && e.events && e.from <= fromMs && e.to >= toMs && now - e.fetchedAt < ttlMs) return e;
    if (usable && e.error && now - e.failedAt < Math.min(ttlMs, 60000)) return e;
    if (usable && e.pending) return e.pending;
    const entry = usable ? e : { key };
    const from = fromMs - 7 * DAY_MS;
    const to = toMs + 7 * DAY_MS;
    entry.pending = (async () => {
      try {
        entry.events = await loader(from, to);
        entry.from = from;
        entry.to = to;
        entry.fetchedAt = Date.now();
        entry.error = null;
      } catch (err) {
        entry.error = err?.name === 'TimeoutError' ? 'Timed out' : String(err?.message || err);
        entry.failedAt = Date.now();
      } finally {
        entry.pending = null;
      }
      return entry;
    })();
    this.entries.set(cal.id, entry);
    return entry.pending;
  }

  sync(calendars) {
    const keys = new Map(calendars.map((c) => [c.id, `${c.account_id}|${c.remote_id}`]));
    for (const [id, e] of this.entries) if (keys.get(id) !== e.key) this.entries.delete(id);
  }
}
