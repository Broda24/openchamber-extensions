import assert from 'node:assert/strict';
import test from 'node:test';
import { calendar as c } from './load-panel.mjs';

const BERLIN = 'Europe/Berlin';
const NEW_YORK = 'America/New_York';
const now = new Date('2026-11-13T10:00:00Z');
const timed = (fields) => c.draftEvent({ title: 'Termin', description: '', location: '', allDay: false, endDate: '', timeZone: BERLIN, ...fields }, undefined, now);
const importOptions = { timeZone: BERLIN, today: '2026-11-13', windowStart: '2025-11-13', windowEnd: '2029-11-12' };
const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//test//EN', ...lines, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const ranges = (result) => result.events.map((event) => event.allDay ? [event.startDate, event.endDateExclusive] : [event.startsAt, event.endsAt]);

test('form fields of a multi-day timed event round-trip with their end date', () => {
  const event = timed({ date: '2026-11-20', startTime: '18:00', endTime: '12:00', timedEndDate: '2026-11-22' });
  const fields = c.eventFormFields(event);
  assert.equal(fields.endDate, '2026-11-22');
  const saved = c.draftEvent({ title: 'Umbenannt', description: '', location: '', allDay: false, ...fields, timedEndDate: fields.endDate, timeZone: BERLIN }, event, now);
  assert.deepEqual([saved.startsAt, saved.endsAt], ['2026-11-20T18:00:00+01:00', '2026-11-22T12:00:00+01:00']);
});

test('an event ending exactly at midnight is drawn up to the end of its day', () => {
  const party = timed({ date: '2026-11-21', startTime: '20:00', endTime: '00:00' });
  assert.equal(party.endsAt, '2026-11-22T00:00:00+01:00');
  assert.deepEqual(c.timedSegment(party, '2026-11-21', BERLIN), { event: party, startMin: 1200, endMin: 1440 });
  assert.equal(c.timedSegment(party, '2026-11-22', BERLIN), null);
  const night = timed({ date: '2026-11-21', startTime: '22:00', endTime: '00:00', timedEndDate: '2026-11-23' });
  assert.deepEqual(c.timedSegment(night, '2026-11-22', BERLIN), { event: night, startMin: 0, endMin: 1440 });
});

test('views place timed events on the day of the display time zone', () => {
  // Monday 01:00 in Berlin is Sunday 19:00 in New York.
  const early = timed({ date: '2026-11-23', startTime: '01:00', endTime: '02:00' });
  const week = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
  const filtered = c.filterEvents([early], { fromDay: week[0], toDayExclusive: '2026-11-23', zone: NEW_YORK });
  assert.deepEqual(week.filter((day) => filtered.some((event) => c.timedSegment(event, day, NEW_YORK))), ['2026-11-22']);
  assert.equal(c.eventsOnDay([early], '2026-11-22', NEW_YORK).length, 1);
  assert.equal(c.eventsOnDay([early], '2026-11-23', NEW_YORK).length, 0);
  assert.equal(c.formatTimeRange(early, NEW_YORK), '19:00–20:00');
  assert.match(c.listAnswer([early], '2026-11-22', '2026-11-22', '2026-11-13', null, NEW_YORK).text, /19:00–20:00 · Termin/);
  const intent = c.parseIntent('{"action":"delete","matchTitle":"Termin","matchDate":"2026-11-22"}');
  assert.equal(c.resolveDelete(intent, [early], NEW_YORK).kind, 'ok');
  // Without a display zone the stored event's own zone still applies.
  assert.equal(c.eventsOnDay([early], '2026-11-23').length, 1);
});

test('one timed import event longer than seven days is skipped with a warning instead of failing the import', async () => {
  const result = c.parseIcs(ics(
    ...vevent('UID:ok', 'SUMMARY:Normal', 'DTSTART;TZID=Europe/Berlin:20261201T100000', 'DTEND;TZID=Europe/Berlin:20261201T110000'),
    ...vevent('UID:long', 'SUMMARY:Messe', 'DTSTART;TZID=Europe/Berlin:20261202T090000', 'DTEND;TZID=Europe/Berlin:20261212T180000'),
  ), importOptions);
  assert.deepEqual(result.events.map((event) => event.title), ['Normal']);
  assert.ok(result.warnings.some((warning) => warning.includes('„Messe“')));
  const data = new Map();
  const storage = { get: async (k) => data.get(k), set: async (k, v) => { data.set(k, v); }, delete: async (k) => { data.delete(k); }, keys: async () => [...data.keys()] };
  const repository = c.createCalendarStorage(storage);
  await repository.load();
  await repository.saveExternal(result.events, { fileName: 'posteo.ics', importedAt: now.toISOString(), note: '', settings: { timeZone: BERLIN } });
  assert.equal([...data.keys()].filter((key) => key.startsWith('ext:event:')).length, 1);
});

test('all-day events honour DURATION', () => {
  const result = c.parseIcs(ics(...vevent('UID:a', 'SUMMARY:Urlaub', 'DTSTART;VALUE=DATE:20261201', 'DURATION:P3D')), importOptions);
  assert.deepEqual(ranges(result), [['2026-12-01', '2026-12-04']]);
});

test('EXDATE and RECURRENCE-ID in UTC match a series in another time zone', () => {
  const series = ['DTSTART;TZID=Europe/Berlin:20261201T100000', 'DTEND;TZID=Europe/Berlin:20261201T110000', 'RRULE:FREQ=DAILY;COUNT=3'];
  const excluded = c.parseIcs(ics(...vevent('UID:b', 'SUMMARY:Daily', ...series, 'EXDATE:20261202T090000Z')), importOptions);
  assert.deepEqual(excluded.events.map((event) => event.startsAt), ['2026-12-01T10:00:00+01:00', '2026-12-03T10:00:00+01:00']);
  const moved = c.parseIcs(ics(
    ...vevent('UID:c', 'SUMMARY:Serie', ...series),
    ...vevent('UID:c', 'SUMMARY:Verschoben', 'RECURRENCE-ID:20261202T090000Z', 'DTSTART;TZID=Europe/Berlin:20261202T150000', 'DTEND;TZID=Europe/Berlin:20261202T160000'),
  ), importOptions);
  assert.deepEqual(moved.events.map((event) => [event.title, event.startsAt]), [
    ['Serie', '2026-12-01T10:00:00+01:00'], ['Verschoben', '2026-12-02T15:00:00+01:00'], ['Serie', '2026-12-03T10:00:00+01:00']]);
  assert.deepEqual(moved.warnings, []);
});

test('DTEND is read in its own time zone', () => {
  const utcEnd = c.parseIcs(ics(...vevent('UID:d', 'SUMMARY:Mixed', 'DTSTART;TZID=Europe/Berlin:20261201T100000', 'DTEND:20261201T120000Z')), importOptions);
  assert.deepEqual(ranges(utcEnd), [['2026-12-01T10:00:00+01:00', '2026-12-01T13:00:00+01:00']]);
  const zonedEnd = c.parseIcs(ics(...vevent('UID:e', 'SUMMARY:Flug', 'DTSTART:20261201T090000Z', 'DTEND;TZID=America/New_York:20261201T080000')), importOptions);
  assert.deepEqual(ranges(zonedEnd), [['2026-12-01T10:00:00+01:00', '2026-12-01T14:00:00+01:00']]);
});

test('VALARM properties do not leak into the event', () => {
  const result = c.parseIcs(ics(...vevent('UID:f', 'SUMMARY:Arzt', 'DTSTART;TZID=Europe/Berlin:20261201T100000', 'DTEND;TZID=Europe/Berlin:20261201T110000',
    'BEGIN:VALARM', 'ACTION:EMAIL', 'SUMMARY:Alarm', 'DESCRIPTION:This is an event reminder', 'TRIGGER:-PT30M', 'END:VALARM')), importOptions);
  assert.deepEqual(result.events.map((event) => [event.title, event.description]), [['Arzt', '']]);
});

test('series ending by COUNT or UNTIL are not reported as truncated', () => {
  const counted = c.parseIcs(ics(...vevent('UID:g', 'SUMMARY:Kurz', 'DTSTART;TZID=Europe/Berlin:20261201T100000', 'RRULE:FREQ=DAILY;COUNT=3')), importOptions);
  assert.equal(counted.events.length, 3); assert.deepEqual(counted.warnings, []); assert.equal(counted.stats.truncated, 0);
  const until = c.parseIcs(ics(...vevent('UID:h', 'SUMMARY:Bis', 'DTSTART;TZID=Europe/Berlin:20240101T100000', 'RRULE:FREQ=DAILY;UNTIL=20261215T090000Z')), importOptions);
  assert.equal(until.events.at(-1).startsAt, '2026-12-15T10:00:00+01:00'); assert.deepEqual(until.warnings, []);
  const endless = c.parseIcs(ics(...vevent('UID:i', 'SUMMARY:Immer', 'DTSTART;TZID=Europe/Berlin:20261201T100000', 'RRULE:FREQ=DAILY')), importOptions);
  assert.equal(endless.stats.truncated, 1, 'a genuinely capped series still warns');
});

test('BYMONTHDAY and monthly BYDAY occurrences are counted in date order', () => {
  const byMonthDay = c.parseIcs(ics(...vevent('UID:j', 'SUMMARY:M', 'DTSTART;VALUE=DATE:20261205', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=20,5;COUNT=3')), importOptions);
  assert.deepEqual(byMonthDay.events.map((event) => event.startDate), ['2026-12-05', '2026-12-20', '2027-01-05']);
  const byDay = c.parseIcs(ics(...vevent('UID:k', 'SUMMARY:B', 'DTSTART;VALUE=DATE:20261207', 'RRULE:FREQ=MONTHLY;BYDAY=3MO,1MO;COUNT=3')), importOptions);
  assert.deepEqual(byDay.events.map((event) => event.startDate), ['2026-12-07', '2026-12-21', '2027-01-04']);
});

test('YEARLY with BYMONTH of the start month recurs; another month stays unsupported with a truthful warning', () => {
  const birthday = c.parseIcs(ics(...vevent('UID:l', 'SUMMARY:Geburtstag', 'DTSTART;VALUE=DATE:20200512', 'RRULE:FREQ=YEARLY;BYMONTH=5;BYMONTHDAY=12')), importOptions);
  assert.deepEqual(birthday.events.map((event) => event.startDate), ['2026-05-12', '2027-05-12', '2028-05-12', '2029-05-12']);
  assert.deepEqual(birthday.warnings, []);
  const other = c.parseIcs(ics(...vevent('UID:m', 'SUMMARY:Anders', 'DTSTART;VALUE=DATE:20200512', 'RRULE:FREQ=YEARLY;BYMONTH=6')), importOptions);
  assert.equal(other.events.length, 0);
  assert.match(other.warnings[0], /BYMONTH.*nichts wurde übernommen/);
});
