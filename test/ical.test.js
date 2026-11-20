import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, expand, zonedToUtc, dateKey } from '../lib/ical.js';

const TZ = 'America/New_York';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Kalends//Test//EN
X-WR-CALNAME:Test calendar
BEGIN:VTIMEZONE
TZID:Eastern Standard Time
BEGIN:STANDARD
DTSTART:16011104T020000
RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010311T020000
RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly@test
SUMMARY:Soccer practice
DTSTART;TZID=America/New_York:20261005T180000
DTEND;TZID=America/New_York:20261005T193000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=12
EXDATE;TZID=America/New_York:20261116T180000
END:VEVENT
BEGIN:VEVENT
UID:weekly@test
RECURRENCE-ID;TZID=America/New_York:20261109T180000
SUMMARY:Soccer practice (moved)
DTSTART;TZID=America/New_York:20261110T170000
DTEND;TZID=America/New_York:20261110T180000
END:VEVENT
BEGIN:VEVENT
UID:windows-tz@test
SUMMARY:Outlook meeting
DTSTART;TZID=Eastern Standard Time:20261118T090000
DTEND;TZID=Eastern Standard Time:20261118T100000
END:VEVENT
BEGIN:VEVENT
UID:trip@test
SUMMARY:Beach trip
DTSTART;VALUE=DATE:20261126
DTEND;VALUE=DATE:20261129
END:VEVENT
BEGIN:VEVENT
UID:utc@test
SUMMARY:Show S01E01
DTSTART:20261121T020000Z
DTEND:20261121T030000Z
END:VEVENT
BEGIN:VEVENT
UID:floating@test
SUMMARY:Floating lunch
DTSTART:20261119T120000
DTEND:20261119T130000
END:VEVENT
BEGIN:VEVENT
UID:cancelled@test
SUMMARY:Cancelled thing
STATUS:CANCELLED
DTSTART:20261119T150000Z
END:VEVENT
BEGIN:VEVENT
UID:daily-allday@test
SUMMARY:Bin day
DTSTART;VALUE=DATE:20200101
RRULE:FREQ=WEEKLY;BYDAY=TH
END:VEVENT
END:VCALENDAR`;

const parsed = parseIcs(ICS);
const events = expand(parsed, 'c1', '2026-11-01', '2026-12-06', TZ);
const titled = (t) => events.filter((e) => e.title === t);

test('zonedToUtc handles DST', () => {
  assert.equal(new Date(zonedToUtc(2026, 7, 4, 9, 0, 0, TZ)).toISOString(), '2026-07-04T13:00:00.000Z');
  assert.equal(new Date(zonedToUtc(2026, 12, 4, 9, 0, 0, TZ)).toISOString(), '2026-12-04T14:00:00.000Z');
});

test('weekly recurrence with EXDATE and moved exception', () => {
  const weekly = titled('Soccer practice').map((e) => dateKey(e.start, TZ));
  assert.deepEqual(weekly, ['2026-11-02', '2026-11-23', '2026-11-30']);
  const moved = titled('Soccer practice (moved)');
  assert.equal(moved.length, 1);
  assert.equal(new Date(moved[0].start).toISOString(), '2026-11-10T22:00:00.000Z');
});

test('Windows timezone names resolve through VTIMEZONE', () => {
  const [e] = titled('Outlook meeting');
  assert.equal(new Date(e.start).toISOString(), '2026-11-18T14:00:00.000Z');
});

test('all-day multi-day keeps exclusive end date', () => {
  const [e] = titled('Beach trip');
  assert.deepEqual([e.allDay, e.start, e.end], [true, '2026-11-26', '2026-11-29']);
});

test('UTC and floating times', () => {
  assert.equal(new Date(titled('Show S01E01')[0].start).toISOString(), '2026-11-21T02:00:00.000Z');
  assert.equal(dateKey(titled('Show S01E01')[0].start, TZ), '2026-11-20');
  assert.equal(new Date(titled('Floating lunch')[0].start).toISOString(), '2026-11-19T17:00:00.000Z');
});

test('cancelled events are dropped, long-running all-day recurrence expands', () => {
  assert.equal(titled('Cancelled thing').length, 0);
  assert.deepEqual(titled('Bin day').map((e) => e.start), ['2026-11-05', '2026-11-12', '2026-11-19', '2026-11-26', '2026-12-03']);
  assert.equal(parsed.name, 'Test calendar');
});
