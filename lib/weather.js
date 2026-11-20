const TTL_MS = 15 * 60 * 1000;
let cache = { key: '', at: 0, data: null, error: null };

export async function getWeather(w, timezone) {
  const key = [w.latitude, w.longitude, w.units, timezone].join('|');
  const now = Date.now();
  if (cache.key === key && cache.data && now - cache.at < TTL_MS) return cache.data;
  if (cache.key === key && cache.error && now - cache.at < 60000) throw new Error(cache.error);
  const imperial = w.units === 'imperial';
  const params = new URLSearchParams({
    latitude: String(w.latitude),
    longitude: String(w.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,relative_humidity_2m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    timezone,
    forecast_days: '6',
    temperature_unit: imperial ? 'fahrenheit' : 'celsius',
    wind_speed_unit: imperial ? 'mph' : 'kmh',
    precipitation_unit: imperial ? 'inch' : 'mm'
  });
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const j = await res.json();
    const data = {
      units: { temp: imperial ? '°F' : '°C', wind: imperial ? 'mph' : 'km/h' },
      current: {
        temp: j.current?.temperature_2m,
        feels: j.current?.apparent_temperature,
        code: j.current?.weather_code,
        isDay: j.current?.is_day === 1,
        wind: j.current?.wind_speed_10m,
        humidity: j.current?.relative_humidity_2m
      },
      daily: (j.daily?.time || []).map((date, i) => ({
        date,
        code: j.daily.weather_code?.[i],
        max: j.daily.temperature_2m_max?.[i],
        min: j.daily.temperature_2m_min?.[i],
        precip: j.daily.precipitation_probability_max?.[i]
      })),
      fetchedAt: now
    };
    cache = { key, at: now, data, error: null };
    return data;
  } catch (err) {
    const message = err?.name === 'TimeoutError' ? 'Open-Meteo timed out' : String(err?.message || err);
    if (cache.key === key && cache.data) return cache.data;
    cache = { key, at: now, data: null, error: message };
    throw new Error(message);
  }
}

export async function geocode(query) {
  const params = new URLSearchParams({ name: query, count: '8', language: 'en', format: 'json' });
  const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Geocoding HTTP ${res.status}`);
  const j = await res.json();
  return (j.results || []).map((r) => ({
    name: [r.name, r.admin1, r.country_code].filter(Boolean).join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone
  }));
}
