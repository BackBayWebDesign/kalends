import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const PALETTE = ['#8b5cf6', '#f59e0b', '#38bdf8', '#34d399', '#fb7185', '#fb923c', '#a3e635', '#f472b6'];

const systemTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export const DEFAULT_SETTINGS = {
  title: '',
  timezone: systemTimezone(),
  locale: 'en-US',
  weekStart: 0,
  weeks: 5,
  gridMode: 'rolling',
  clock24: false,
  showSeconds: false,
  refreshMinutes: 15,
  agendaDays: 3,
  agendaMax: 8,
  layout: 'auto',
  scale: 1,
  weather: {
    enabled: true,
    name: 'Wenonah, NJ',
    latitude: 39.7948,
    longitude: -75.1488,
    units: 'imperial'
  },
  photos: {
    enabled: false,
    urls: [],
    intervalSeconds: 60
  }
};

const DEFAULT_CALENDARS = [
  {
    name: 'US Holidays',
    url: 'https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics',
    color: '#34d399'
  }
];

const clampInt = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const isTimezone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);

export function sanitizeSettings(input = {}, base = DEFAULT_SETTINGS) {
  const s = structuredClone(base);
  const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
  if (str(input.title) !== undefined) s.title = str(input.title, 80);
  if (input.timezone && isTimezone(input.timezone)) s.timezone = input.timezone;
  if (str(input.locale)) {
    try {
      new Intl.DateTimeFormat(input.locale);
      s.locale = str(input.locale, 20);
    } catch {}
  }
  if (input.weekStart !== undefined) s.weekStart = clampInt(input.weekStart, 0, 6, s.weekStart);
  if (input.weeks !== undefined) s.weeks = clampInt(input.weeks, 1, 8, s.weeks);
  if (['rolling', 'month'].includes(input.gridMode)) s.gridMode = input.gridMode;
  if (input.clock24 !== undefined) s.clock24 = Boolean(input.clock24);
  if (input.showSeconds !== undefined) s.showSeconds = Boolean(input.showSeconds);
  if (input.refreshMinutes !== undefined) s.refreshMinutes = clampInt(input.refreshMinutes, 1, 1440, s.refreshMinutes);
  if (input.agendaDays !== undefined) s.agendaDays = clampInt(input.agendaDays, 1, 14, s.agendaDays);
  if (input.agendaMax !== undefined) s.agendaMax = clampInt(input.agendaMax, 1, 30, s.agendaMax);
  if (['auto', 'portrait', 'landscape'].includes(input.layout)) s.layout = input.layout;
  if (input.scale !== undefined) s.scale = clampNum(input.scale, 0.5, 2, s.scale);
  if (input.weather && typeof input.weather === 'object') {
    const w = input.weather;
    if (w.enabled !== undefined) s.weather.enabled = Boolean(w.enabled);
    if (str(w.name) !== undefined) s.weather.name = str(w.name, 80);
    if (w.latitude !== undefined) s.weather.latitude = clampNum(w.latitude, -90, 90, s.weather.latitude);
    if (w.longitude !== undefined) s.weather.longitude = clampNum(w.longitude, -180, 180, s.weather.longitude);
    if (['imperial', 'metric'].includes(w.units)) s.weather.units = w.units;
  }
  if (input.photos && typeof input.photos === 'object') {
    const p = input.photos;
    if (p.enabled !== undefined) s.photos.enabled = Boolean(p.enabled);
    if (Array.isArray(p.urls)) {
      s.photos.urls = p.urls
        .map((u) => (typeof u === 'string' ? u.trim() : ''))
        .filter((u) => /^https?:\/\//i.test(u))
        .slice(0, 200);
    }
    if (p.intervalSeconds !== undefined) s.photos.intervalSeconds = clampInt(p.intervalSeconds, 5, 86400, s.photos.intervalSeconds);
  }
  return s;
}

export function sanitizeCalendar(input = {}, index = 0) {
  const type = ['google', 'microsoft'].includes(input.type) ? input.type : 'ical';
  const name = (typeof input.name === 'string' ? input.name.trim() : '').slice(0, 80) || `Calendar ${index + 1}`;
  const base = {
    id: typeof input.id === 'string' && /^[a-z0-9]{1,32}$/i.test(input.id) ? input.id : undefined,
    type,
    name,
    url: '',
    account_id: null,
    remote_id: null,
    color: isColor(input.color) ? input.color.toLowerCase() : PALETTE[index % PALETTE.length],
    enabled: input.enabled === undefined ? true : Boolean(input.enabled)
  };
  if (type === 'ical') {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    const normalized = url.replace(/^(webcals?):\/\//i, (m, s) => `${s.toLowerCase()}://`);
    if (!/^(https?|webcals?):\/\/\S+$/i.test(normalized)) throw new Error(`${name}: the link must start with http://, https:// or webcal://`);
    base.url = normalized;
    return base;
  }
  if (typeof input.account_id !== 'string' || !input.account_id || typeof input.remote_id !== 'string' || !input.remote_id) {
    throw new Error(`${name}: missing account or calendar`);
  }
  base.account_id = input.account_id;
  base.remote_id = input.remote_id.slice(0, 1024);
  return base;
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, 'photos'), { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'kalends.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        color TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL DEFAULT '',
        refresh_token TEXT NOT NULL,
        access_token TEXT,
        expires_at INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
    const cols = new Set(this.db.prepare('PRAGMA table_info(calendars)').all().map((c) => c.name));
    if (!cols.has('type')) this.db.exec("ALTER TABLE calendars ADD COLUMN type TEXT NOT NULL DEFAULT 'ical'");
    if (!cols.has('account_id')) this.db.exec('ALTER TABLE calendars ADD COLUMN account_id TEXT');
    if (!cols.has('remote_id')) this.db.exec('ALTER TABLE calendars ADD COLUMN remote_id TEXT');
    if (this.getKv('initialized') === undefined) {
      const insert = this.db.prepare('INSERT INTO calendars (id, name, url, color, enabled, sort) VALUES (?, ?, ?, ?, 1, ?)');
      DEFAULT_CALENDARS.forEach((c, i) => insert.run(newId(), c.name, c.url, c.color, i));
      this.setKv('settings', JSON.stringify(DEFAULT_SETTINGS));
      this.setKv('initialized', new Date().toISOString());
      this.touch();
    }
  }

  getKv(key) {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row ? row.value : undefined;
  }

  setKv(key, value) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  deleteKv(key) {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  touch() {
    this.setKv('version', String(Date.now()));
  }

  version() {
    return this.getKv('version') || '0';
  }

  settings() {
    let stored = {};
    try {
      stored = JSON.parse(this.getKv('settings') || '{}');
    } catch {}
    return sanitizeSettings(stored, DEFAULT_SETTINGS);
  }

  saveSettings(input) {
    const merged = sanitizeSettings(input, this.settings());
    this.setKv('settings', JSON.stringify(merged));
    this.touch();
    return merged;
  }

  calendars() {
    return this.db
      .prepare('SELECT id, type, name, url, account_id, remote_id, color, enabled FROM calendars ORDER BY sort, rowid')
      .all()
      .map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
  }

  saveCalendars(list) {
    if (!Array.isArray(list)) throw new Error('calendars must be a list');
    if (list.length > 100) throw new Error('At most 100 calendars');
    const clean = list.map((c, i) => sanitizeCalendar(c, i));
    const accounts = new Set(this.accounts().map((a) => a.id));
    for (const c of clean) if (c.type !== 'ical' && !accounts.has(c.account_id)) throw new Error(`${c.name}: its account is no longer connected`);
    const existing = new Map(this.calendars().map((c) => [c.id, c]));
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM calendars');
      const insert = this.db.prepare('INSERT INTO calendars (id, type, name, url, account_id, remote_id, color, enabled, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      clean.forEach((c, i) => {
        const id = c.id && existing.has(c.id) ? c.id : newId();
        insert.run(id, c.type, c.name, c.url, c.account_id, c.remote_id, c.color, c.enabled ? 1 : 0, i);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.touch();
    return this.calendars();
  }

  accounts() {
    return this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all();
  }

  account(id) {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  }

  upsertAccount(provider, info) {
    const existing = this.db
      .prepare('SELECT id FROM accounts WHERE provider = ? AND ((subject != \'\' AND subject = ?) OR (email != \'\' AND email = ?))')
      .get(provider, info.subject || '', info.email || '');
    const id = existing ? existing.id : newId();
    this.db
      .prepare(
        `INSERT INTO accounts (id, provider, email, name, subject, refresh_token, access_token, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, subject = excluded.subject,
           refresh_token = excluded.refresh_token, access_token = excluded.access_token, expires_at = excluded.expires_at`
      )
      .run(id, provider, info.email || '', info.name || '', info.subject || '', info.refreshToken, info.accessToken || null, info.expiresAt || 0, new Date().toISOString());
    return id;
  }

  saveTokens(account) {
    this.db.prepare('UPDATE accounts SET refresh_token = ?, access_token = ?, expires_at = ? WHERE id = ?').run(account.refresh_token, account.access_token, account.expires_at, account.id);
  }

  removeAccount(id) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM calendars WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.touch();
  }
}
