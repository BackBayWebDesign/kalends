import { createHash, randomBytes } from 'node:crypto';

const DAY_MS = 86400000;

export const PROVIDERS = {
  google: {
    label: 'Google',
    scope: 'openid email https://www.googleapis.com/auth/calendar.readonly',
    authUrl: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' }
  },
  microsoft: {
    label: 'Microsoft',
    scope: 'openid email profile offline_access https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read',
    authUrl: (cfg) => `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant || 'common')}/oauth2/v2.0/authorize`,
    tokenUrl: (cfg) => `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant || 'common')}/oauth2/v2.0/token`,
    authParams: { response_mode: 'query', prompt: 'select_account' }
  }
};

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function redirectUri(base, provider) {
  return `${base.replace(/\/+$/, '')}/api/oauth/${provider}/callback`;
}

export class OAuthFlows {
  constructor() {
    this.pending = new Map();
  }

  begin(provider, cfg, base, returnTo) {
    const p = PROVIDERS[provider];
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const redirect = redirectUri(base, provider);
    for (const [k, v] of this.pending) if (v.expires < Date.now()) this.pending.delete(k);
    this.pending.set(state, { provider, verifier, redirect, returnTo: (returnTo || base).replace(/\/+$/, ''), expires: Date.now() + 10 * 60000 });
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirect,
      response_type: 'code',
      scope: p.scope,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...p.authParams
    });
    return `${p.authUrl(cfg)}?${params}`;
  }

  take(state, provider) {
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (!entry || entry.provider !== provider || entry.expires < Date.now()) return null;
    return entry;
  }
}

async function tokenRequest(provider, cfg, body) {
  const p = PROVIDERS[provider];
  const res = await fetch(p.tokenUrl(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(j.error_description || j.error || `Token request failed (HTTP ${res.status})`);
    err.code = j.error;
    throw err;
  }
  return j;
}

function decodeIdToken(idToken) {
  try {
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export async function exchangeCode(provider, cfg, code, flow) {
  const body = { code, redirect_uri: flow.redirect, grant_type: 'authorization_code', code_verifier: flow.verifier };
  if (provider === 'microsoft') body.scope = PROVIDERS.microsoft.scope;
  const t = await tokenRequest(provider, cfg, body);
  if (!t.refresh_token) throw new Error('The provider did not return a refresh token. Remove Kalends from your account permissions and connect again.');
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

export async function accessToken(account, cfg, save) {
  if (account.access_token && account.expires_at - 60000 > Date.now()) return account.access_token;
  const body = { grant_type: 'refresh_token', refresh_token: account.refresh_token };
  if (account.provider === 'microsoft') body.scope = PROVIDERS.microsoft.scope;
  let t;
  try {
    t = await tokenRequest(account.provider, cfg, body);
  } catch (err) {
    if (err.code === 'invalid_grant') err.message = 'Sign-in expired or was revoked. Remove the account and connect it again.';
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
