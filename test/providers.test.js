import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignIns, GOOGLE_REDIRECT, providerConfig, exchangeCode, accessToken, fetchEvents, listCalendars, RemoteCache } from '../lib/providers.js';
import { Store } from '../lib/store.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const { status = 200, body } = await handler(String(url), opts);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

const idToken = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

test('provider config: env overrides the built-in apps', () => {
  assert.deepEqual(providerConfig('google', { KALENDS_GOOGLE_CLIENT_ID: 'g', KALENDS_GOOGLE_CLIENT_SECRET: 's' }), { clientId: 'g', clientSecret: 's' });
  assert.deepEqual(providerConfig('microsoft', { KALENDS_MICROSOFT_CLIENT_ID: 'm' }), { clientId: 'm', tenant: 'common' });
  assert.equal(providerConfig('other', {}), null);
});

test('Google sign-in: PKCE auth URL, then the pasted loopback address finishes it once', async () => {
  const connected = [];
  const s = new SignIns(async (p, info) => {
    connected.push([p, info.email]);
    return info.email;
  });
  const { id, url } = s.beginGoogle({ clientId: 'cid', clientSecret: 'sec' });
  const u = new URL(url);
  assert.equal(u.searchParams.get('redirect_uri'), GOOGLE_REDIRECT);
  assert.equal(u.searchParams.get('state'), id);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('access_type'), 'offline');

  await assert.rejects(s.finishGoogle({}, 'not a url'), /whole address/);
  await assert.rejects(s.finishGoogle({}, `${GOOGLE_REDIRECT}?state=wrong&code=x`), /expired/);

  const calls = mockFetch(() => ({ body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken({ email: 'me@gmail.com', sub: '1' }) } }));
  assert.equal(await s.finishGoogle({ clientId: 'cid', clientSecret: 'sec' }, `  ${GOOGLE_REDIRECT}?state=${id}&code=4%2F0abc&scope=x  `), 'me@gmail.com');
  const body = new URLSearchParams(calls[0].opts.body);
  assert.equal(body.get('code'), '4/0abc');
  assert.equal(body.get('redirect_uri'), GOOGLE_REDIRECT);
  assert.equal(body.get('client_secret'), 'sec');
  assert.ok(body.get('code_verifier'));
  assert.deepEqual(connected, [['google', 'me@gmail.com']]);
  await assert.rejects(s.finishGoogle({}, `${GOOGLE_REDIRECT}?state=${id}&code=again`), /expired or was already used/);

  const second = s.beginGoogle({ clientId: 'cid' });
  await assert.rejects(s.finishGoogle({}, `${GOOGLE_REDIRECT}?state=${second.id}&error=access_denied`), /not allowed/);
});

test('Microsoft sign-in: device code, polls until approved, no client secret sent', async () => {
  let polls = 0;
  const calls = mockFetch((url) => {
    if (url.endsWith('/devicecode')) return { body: { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://microsoft.com/link', expires_in: 900, interval: 2 } };
    polls++;
    if (polls < 2) return { status: 400, body: { error: 'authorization_pending' } };
    return { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken({ preferred_username: 'me@outlook.com', oid: 'o1' }) } };
  });
  const s = new SignIns(async (p, info) => info.email, { unitMs: 5 });
  const r = await s.beginMicrosoft({ clientId: 'mid', tenant: 'common' });
  assert.equal(r.code, 'ABCD-1234');
  assert.equal(s.status(r.id).status, 'pending');
  for (let i = 0; i < 50 && s.status(r.id).status === 'pending'; i++) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(s.status(r.id), { status: 'ok', message: 'Connected me@outlook.com' });
  for (const c of calls) assert.equal(new URLSearchParams(c.opts.body).get('client_secret'), null);
  assert.equal(new URLSearchParams(calls.at(-1).opts.body).get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');

  mockFetch((url) => (url.endsWith('/devicecode') ? { body: { device_code: 'dc', user_code: 'X', expires_in: 900, interval: 2 } } : { status: 400, body: { error: 'authorization_declined' } }));
  const r2 = await s.beginMicrosoft({ clientId: 'mid', tenant: 'common' });
  for (let i = 0; i < 50 && s.status(r2.id).status === 'pending'; i++) await new Promise((x) => setTimeout(x, 10));
  assert.deepEqual(s.status(r2.id), { status: 'error', message: 'Sign-in was cancelled.' });
});

test('code exchange reads the id_token and requires a refresh token', async () => {
  const calls = mockFetch(() => ({ body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, id_token: idToken({ email: 'a@example.com', sub: '123', name: 'A' }) } }));
  const info = await exchangeCode('google', { clientId: 'c', clientSecret: 's' }, 'code1', { redirect: 'https://k/cb', verifier: 'v' });
  assert.equal(info.email, 'a@example.com');
  assert.equal(info.subject, '123');
  assert.equal(info.refreshToken, 'rt');
  const body = new URLSearchParams(calls[0].opts.body);
  assert.equal(body.get('code_verifier'), 'v');
  assert.equal(body.get('grant_type'), 'authorization_code');

  mockFetch(() => ({ body: { access_token: 'at', expires_in: 3600 } }));
  await assert.rejects(exchangeCode('google', { clientId: 'c', clientSecret: 's' }, 'c', { redirect: 'r', verifier: 'v' }), /No refresh token/);
});

test('access token refresh keeps a rotated refresh token and explains invalid_grant', async () => {
  mockFetch(() => ({ body: { access_token: 'new', refresh_token: 'rt2', expires_in: 3600 } }));
  const account = { id: 'a', provider: 'microsoft', refresh_token: 'rt1', access_token: null, expires_at: 0 };
  let saved = null;
  assert.equal(await accessToken(account, { clientId: 'c', clientSecret: 's' }, (a) => (saved = { ...a })), 'new');
  assert.equal(saved.refresh_token, 'rt2');
  assert.equal(await accessToken(account, {}, () => assert.fail('should use the cached token')), 'new');

  mockFetch(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'expired' } }));
  await assert.rejects(accessToken({ ...account, expires_at: 0 }, { clientId: 'c', clientSecret: 's' }, () => {}), /sign in again/);
});

test('Google events map to the iCal event shape', async () => {
  mockFetch((url) => {
    assert.match(url, /calendars\/team%40group\.calendar\.google\.com\/events\?/);
    assert.match(url, /singleEvents=true/);
    return {
      body: {
        items: [
          { status: 'confirmed', summary: 'Practice', location: 'Field 2', start: { dateTime: '2026-11-21T14:00:00-05:00' }, end: { dateTime: '2026-11-21T15:30:00-05:00' } },
          { status: 'confirmed', summary: 'Tournament', start: { date: '2026-11-28' }, end: { date: '2026-11-30' } },
          { status: 'cancelled', summary: 'Gone', start: { date: '2026-11-22' }, end: { date: '2026-11-23' } }
        ]
      }
    };
  });
  const ev = await fetchEvents('google', 'tok', 'team@group.calendar.google.com', 0, 1, 'c1');
  assert.deepEqual(ev, [
    { cal: 'c1', title: 'Practice', location: 'Field 2', allDay: false, start: Date.parse('2026-11-21T19:00:00Z'), end: Date.parse('2026-11-21T20:30:00Z') },
    { cal: 'c1', title: 'Tournament', location: '', allDay: true, start: '2026-11-28', end: '2026-11-30' }
  ]);
});

test('Microsoft events (UTC calendarView) map to the same shape and follow paging', async () => {
  const calls = mockFetch((url, opts) => {
    assert.equal(opts.headers.Prefer, 'outlook.timezone="UTC"');
    if (url.includes('page2')) return { body: { value: [{ subject: 'Dentist', start: { dateTime: '2026-11-24T15:00:00.0000000' }, end: { dateTime: '2026-11-24T16:00:00.0000000' }, isAllDay: false, location: { displayName: 'Main St' } }] } };
    return {
      body: {
        value: [
          { subject: 'Holiday', start: { dateTime: '2026-11-26T00:00:00.0000000' }, end: { dateTime: '2026-11-27T00:00:00.0000000' }, isAllDay: true },
          { subject: 'Cancelled', isCancelled: true, start: { dateTime: '2026-11-25T00:00:00.0000000' }, end: { dateTime: '2026-11-25T01:00:00.0000000' } }
        ],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/page2'
      }
    };
  });
  const ev = await fetchEvents('microsoft', 'tok', 'AAMk=', 0, 1, 'c2');
  assert.equal(calls.length, 2);
  assert.deepEqual(ev, [
    { cal: 'c2', title: 'Holiday', location: '', allDay: true, start: '2026-11-26', end: '2026-11-27' },
    { cal: 'c2', title: 'Dentist', location: 'Main St', allDay: false, start: Date.parse('2026-11-24T15:00:00Z'), end: Date.parse('2026-11-24T16:00:00Z') }
  ]);
});

test('calendar lists from both providers', async () => {
  mockFetch(() => ({ body: { items: [{ id: 'me@gmail.com', summary: 'me@gmail.com', backgroundColor: '#9fe1e7', primary: true }, { id: 'x', summary: 'Family', summaryOverride: 'Fam' }] } }));
  assert.deepEqual(await listCalendars('google', 't'), [
    { id: 'me@gmail.com', name: 'me@gmail.com', color: '#9fe1e7', primary: true },
    { id: 'x', name: 'Fam', color: null, primary: false }
  ]);
  mockFetch(() => ({ body: { value: [{ id: 'A', name: 'Calendar', hexColor: '', isDefaultCalendar: true }] } }));
  assert.deepEqual(await listCalendars('microsoft', 't'), [{ id: 'A', name: 'Calendar', color: null, primary: true }]);
});

test('remote cache reuses a covering window and refetches past it', async () => {
  const cache = new RemoteCache();
  let loads = 0;
  const loader = async () => {
    loads++;
    return [];
  };
  const cal = { id: 'c', account_id: 'a', remote_id: 'r' };
  const day = 86400000;
  await cache.get(cal, 10 * day, 20 * day, 60000, loader);
  await cache.get(cal, 12 * day, 22 * day, 60000, loader);
  assert.equal(loads, 1);
  await cache.get(cal, 12 * day, 40 * day, 60000, loader);
  assert.equal(loads, 2);
  cache.sync([{ ...cal, remote_id: 'other' }]);
  assert.equal(cache.status('c').state, 'pending');
});

test('store: accounts and typed calendars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kalends-'));
  try {
    const store = new Store(dir);
    const id = store.upsertAccount('google', { email: 'a@example.com', subject: 's1', refreshToken: 'rt' });
    assert.equal(store.upsertAccount('google', { email: 'a@example.com', subject: 's1', refreshToken: 'rt2' }), id, 'same account is updated, not duplicated');
    assert.equal(store.account(id).refresh_token, 'rt2');

    const cals = store.saveCalendars([
      { name: 'Team', url: 'webcal://example.com/team.ics' },
      { type: 'google', name: 'Family', account_id: id, remote_id: 'fam@group.calendar.google.com', color: '#123456' }
    ]);
    assert.equal(cals[1].type, 'google');
    assert.equal(cals[1].url, '');
    assert.throws(() => store.saveCalendars([{ type: 'google', name: 'X', account_id: 'nope', remote_id: 'r' }]), /no longer connected/);

    store.removeAccount(id);
    assert.deepEqual(store.calendars().map((c) => c.name), ['Team']);
    store.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
