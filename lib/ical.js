import ICAL from 'ical.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_ITERATIONS = 50000;
const DAY_MS = 86400000;

const ianaCache = new Map();
export function isIanaZone(tz) {
  if (!tz) return false;
  if (ianaCache.has(tz)) return ianaCache.get(tz);
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    ok = true;
  } catch {}
  ianaCache.set(tz, ok);
  return ok;
}

const fmtCache = new Map();
function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function wallClock(ms, tz) {
  const p = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(ms))) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second)
  };
}

function offsetAt(ms, tz) {
  const w = wallClock(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

export function zonedToUtc(year, month, day, hour, minute, second, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = offsetAt(guess, tz);
  let t = guess - off1;
  const off2 = offsetAt(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

export function dateKey(ms, tz) {
  const w = wallClock(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

const pad = (n) => String(n).padStart(2, '0');
const icalDateKey = (t) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;

export function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function keyToUtc(key, tz) {
  const [y, m, d] = key.split('-').map(Number);
  return zonedToUtc(y, m, d, 0, 0, 0, tz);
}

function timeToMs(t, fallbackTz) {
  if (t.zone === ICAL.Timezone.utcTimezone || t.timezone === 'Z' || t.zone?.tzid === 'UTC') {
    return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
  }
  const tzid = t.timezone || t.zone?.tzid;
  if (tzid && isIanaZone(tzid)) return zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, tzid);
  if (t.zone && t.zone !== ICAL.Timezone.localTimezone && t.zone.component) return t.toUnixTime() * 1000;
  return zonedToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, fallbackTz);
}

async function request(url, timeoutMs) {
  return fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'Kalends (self-hosted wall calendar)', Accept: 'text/calendar, */*;q=0.5' }
  });
}

export async function fetchIcs(url, { timeoutMs = 20000 } = {}) {
  let res;
  if (/^webcal:\/\//i.test(url)) {
    try {
      res = await request(url.replace(/^webcal:\/\//i, 'https://'), timeoutMs);
    } catch {
      res = await request(url.replace(/^webcal:\/\//i, 'http://'), timeoutMs);
    }
  } else {
    res = await request(url.replace(/^webcals:\/\//i, 'https://'), timeoutMs);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error('Feed is larger than 20 MB');
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error('Feed is larger than 20 MB');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('Not an iCalendar feed (no BEGIN:VCALENDAR)');
  return text;
}

export function parseIcs(text) {
  const root = new ICAL.Component(ICAL.parse(text));
  const zones = new Map();
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    const tz = new ICAL.Timezone(vtz);
    if (tz.tzid) zones.set(tz.tzid, tz);
  }
  for (const [tzid, tz] of zones) {
    if (!ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(tz, tzid);
  }
  const masters = new Map();
  const exceptions = [];
  const singles = [];
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(vevent);
    if (!ev.startDate) continue;
    if (vevent.hasProperty('recurrence-id')) exceptions.push(ev);
    else if (ev.isRecurring()) masters.set(ev.uid, ev);
    else singles.push(ev);
  }
  for (const ex of exceptions) {
    const master = masters.get(ex.uid);
    if (master) master.relateException(ex);
    else singles.push(ex);
  }
  return { masters: [...masters.values()], singles, name: root.getFirstPropertyValue('x-wr-calname') || '' };
}

function toEvent(item, start, end, calId, tz) {
  const status = String(item.component.getFirstPropertyValue('status') || '').toUpperCase();
  if (status === 'CANCELLED') return null;
  const title = (item.summary || '').trim() || '(No title)';
  const location = (item.location || '').trim();
  if (start.isDate) {
    const s = icalDateKey(start);
    let e = end ? icalDateKey(end) : addDays(s, 1);
    if (e <= s) e = addDays(s, 1);
    return { cal: calId, title, location, allDay: true, start: s, end: e };
  }
  const s = timeToMs(start, tz);
  let e = end ? timeToMs(end, tz) : s;
  if (e < s) e = s;
  return { cal: calId, title, location, allDay: false, start: s, end: e };
}

function overlaps(ev, from, to, fromMs, toMs) {
  if (ev.allDay) return ev.start < to && ev.end > from;
  return ev.start < toMs && (ev.end > fromMs || (ev.end === ev.start && ev.start >= fromMs));
}

export function expand(parsed, calId, from, to, tz) {
  const fromMs = keyToUtc(from, tz);
  const toMs = keyToUtc(to, tz);
  const out = [];
  for (const ev of parsed.singles) {
    const e = toEvent(ev, ev.startDate, ev.endDate, calId, tz);
    if (e && overlaps(e, from, to, fromMs, toMs)) out.push(e);
  }
  const stopMs = toMs + DAY_MS;
  for (const master of parsed.masters) {
    const it = master.iterator();
    let next;
    let n = 0;
    while ((next = it.next()) && n++ < MAX_ITERATIONS) {
      const startMs = next.isDate ? keyToUtc(icalDateKey(next), tz) : timeToMs(next, tz);
      if (startMs > stopMs) break;
      const details = master.getOccurrenceDetails(next);
      const e = toEvent(details.item, details.startDate, details.endDate, calId, tz);
      if (e && overlaps(e, from, to, fromMs, toMs)) out.push(e);
    }
  }
  return out;
}

export class CalendarCache {
  constructor() {
    this.entries = new Map();
  }

  status(id) {
    const e = this.entries.get(id);
    if (!e) return { state: 'pending' };
    return {
      state: e.error && !e.parsed ? 'error' : 'ok',
      error: e.error || null,
      fetchedAt: e.fetchedAt || null,
      events: e.parsed ? e.parsed.singles.length + e.parsed.masters.length : 0
    };
  }

  async get(cal, ttlMs) {
    const now = Date.now();
    let e = this.entries.get(cal.id);
    if (e && e.url !== cal.url) {
      this.entries.delete(cal.id);
      e = undefined;
    }
    const fresh = e && e.parsed && now - e.fetchedAt < ttlMs;
    const recentlyFailed = e && e.error && now - e.failedAt < Math.min(ttlMs, 60000);
    if (fresh || recentlyFailed) return e;
    if (e?.pending) return e.pending;
    const entry = e || { url: cal.url };
    entry.pending = (async () => {
      try {
        entry.parsed = parseIcs(await fetchIcs(cal.url));
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
    const urls = new Map(calendars.map((c) => [c.id, c.url]));
    for (const [id, e] of this.entries) if (urls.get(id) !== e.url) this.entries.delete(id);
  }
}
