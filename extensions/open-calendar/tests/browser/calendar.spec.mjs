import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { guestFramePolicy } from '@openchamber/sdk';
import { calendar } from '../load-panel.mjs';

let server;
let origin;
const root = new URL('../../', import.meta.url);
const files = new Map([
  ['/', ['tests/browser/host.html', 'text/html']],
  ['/panel/index.html', ['panel/index.html', 'text/html']],
  ['/panel/main.js', ['panel/main.js', 'text/javascript']],
  ['/panel/styles.css', ['panel/styles.css', 'text/css']],
]);

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://test.invalid').pathname;
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    const file = files.get(pathname);
    if (!file) { response.writeHead(404).end(); return; }
    try {
      const headers = { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' };
      if (pathname !== '/') {
        headers['Content-Security-Policy'] = guestFramePolicy(origin);
        headers['Access-Control-Allow-Origin'] = 'null';
      }
      response.writeHead(200, headers).end(await readFile(fileURLToPath(new URL(file[0], root))));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

test.beforeEach(async ({ page }) => {
  page.__errors = [];
  page.on('pageerror', (error) => page.__errors.push(error.message));
});
test.afterEach(async ({ page }) => { expect(page.__errors).toEqual([]); });

const ZONE = 'Europe/Berlin';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
const settings = { timeZone: ZONE, aiNoticeAccepted: true, aiNoticeVersion: 2, posteoEnabled: false, posteoFileName: '',
  posteoImportedAt: null, posteoCount: 0, posteoNote: '', weekStartsOn: 1 };
const timed = (fields) => calendar.draftEvent({ description: '', location: '', allDay: false, endDate: '', timeZone: ZONE, ...fields });

async function openCalendar(page, events) {
  await page.goto(origin);
  await page.evaluate(({ settings, events }) => {
    testHost.entries.set('settings:v1', settings);
    for (const event of events) testHost.entries.set(`event:${event.id}`, event);
    testHost.reloadFrame();
  }, { settings, events });
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'OpenCalendar', exact: true })).toBeVisible();
  return frame;
}
const stored = (page, id) => page.evaluate((id) => testHost.entries.get(`event:${id}`), id);

test('the form shows the end date of a timed event and keeps it when saving', async ({ page }) => {
  const event = timed({ title: 'Wochenende', date: today, startTime: '18:00', endTime: '12:00', timedEndDate: calendar.addDays(today, 2) });
  const frame = await openCalendar(page, [event]);
  await frame.locator(`[data-action="open-event"][data-id="${event.id}"]`).first().click();
  const dialog = frame.getByRole('dialog');
  await expect(dialog.getByLabel('Endet am', { exact: true })).toHaveValue(calendar.addDays(today, 2));
  await dialog.getByLabel('Titel *').fill('Wochenende umbenannt');
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(frame.getByRole('dialog')).toHaveCount(0);
  expect(await stored(page, event.id)).toMatchObject({ title: 'Wochenende umbenannt', startsAt: event.startsAt, endsAt: event.endsAt });

  await frame.locator(`[data-action="open-event"][data-id="${event.id}"]`).first().click();
  await dialog.getByLabel('Endet am', { exact: true }).fill(calendar.addDays(today, 1));
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(frame.getByRole('dialog')).toHaveCount(0);
  const changed = await stored(page, event.id);
  expect(calendar.eventFormFields(changed)).toMatchObject({ date: today, endDate: calendar.addDays(today, 1), startTime: '18:00', endTime: '12:00' });
});

test('a same-day overnight end still rolls over and moving the start date carries the end date along', async ({ page }) => {
  const frame = await openCalendar(page, []);
  await frame.locator('[data-action="add"]').click();
  const dialog = frame.getByRole('dialog');
  await dialog.getByLabel('Titel *').fill('Nachtschicht');
  await dialog.getByLabel('Datum', { exact: true }).fill(calendar.addDays(today, 3));
  await expect(dialog.getByLabel('Endet am', { exact: true })).toHaveValue(calendar.addDays(today, 3));
  await dialog.getByLabel('Start', { exact: true }).fill('22:00');
  await dialog.getByLabel('Ende', { exact: true }).fill('06:00');
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(frame.getByRole('dialog')).toHaveCount(0);
  const saved = await page.evaluate(() => [...testHost.entries].find(([key]) => key.startsWith('event:'))[1]);
  expect(calendar.eventFormFields(saved)).toMatchObject({ date: calendar.addDays(today, 3), endDate: calendar.addDays(today, 4), startTime: '22:00', endTime: '06:00' });
});

test('confirming an AI change of an event deleted after the preview does not bring it back', async ({ page }) => {
  const event = timed({ title: 'Zahnarzt', date: today, startTime: '10:00', endTime: '11:00' });
  const frame = await openCalendar(page, [event]);
  await page.evaluate((id) => testHost.answers.push(JSON.stringify({ action: 'update', eventId: id, changes: { title: 'Zahnarzt Kontrolle' } })), event.id);
  await frame.getByLabel('Nachricht an die KI').fill('Benenne den Zahnarzt um');
  await frame.locator('[data-action="ai-send"]').click();
  await expect(frame.locator('.preview[data-kind="update"]')).toBeVisible();

  await frame.locator(`.calendar-pane [data-action="open-event"][data-id="${event.id}"]`).first().click();
  await frame.getByRole('dialog').getByRole('button', { name: 'Löschen', exact: true }).click();
  await frame.getByRole('dialog').getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(frame.getByRole('dialog')).toHaveCount(0);
  expect(await stored(page, event.id)).toBeUndefined();

  await frame.locator('[data-action="ai-confirm"]').click();
  await expect(frame.locator('.chat__log')).toContainText('inzwischen geändert oder gelöscht');
  expect(await stored(page, event.id)).toBeUndefined();
  await expect(frame.locator('.preview')).toHaveCount(0);
});

test('confirming an unchanged AI change still saves it', async ({ page }) => {
  const event = timed({ title: 'Zahnarzt', date: today, startTime: '10:00', endTime: '11:00' });
  const frame = await openCalendar(page, [event]);
  await page.evaluate((id) => testHost.answers.push(JSON.stringify({ action: 'update', eventId: id, changes: { title: 'Zahnarzt Kontrolle' } })), event.id);
  await frame.getByLabel('Nachricht an die KI').fill('Benenne den Zahnarzt um');
  await frame.locator('[data-action="ai-send"]').click();
  await frame.locator('[data-action="ai-confirm"]').click();
  await expect(frame.locator('.chat__log')).toContainText('wurde geändert');
  expect(await stored(page, event.id)).toMatchObject({ title: 'Zahnarzt Kontrolle', startsAt: event.startsAt, endsAt: event.endsAt });
});
