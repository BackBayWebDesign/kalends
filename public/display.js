const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DAY_MS = 86400000;

const state = {
  settings: null,
  calendars: new Map(),
  version: null,
  events: [],
  errors: [],
  weather: null,
  range: null,
  todayKey: null,
  photos: [],
  photoIndex: 0,
  timers: {}
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/* ---------- date helpers (all calendar math is done on YYYY-MM-DD keys in the display timezone) ---------- */

const fmtCache = new Map();
function fmt(opts) {
  const s = state.settings;
  const key = JSON.stringify([s.locale, s.timezone, opts]);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(s.locale, { timeZone: s.timezone, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}
const pad = (n) => String(n).padStart(2, '0');

function parts(ms) {
  const p = {};
  for (const { type, value } of fmt({ hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second };
}
function keyOf(ms) {
  const p = parts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
function keyToUtcDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}
function addDays(key, n) {
  const dt = new Date(keyToUtcDate(key).getTime() + n * DAY_MS);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
const weekday = (key) => keyToUtcDate(key).getUTCDay();
const dayOfMonth = (key) => Number(key.slice(8, 10));
const diffDays = (a, b) => Math.round((keyToUtcDate(b) - keyToUtcDate(a)) / DAY_MS);
const utcFmtCache = new Map();
function keyLabel(key, opts) {
  const s = state.settings;
  const k = JSON.stringify([s.locale, opts]);
  let f = utcFmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(s.locale, { timeZone: 'UTC', ...opts });
    utcFmtCache.set(k, f);
  }
  return f.format(keyToUtcDate(key));
}

function shortTime(ms) {
  const p = parts(ms);
  if (state.settings.clock24) return `${pad(p.h)}:${pad(p.min)}`;
  const h = p.h % 12 || 12;
  return `${h}${p.min ? `:${pad(p.min)}` : ''}${p.h < 12 ? 'a' : 'p'}`;
}
function agendaTime(ms) {
  const p = parts(ms);
  if (state.settings.clock24) return `${pad(p.h)}:${pad(p.min)}`;
  const h = p.h % 12 || 12;
  return `${h}:${pad(p.min)} ${p.h < 12 ? 'am' : 'pm'}`;
}

function textColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return lum > 0.32 ? '#111318' : '#ffffff';
}

/* ---------- layout ---------- */

function applyLayout() {
  const s = state.settings;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const want = params.get('layout') || s.layout;
  const portrait = want === 'portrait' || (want !== 'landscape' && h > w * 1.05);
  const app = $('app');
  app.classList.toggle('layout-portrait', portrait);
  app.classList.toggle('layout-landscape', !portrait);
  const scale = Number(params.get('scale')) || s.scale || 1;
  const base = Math.min(w, h * (portrait ? 1 : 1.25)) / 100;
  document.documentElement.style.setProperty('--u', `${Math.max(base, 5.5) * scale}px`);
}

/* ---------- clock ---------- */

function tickClock() {
  if (!state.settings) return;
  const s = state.settings;
  const now = Date.now();
  const p = parts(now);
  const time = $('time');
  let hh = p.h;
  let ampm = '';
  if (!s.clock24) {
    ampm = hh < 12 ? 'am' : 'pm';
    hh = hh % 12 || 12;
  }
  time.textContent = `${s.clock24 ? pad(hh) : hh}:${pad(p.min)}`;
  if (s.showSeconds) time.append(el('span', 'seconds', `:${pad(p.s)}`));
  $('ampm').textContent = ampm;
  $('date').textContent = fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(now));
  const today = keyOf(now);
  if (today !== state.todayKey) {
    state.todayKey = today;
    loadEvents();
  } else if (p.s === 0) {
    render();
  }
}

/* ---------- events ---------- */

function computeRange() {
  const s = state.settings;
  const today = keyOf(Date.now());
  let start;
  let weeks = Number(params.get('weeks')) || s.weeks;
  if ((params.get('mode') || s.gridMode) === 'month') {
    const first = `${today.slice(0, 8)}01`;
    start = addDays(first, -((weekday(first) - s.weekStart + 7) % 7));
    const nextMonth = addDays(`${today.slice(0, 8)}28`, 4).slice(0, 8) + '01';
    weeks = Math.ceil(diffDays(start, nextMonth) / 7);
  } else {
    start = addDays(today, -((weekday(today) - s.weekStart + 7) % 7));
  }
  weeks = Math.min(8, Math.max(1, weeks));
  const end = addDays(start, weeks * 7);
  const agendaEnd = addDays(today, s.agendaDays);
  return { today, start, end, weeks, fetchFrom: start < today ? start : today, fetchTo: end > agendaEnd ? end : agendaEnd };
}

async function loadEvents() {
  if (!state.settings) return;
  const r = computeRange();
  state.range = r;
  try {
    const data = await getJson(`api/events?from=${r.fetchFrom}&to=${r.fetchTo}`);
    state.events = data.events;
    state.errors = data.errors;
  } catch (err) {
    state.errors = [{ name: 'Kalends', error: err.message }];
  }
  render();
}

function eventDays(ev) {
  if (ev.allDay) {
    const days = [];
    for (let k = ev.start; k < ev.end && days.length < 400; k = addDays(k, 1)) days.push(k);
    return days;
  }
  const first = keyOf(ev.start);
  const last = keyOf(Math.max(ev.start, ev.end - 1));
  const days = [];
  for (let k = first; k <= last && days.length < 400; k = addDays(k, 1)) days.push(k);
  return days;
}

function byDay() {
  const map = new Map();
  for (const ev of state.events) {
    if (!state.calendars.has(ev.cal)) continue;
    const days = eventDays(ev);
    days.forEach((k, i) => {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ ev, first: i === 0, last: i === days.length - 1, multi: days.length > 1 });
    });
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      const am = a.ev.allDay || a.multi;
      const bm = b.ev.allDay || b.multi;
      if (am !== bm) return am ? -1 : 1;
      if (am && a.multi !== b.multi) return a.multi ? -1 : 1;
      const as = a.ev.allDay ? 0 : a.ev.start;
      const bs = b.ev.allDay ? 0 : b.ev.start;
      return as - bs || a.ev.title.localeCompare(b.ev.title);
    });
  }
  return map;
}

function chip(item, dayKey, colStart, colEnd) {
  const { ev } = item;
  const cal = state.calendars.get(ev.cal);
  const c = el('div', 'ev');
  c.style.setProperty('--c', cal.color);
  c.style.setProperty('--fg', textColor(cal.color));
  if (item.multi && !item.first && !colStart) c.classList.add('cont-l');
  if (item.multi && !item.last && !colEnd) c.classList.add('cont-r');
  if (!ev.allDay && ev.end < Date.now() && ev.end > ev.start - 1) c.classList.add('ended');
  if (!ev.allDay && item.first) c.append(el('span', 't', shortTime(ev.start)));
  c.append(document.createTextNode(ev.title));
  c.title = `${cal.name}: ${ev.title}${ev.location ? ` (${ev.location})` : ''}`;
  return c;
}

function renderGrid(map) {
  const s = state.settings;
  const r = state.range;
  const wd = $('weekdays');
  wd.replaceChildren();
  for (let i = 0; i < 7; i++) wd.append(el('div', '', keyLabel(addDays(r.start, i), { weekday: 'short' })));
  const weeks = $('weeks');
  weeks.style.setProperty('--weeks', r.weeks);
  weeks.replaceChildren();
  const currentMonth = r.today.slice(0, 7);
  const monthMode = (params.get('mode') || s.gridMode) === 'month';
  if (state.calendars.size === 0) {
    const hint = el('div', 'hint');
    hint.append('No calendars yet. Add some in ');
    const a = el('a', '', 'Settings');
    a.href = 'settings';
    hint.append(a, '.');
    weeks.append(hint);
    weeks.style.setProperty('--weeks', 1);
    return;
  }
  for (let w = 0; w < r.weeks; w++) {
    const row = el('div', 'week');
    for (let d = 0; d < 7; d++) {
      const key = addDays(r.start, w * 7 + d);
      const cell = el('div', 'day');
      const dow = weekday(key);
      if (dow === 0 || dow === 6) cell.classList.add('weekend');
      if (key < r.today) cell.classList.add('past');
      if (key === r.today) cell.classList.add('today');
      if (monthMode && key.slice(0, 7) !== currentMonth) cell.classList.add('other-month');
      const num = el('div', 'num');
      if (dayOfMonth(key) === 1 || (w === 0 && d === 0)) num.append(el('span', 'mon', keyLabel(key, { month: 'short' })));
      num.append(String(dayOfMonth(key)));
      const list = el('div', 'events');
      for (const item of map.get(key) || []) list.append(chip(item, key, d === 0, d === 6));
      cell.append(num, list);
      row.append(cell);
    }
    weeks.append(row);
  }
  requestAnimationFrame(fitCells);
}

function fitCells() {
  for (const list of document.querySelectorAll('.events')) {
    const chips = [...list.querySelectorAll('.ev')];
    if (!chips.length || list.scrollHeight <= list.clientHeight + 1) continue;
    const more = el('div', 'more');
    list.append(more);
    let hidden = 0;
    for (let i = chips.length - 1; i >= 0 && list.scrollHeight > list.clientHeight + 1; i--) {
      chips[i].hidden = true;
      hidden++;
      more.textContent = `+${hidden} more`;
    }
    if (list.scrollHeight > list.clientHeight + 1) more.hidden = true;
  }
}

function renderAgenda(map) {
  const s = state.settings;
  const box = $('agenda');
  box.replaceChildren();
  const now = Date.now();
  let shown = 0;
  for (let i = 0; i < s.agendaDays && shown < s.agendaMax; i++) {
    const key = addDays(state.range.today, i);
    const items = (map.get(key) || []).filter(({ ev }) => ev.allDay || ev.end > now || ev.start > now || i > 0);
    if (i > 0 && items.length === 0) continue;
    const group = el('div', 'day-group');
    const h = el('h2');
    h.append(i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : keyLabel(key, { weekday: 'long' }));
    if (i > 1) h.append(el('span', 'sub', keyLabel(key, { month: 'short', day: 'numeric' })));
    group.append(h);
    if (items.length === 0) {
      group.append(el('div', 'empty', 'Nothing scheduled'));
    } else {
      const ul = el('ul');
      for (const { ev, first } of items) {
        if (shown >= s.agendaMax) break;
        const cal = state.calendars.get(ev.cal);
        const li = el('li');
        const bar = el('span', 'bar');
        bar.style.setProperty('--c', cal.color);
        let when = 'All day';
        if (!ev.allDay) {
          if (first) when = agendaTime(ev.start);
          else when = 'Until ' + agendaTime(ev.end);
          if (ev.start <= now && ev.end > now) li.classList.add('now');
        }
        li.append(bar, el('span', 'when', when), el('span', 'what', ev.title));
        li.title = cal.name;
        ul.append(li);
        shown++;
      }
      group.append(ul);
    }
    box.append(group);
  }
}

function renderStatus() {
  const st = $('status');
  if (state.errors.length) {
    st.hidden = false;
    st.className = 'status warn';
    st.textContent = state.errors.length === 1 ? `${state.errors[0].name}: ${state.errors[0].error}` : `${state.errors.length} calendars failed to load`;
  } else {
    st.hidden = true;
  }
}

function render() {
  if (!state.settings || !state.range) return;
  const map = byDay();
  renderGrid(map);
  renderAgenda(map);
  renderStatus();
}

/* ---------- weather ---------- */

const SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const SUN = '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>';
const MOON = '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>';
const CLOUD_FULL = '<path d="M7 18.5h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.6 4.5 4.5 0 0 0 7 18.5z"/>';
const CLOUD_HIGH = '<path d="M7 15h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 6.1 4.5 4.5 0 0 0 7 15z"/>';
const PARTLY_SUN = '<g class="i-sun"><circle cx="8.5" cy="8.5" r="3"/><path d="M8.5 2.6v1.3M2.6 8.5h1.3M4.3 4.3l.9.9M12.7 4.3l-.9.9M4.3 12.7l.9-.9"/></g>';
const PARTLY_MOON = '<g class="i-moon"><path d="M12 9.2A4.6 4.6 0 1 1 6.3 3.5a3.7 3.7 0 0 0 5.7 5.7z"/></g>';
const PARTLY_CLOUD = '<g class="i-cloud"><path d="M9.5 20.5h8a3.5 3.5 0 0 0 .5-6.96 5 5 0 0 0-9.2-.9 3.8 3.8 0 0 0 .7 7.86z"/></g>';
const RAIN = '<g class="i-rain"><path d="M8.5 18l-1 2.8M12.5 18l-1 2.8M16.5 18l-1 2.8"/></g>';
const DRIZZLE = '<g class="i-rain"><path d="M9 18.5v1.5M13 18.5v1.5M17 18.5v1.5"/></g>';
const SNOW = '<g class="i-snow" stroke-width="2.4"><path d="M8 18.5h.01M12 20.5h.01M16 18.5h.01M10 22h.01M14 22h.01"/></g>';
const BOLT = '<g class="i-bolt"><path d="M12.8 15.5l-2.3 3.6h3.2l-2.3 3.6"/></g>';
const FOG = '<path d="M4 9h16M6 13h12M4 17h16"/>';

function icon(code, isDay = true) {
  const svg = (cls, inner) => `${SVG_OPEN} class="wx ${cls}">${inner}</svg>`;
  const precip = (extra) => svg('', `<g class="i-cloud">${CLOUD_HIGH}</g>${extra}`);
  if (code === 0 || code === 1) return isDay ? svg('sun', SUN) : svg('moon', MOON);
  if (code === 2) return svg('', (isDay ? PARTLY_SUN : PARTLY_MOON) + PARTLY_CLOUD);
  if (code === 3) return svg('', `<g class="i-cloud">${CLOUD_FULL}</g>`);
  if (code === 45 || code === 48) return svg('', FOG);
  if ([51, 53, 55, 56, 57].includes(code)) return precip(DRIZZLE);
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return precip(RAIN);
  if ([71, 73, 75, 77, 85, 86].includes(code)) return precip(SNOW);
  if ([95, 96, 99].includes(code)) return precip(BOLT);
  return svg('', `<g class="i-cloud">${CLOUD_FULL}</g>`);
}

const WMO = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Freezing fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail'
};

async function loadWeather() {
  const s = state.settings;
  if (!s || !s.weather.enabled || params.get('weather') === '0') {
    $('weather').hidden = true;
    return;
  }
  try {
    const w = await getJson('api/weather');
    if (w.disabled) {
      $('weather').hidden = true;
      return;
    }
    state.weather = w;
    renderWeather();
  } catch {
    if (!state.weather) $('weather').hidden = true;
  }
}

function renderWeather() {
  const w = state.weather;
  if (!w || !w.current) return;
  $('weather').hidden = false;
  const r = (v) => (v === null || v === undefined ? '–' : Math.round(v));
  $('wx-icon').innerHTML = icon(w.current.code, w.current.isDay);
  $('wx-temp').textContent = `${r(w.current.temp)}°`;
  $('wx-desc').textContent = WMO[w.current.code] || '';
  const today = w.daily[0];
  const extra = [];
  if (today) extra.push(`H ${r(today.max)}° L ${r(today.min)}°`);
  if (w.current.feels !== undefined) extra.push(`Feels ${r(w.current.feels)}°`);
  $('wx-extra').textContent = extra.join(' · ');
  const list = $('forecast');
  list.replaceChildren();
  w.daily.slice(0, 5).forEach((d, i) => {
    const li = el('li');
    li.append(el('span', 'd', i === 0 ? 'Today' : keyLabel(d.date, { weekday: 'short' })));
    const ic = el('span');
    ic.innerHTML = icon(d.code, true);
    li.append(ic);
    const t = el('span', 't', `${r(d.max)}°`);
    t.append(el('span', 'lo', `${r(d.min)}°`));
    li.append(t);
    li.append(el('span', 'p', d.precip >= 20 ? `${d.precip}%` : ''));
    list.append(li);
  });
}

/* ---------- photos ---------- */

async function loadPhotos() {
  const s = state.settings;
  const enabled = s.photos.enabled && params.get('photo') !== '0';
  if (!enabled) {
    state.photos = [];
    showPhotoSlot(false);
    return;
  }
  try {
    const data = await getJson('api/photos');
    state.photos = data.photos;
    showPhotoSlot(state.photos.length > 0);
    clearInterval(state.timers.photo);
    if (state.photos.length) {
      nextPhoto();
      if (state.photos.length > 1) state.timers.photo = setInterval(nextPhoto, data.intervalSeconds * 1000);
    }
  } catch {
    showPhotoSlot(false);
  }
}

function showPhotoSlot(on) {
  $('photo').hidden = !on;
  $('app').classList.toggle('has-photo', on);
}

function nextPhoto() {
  const a = $('photo-a');
  const b = $('photo-b');
  const [front, back] = a.classList.contains('show') ? [a, b] : [b, a];
  const src = state.photos[state.photoIndex % state.photos.length];
  state.photoIndex++;
  back.onload = () => {
    back.classList.add('show');
    front.classList.remove('show');
  };
  back.src = src;
}

/* ---------- boot ---------- */

async function loadDisplay() {
  const data = await getJson('api/display');
  const changed = data.version !== state.version;
  state.version = data.version;
  state.settings = data.settings;
  state.calendars = new Map(data.calendars.map((c) => [c.id, c]));
  const title = $('title');
  title.textContent = data.settings.title;
  title.hidden = !data.settings.title;
  return changed;
}

function schedule() {
  const s = state.settings;
  clearInterval(state.timers.events);
  state.timers.events = setInterval(loadEvents, s.refreshMinutes * 60000);
}

async function refreshDisplay(first = false) {
  try {
    const changed = await loadDisplay();
    if (!changed && !first) return;
    fmtCache.clear();
    utcFmtCache.clear();
    applyLayout();
    state.todayKey = keyOf(Date.now());
    tickClock();
    schedule();
    await Promise.all([loadEvents(), loadWeather(), loadPhotos()]);
  } catch (err) {
    const st = $('status');
    st.hidden = false;
    st.className = 'status warn';
    st.textContent = `Can't reach Kalends: ${err.message}`;
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.settings) return;
    applyLayout();
    render();
  }, 150);
});

await refreshDisplay(true);
setInterval(tickClock, 1000);
setInterval(() => refreshDisplay(false), 60000);
setInterval(loadWeather, 15 * 60000);
setTimeout(() => location.reload(), 24 * 3600 * 1000 + Math.random() * 600000);
