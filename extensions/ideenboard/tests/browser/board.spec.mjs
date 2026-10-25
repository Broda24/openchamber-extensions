import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guestFramePolicy } from '@openchamber/sdk';

let server;
let origin;
const root = new URL('../../', import.meta.url);
const assetRoot = process.env.BOARD_PACKAGE_ROOT
  ? pathToFileURL(`${process.env.BOARD_PACKAGE_ROOT}/`) : root;
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
      const content = await readFile(fileURLToPath(new URL(file[0], pathname === '/' ? root : assetRoot)));
      response.writeHead(200, headers).end(content);
    } catch { response.writeHead(500).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

test.beforeEach(async ({ page }) => {
  page.__boardErrors = [];
  page.on('pageerror', (error) => page.__boardErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') page.__boardErrors.push(message.text()); });
});
test.afterEach(async ({ page }) => {
  // Includes uncaught exceptions and genuine sandbox/CSP errors, even on a failed test.
  expect(page.__boardErrors).toEqual([]);
});

const card = (frame, title) => frame.locator('.task-card').filter({ has: frame.getByRole('heading', { name: title, exact: true }) });
const column = (frame, status) => frame.locator(`[data-drop-status="${status}"]`);
const action = (frame, name) => frame.locator(`[data-action="${name}"]`);
const saved = (frame) => expect(frame.locator('[data-save-state]')).toHaveText('Gespeichert');
const titles = (frame) => frame.locator('.task-card h3');
const requests = (page, type) => page.evaluate((type) => testHost.requests.filter((request) => request.type === type), type);
const v1Card = (id, overrides = {}) => ({ id, title: `Idee ${id}`, notes: '', status: 'ideas', createdAt: 1, updatedAt: 1, ...overrides });
const v2Card = (id, overrides = {}) => ({ ...v1Card(id), boardId: 'default', labels: [], priority: 'normal', dueDate: null,
  checklist: [], links: [], attachments: [], sessionLinks: [], archivedAt: null, deletedAt: null, ...overrides });
const documentV2 = (cards, boards = [{ id: 'default', name: 'Mein Board', focusId: null }]) => ({ schemaVersion: 2, boards, cards });
const boards = [{ id: 'default', name: 'Mein Board', focusId: null }, { id: 'other', name: 'Anderes Board', focusId: null }];

async function openBoard(page) {
  await page.goto(origin);
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Ideenboard', exact: true })).toBeVisible();
  return frame;
}
async function reloadFrame(page) {
  // Replace only the guest; Map-backed host storage survives, unlike page.reload().
  await page.evaluate(() => testHost.reloadFrame());
}
async function seedBoard(page, board) {
  await page.evaluate((value) => { testHost.resetStorage(); testHost.values['ideenboard-v1'] = value; }, board);
  await reloadFrame(page);
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'Ideenboard', exact: true })).toBeVisible();
}
async function editDraft(frame, values = {}) {
  const dialog = frame.getByRole('dialog');
  const fields = { title: 'title', notes: 'notes', labels: 'labels', checklist: 'checklist', links: 'links', dueDate: 'dueDate' };
  for (const [key, name] of Object.entries(fields)) if (values[key] !== undefined) await dialog.locator(`[name="${name}"]`).fill(values[key]);
  for (const name of ['priority', 'status', 'card-board']) if (values[name] !== undefined) await dialog.locator(`[name="${name}"]`).selectOption(values[name]);
  if (values.focus) await dialog.locator('[name="focus"]').check();
  return dialog;
}
async function createCard(frame, title, values = {}) {
  await action(frame, 'add').first().click();
  const dialog = await editDraft(frame, { title, ...values });
  await dialog.getByRole('button', { name: 'Idee hinzufügen', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card(frame, title)).toBeVisible();
}
async function exportBackup(page, frame) {
  await action(frame, 'backup-copy').first().click();
  await expect(frame.locator('.banner')).toContainText('Backup kopiert');
  return page.evaluate(() => testHost.clipboard);
}
async function importBackup(frame, backup) {
  await action(frame, 'import-open').click();
  await frame.getByRole('dialog').getByLabel('Backup-Inhalt').fill(backup);
  await action(frame, 'validate-import').click();
  const confirmation = frame.getByRole('dialog', { name: 'Alle Boards ersetzen?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Backup wiederherstellen', exact: true }).click();
  await expect(frame.getByRole('dialog')).toHaveCount(0);
  await saved(frame);
}
async function openChat(frame, title) {
  await card(frame, title).getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(frame.getByRole('dialog').getByRole('option', { name: 'Testprojekt', exact: true })).toHaveCount(1);
  await expect(action(frame, 'start-session')).toHaveText('Arbeitssitzung starten');
  return frame.getByRole('dialog');
}

test('native opaque sandbox: required title, Enter create, edit, focus, persistence and XSS', async ({ page }) => {
  const frame = await openBoard(page);
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await frame.locator('body').evaluate(() => {
    try { void parent.document.body; return false; } catch (error) { return error.name === 'SecurityError'; }
  })).toBe(true);
  await action(frame, 'add').first().click();
  let dialog = frame.getByRole('dialog');
  await action(frame, 'save-card').click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => testHost.writes)).toBe(0);
  const title = '<img src=x onerror=alert(1)>';
  await dialog.getByLabel('Titel', { exact: true }).fill(title);
  await dialog.getByLabel('Titel', { exact: true }).press('Enter');
  await expect(titles(frame)).toHaveText(title);
  await expect(frame.locator('.task-card img')).toHaveCount(0);
  await card(frame, title).getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  dialog = await editDraft(frame, { title: 'Überarbeitet', notes: 'Zeile 1\nZeile 2', focus: true });
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(frame.locator('.focus-card h3')).toHaveText('Überarbeitet');
  await saved(frame);
  await reloadFrame(page);
  await expect(column(frame, 'in-progress').locator('h3')).toHaveText('Überarbeitet');
  await expect(frame.locator('.task-card__notes')).toHaveText('Zeile 1\nZeile 2');
  const entries = await page.evaluate(() => [...testHost.entries]);
  expect(entries.length).toBeGreaterThan(1);
  expect(entries.every(([, value]) => Buffer.byteLength(JSON.stringify(value)) <= 65536)).toBe(true);
});

test('real mouse drag changes columns and reorders within a column, then persists', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  const frame = await openBoard(page);
  await seedBoard(page, documentV2([v2Card('a', { title: 'Alpha' }), v2Card('b', { title: 'Beta' }), v2Card('c', { title: 'Gamma' })]));
  await card(frame, 'Beta').dragTo(column(frame, 'next').locator('.column-empty'));
  await expect(column(frame, 'next').locator('h3')).toHaveText('Beta');
  await card(frame, 'Gamma').dragTo(card(frame, 'Alpha'), { targetPosition: { x: 30, y: 15 } });
  await expect(column(frame, 'ideas').locator('h3')).toHaveText(['Gamma', 'Alpha']);
  await saved(frame);
  await reloadFrame(page);
  await expect(column(frame, 'ideas').locator('h3')).toHaveText(['Gamma', 'Alpha']);
  await expect(column(frame, 'next').locator('h3')).toHaveText('Beta');
});

test('keyboard-accessible up/down controls reorder cards without changing columns', async ({ page }) => {
  const frame = await openBoard(page);
  await seedBoard(page, documentV2([v2Card('a'), v2Card('b'), v2Card('c')]));
  const up = card(frame, 'Idee c').getByRole('button', { name: '↑ Nach oben', exact: true });
  await up.focus(); await up.press('Enter');
  await expect(titles(frame)).toHaveText(['Idee a', 'Idee c', 'Idee b']);
  const down = card(frame, 'Idee a').getByRole('button', { name: '↓ Nach unten', exact: true });
  await down.focus(); await down.press('Space');
  await expect(titles(frame)).toHaveText(['Idee c', 'Idee a', 'Idee b']);
  await saved(frame);
  await reloadFrame(page);
  await expect(titles(frame)).toHaveText(['Idee c', 'Idee a', 'Idee b']);
});

test('search and label/priority/status/due filters combine, reset, and checklist toggles persist', async ({ page }) => {
  const frame = await openBoard(page);
  await createCard(frame, 'Website', { notes: 'Entwurf finden', labels: 'Privat, Web', priority: 'high', dueDate: '2000-01-01', checklist: '[ ] Entwurf prüfen\n[x] Notiert' });
  await createCard(frame, 'Andere Idee', { labels: 'Privat', priority: 'low', dueDate: '2099-12-31' });
  await frame.getByLabel('Karten durchsuchen').fill('Entwurf');
  await frame.getByLabel('Label filtern', { exact: true }).selectOption('Web');
  await frame.getByLabel('Priorität filtern', { exact: true }).selectOption('high');
  await frame.getByLabel('Status filtern', { exact: true }).selectOption('ideas');
  await frame.getByLabel('Fälligkeit filtern', { exact: true }).selectOption('overdue');
  await expect(titles(frame)).toHaveText('Website');
  await card(frame, 'Website').getByLabel('Entwurf prüfen', { exact: true }).check();
  await expect(card(frame, 'Website').locator('.card-checklist')).toContainText('Schritte 2/2');
  await frame.getByLabel('Priorität filtern', { exact: true }).selectOption('urgent');
  await expect(titles(frame)).toHaveCount(0);
  await action(frame, 'reset-filters').click();
  await expect(titles(frame)).toHaveCount(2);
  await saved(frame);
  await reloadFrame(page);
  await expect(card(frame, 'Website').getByLabel('Entwurf prüfen', { exact: true })).toBeChecked();
  await expect(card(frame, 'Website').locator('.due')).toContainText('Überfällig');
});

test('archive removes focus; restoring from archive keeps the card and its data', async ({ page }) => {
  const frame = await openBoard(page);
  await createCard(frame, 'Archivieren', { focus: true, notes: 'Bleibt erhalten' });
  await card(frame, 'Archivieren').getByRole('button', { name: 'Archivieren', exact: true }).click();
  await expect(titles(frame)).toHaveCount(0);
  await expect(frame.locator('.focus-empty')).toBeVisible();
  await frame.locator('[data-view="archive"]').click();
  await expect(titles(frame)).toHaveText('Archivieren');
  await card(frame, 'Archivieren').getByRole('button', { name: 'Aus Archiv holen', exact: true }).click();
  await expect(titles(frame)).toHaveCount(0);
  await frame.locator('[data-view="active"]').click();
  await expect(card(frame, 'Archivieren')).toContainText('Bleibt erhalten');
  await saved(frame);
});

test('delete does nothing before confirmation or after cancel; trash restore and undo work', async ({ page }) => {
  const frame = await openBoard(page);
  await createCard(frame, 'Behalten'); await saved(frame);
  const before = await page.evaluate(() => [...testHost.entries]);
  await card(frame, 'Behalten').getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect(frame.getByRole('dialog', { name: 'Karte löschen?' })).toBeVisible();
  expect(await page.evaluate(() => [...testHost.entries])).toEqual(before);
  await action(frame, 'cancel-confirmation').click();
  await expect(titles(frame)).toHaveText('Behalten');
  await card(frame, 'Behalten').getByRole('button', { name: 'Löschen', exact: true }).click();
  await action(frame, 'confirm').click();
  await expect(titles(frame)).toHaveCount(0);
  await action(frame, 'undo').click();
  await expect(titles(frame)).toHaveText('Behalten');
  await card(frame, 'Behalten').getByRole('button', { name: 'Löschen', exact: true }).click();
  await action(frame, 'confirm').click();
  await frame.locator('[data-view="trash"]').click();
  await card(frame, 'Behalten').getByRole('button', { name: 'Wiederherstellen', exact: true }).click();
  await frame.locator('[data-view="active"]').click();
  await expect(titles(frame)).toHaveText('Behalten');
  await saved(frame);
});

test('create/rename/switch boards and move a card to a different board', async ({ page }) => {
  const frame = await openBoard(page);
  await createCard(frame, 'Umziehen', { focus: true });
  await action(frame, 'create-board').click();
  await frame.getByRole('dialog').getByLabel('Boardname', { exact: true }).fill('Zweites Board');
  await frame.getByRole('dialog').getByLabel('Boardname', { exact: true }).press('Enter');
  await expect(titles(frame)).toHaveCount(0);
  await action(frame, 'rename-board').click();
  await frame.getByRole('dialog').getByLabel('Boardname', { exact: true }).fill('Projektboard');
  await action(frame, 'save-board').click();
  await frame.getByLabel('Aktuelles Board', { exact: true }).selectOption({ label: 'Mein Board' });
  await card(frame, 'Umziehen').getByRole('button', { name: 'Bearbeiten', exact: true }).click();
  await frame.getByRole('dialog').getByLabel('Board der Karte', { exact: true }).selectOption({ label: 'Projektboard' });
  await frame.getByRole('dialog').getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(frame.getByLabel('Aktuelles Board', { exact: true }).locator('option:checked')).toHaveText('Projektboard');
  await expect(titles(frame)).toHaveText('Umziehen');
  await frame.getByLabel('Aktuelles Board', { exact: true }).selectOption({ label: 'Mein Board' });
  await expect(titles(frame)).toHaveCount(0);
  await expect(frame.locator('.focus-empty')).toBeVisible();
  await saved(frame);
});

for (const [scope, deleted] of [['done', ['done', 'both']], ['archive', ['archived', 'both']], ['both', ['done', 'archived', 'both']]]) {
  test(`explicit bulk ${scope} ignores filters, confirms, and affects only the current board`, async ({ page }) => {
    const frame = await openBoard(page);
    const cards = [v2Card('keep'), v2Card('done', { status: 'done' }), v2Card('archived', { archivedAt: 1 }),
      v2Card('both', { status: 'done', archivedAt: 1 }), v2Card('other', { boardId: 'other', status: 'done', archivedAt: 1 })];
    await seedBoard(page, documentV2(cards, boards));
    await frame.getByLabel('Karten durchsuchen').fill('does not match any card');
    await expect(titles(frame)).toHaveCount(0);
    const before = await page.evaluate(() => [...testHost.entries]);
    await action(frame, `bulk-${scope}`).click();
    const dialog = frame.getByRole('dialog', { name: 'Karten gesammelt löschen?' });
    await expect(dialog).toContainText(`${deleted.length} Karten`);
    expect(await page.evaluate(() => [...testHost.entries])).toEqual(before);
    await action(frame, 'cancel-confirmation').click();
    expect(await page.evaluate(() => [...testHost.entries])).toEqual(before);
    await action(frame, `bulk-${scope}`).click(); await action(frame, 'confirm').click();
    await action(frame, 'reset-filters').click();
    await frame.locator('[data-view="trash"]').click();
    await expect(titles(frame)).toHaveText(deleted.map((id) => `Idee ${id}`));
    const backup = JSON.parse(await exportBackup(page, frame));
    expect(backup.board.cards.filter((item) => item.deletedAt !== null).map((item) => item.id)).toEqual(deleted);
    expect(backup.board.cards.find((item) => item.id === 'other').deletedAt).toBeNull();
    await frame.getByLabel('Aktuelles Board', { exact: true }).selectOption('other');
    await frame.locator('[data-view="archive"]').click();
    await expect(titles(frame)).toHaveText('Idee other');
    await saved(frame);
  });
}

test('empty trash is confirmed, board-scoped, irreversible and clears resurrection through undo', async ({ page }) => {
  const frame = await openBoard(page);
  await seedBoard(page, documentV2([v2Card('keep'), v2Card('trash', { deletedAt: 1 }), v2Card('other', { boardId: 'other', deletedAt: 1 })], boards));
  await createCard(frame, 'Undo history');
  await action(frame, 'empty-trash').click();
  await expect(frame.getByRole('dialog', { name: 'Papierkorb endgültig leeren?' })).toContainText('nicht rückgängig');
  await action(frame, 'cancel-confirmation').click();
  await frame.locator('[data-view="trash"]').click();
  await expect(titles(frame)).toHaveText('Idee trash');
  await action(frame, 'empty-trash').click(); await action(frame, 'confirm').click();
  await expect(titles(frame)).toHaveCount(0);
  await expect(action(frame, 'undo')).toBeDisabled();
  const backup = JSON.parse(await exportBackup(page, frame));
  expect(backup.board.cards.map((item) => item.id)).not.toContain('trash');
  expect(backup.board.cards.find((item) => item.id === 'other').deletedAt).toBe(1);
  await saved(frame); await reloadFrame(page);
  await frame.locator('[data-view="trash"]').click();
  await expect(titles(frame)).toHaveCount(0);
});

test('safe links and actual text/image file inputs support previews, backup and persistence', async ({ page }) => {
  const frame = await openBoard(page);
  await action(frame, 'add').first().click();
  await editDraft(frame, { title: 'Dateien', links: 'Unsicher | javascript:alert(1)' });
  await action(frame, 'save-card').click();
  await expect(frame.getByRole('dialog').getByRole('alert')).toContainText('http://');
  expect(await requests(page, 'open-url')).toHaveLength(0);
  await editDraft(frame, { links: 'Dokumentation | https://example.com/docs' });
  const text = '<script>throw new Error("XSS")</script>\nGrüße 😀';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=', 'base64');
  await frame.getByRole('dialog').locator('input[name="attachments"]').setInputFiles([
    { name: 'notiz.txt', mimeType: 'text/plain', buffer: Buffer.from(text) },
    { name: 'pixel.png', mimeType: 'image/png', buffer: png },
  ]);
  await expect(frame.getByRole('dialog').locator('.attachment-row')).toHaveCount(2);
  await action(frame, 'save-card').click();
  await card(frame, 'Dateien').getByRole('button', { name: '↗ Dokumentation', exact: true }).click();
  await expect.poll(async () => (await requests(page, 'open-url')).length).toBe(1);
  expect((await requests(page, 'open-url'))[0].payload).toEqual({ url: 'https://example.com/docs' });
  await card(frame, 'Dateien').getByRole('button', { name: /notiz\.txt/ }).click();
  await expect(frame.getByRole('dialog').getByLabel('Dateiinhalt')).toHaveValue(text);
  await frame.getByRole('dialog').getByLabel('Schließen', { exact: true }).click();
  await card(frame, 'Dateien').getByRole('button', { name: /pixel\.png/ }).click();
  const image = frame.getByRole('dialog').getByRole('img', { name: 'pixel.png', exact: true });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth)).toBe(1);
  await frame.getByRole('dialog').getByLabel('Schließen', { exact: true }).click();
  const backup = JSON.parse(await exportBackup(page, frame));
  expect(backup.board.cards[0].attachments.map((file) => file.name)).toEqual(['notiz.txt', 'pixel.png']);
  expect(Buffer.from(backup.board.cards[0].attachments[0].base64, 'base64').toString()).toBe(text);
  await saved(frame); await reloadFrame(page);
  await expect(card(frame, 'Dateien').getByRole('button', { name: /pixel\.png/ })).toBeVisible();
});

test('legacy storage and v1 backups migrate; full v2 backups round-trip through file input', async ({ page }) => {
  const frame = await openBoard(page);
  const legacy = { schemaVersion: 1, focusId: 'old', cards: [v1Card('old', { status: 'in-progress', notes: 'Alte Daten' })] };
  await seedBoard(page, legacy);
  await expect(frame.locator('.focus-card h3')).toHaveText('Idee old');
  await importBackup(frame, JSON.stringify({ format: 'openchamber-ideenboard-backup', version: 1, board: legacy }));
  await expect(frame.locator('.focus-card h3')).toHaveText('Idee old');
  const migrated = JSON.parse(await exportBackup(page, frame));
  expect(migrated.version).toBe(2);
  expect(migrated.board.schemaVersion).toBe(2);
  // Round-trip every v2 collection, not just the legacy card's default fields.
  const rich = documentV2([
    v2Card('old', { status: 'in-progress', notes: 'Alte Daten', labels: ['Migration'], priority: 'high', dueDate: '2099-01-01',
      checklist: [{ id: 'step-one', text: 'Prüfen', done: true }],
      links: [{ id: 'link-one', title: 'Referenz', url: 'https://example.com/' }],
      attachments: [{ id: 'file-one', name: 'behalten.txt', mime: 'text/plain', base64: Buffer.from('Bleibt erhalten').toString('base64'), size: Buffer.byteLength('Bleibt erhalten') }],
      sessionLinks: [{ sessionId: 'ses-roundtrip', title: 'Gesicherter Chat', directory: '/fake/project' }] }),
    v2Card('archived', { archivedAt: 1 }), v2Card('deleted', { deletedAt: 1 }), v2Card('other', { boardId: 'other' }),
  ], [{ ...boards[0], focusId: 'old' }, boards[1]]);
  await seedBoard(page, rich);
  const roundtrip = await exportBackup(page, frame);
  await createCard(frame, 'Später');
  await action(frame, 'import-open').click();
  await frame.getByRole('dialog').getByLabel('Backup-Inhalt').fill('not json');
  await action(frame, 'validate-import').click();
  await expect(frame.getByRole('dialog').getByRole('alert')).toBeVisible();
  await expect(frame.getByRole('dialog').getByLabel('Backup-Inhalt')).toHaveValue('not json');
  await frame.getByRole('dialog').locator('input[name="backup-file"]').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(roundtrip) });
  await expect(frame.getByRole('dialog').getByLabel('Backup-Inhalt')).toHaveValue(roundtrip);
  await action(frame, 'validate-import').click(); await action(frame, 'confirm').click();
  await expect(titles(frame)).toHaveText('Idee old');
  expect(JSON.parse(await exportBackup(page, frame)).board).toEqual(JSON.parse(roundtrip).board);
  await saved(frame); await reloadFrame(page);
  await expect(titles(frame)).toHaveText('Idee old');
});

test('failed save preserves another open draft, old stored state, and retry persists changes', async ({ page }) => {
  const frame = await openBoard(page);
  await createCard(frame, 'Gesichert'); await saved(frame);
  const before = await page.evaluate(() => [...testHost.entries]);
  await page.evaluate(() => { testHost.failWrites = true; testHost.holdWrites = true; });
  await createCard(frame, 'Ungesichert');
  await expect.poll(() => page.evaluate(() => testHost.heldWrites.length)).toBe(1);
  await action(frame, 'add').first().click();
  await editDraft(frame, { title: 'Entwurf behalten', notes: 'Nicht verlieren', checklist: '[ ] Bleibt auch' });
  await page.evaluate(() => testHost.releaseWrites());
  await expect(frame.locator('[data-save-state]')).toHaveText('Speichern fehlgeschlagen');
  await expect(frame.getByRole('dialog').getByLabel('Titel', { exact: true })).toHaveValue('Entwurf behalten');
  await expect(frame.getByRole('dialog').locator('[name="notes"]')).toHaveValue('Nicht verlieren');
  await expect(frame.getByRole('dialog').locator('[name="checklist"]')).toHaveValue('[ ] Bleibt auch');
  expect(await page.evaluate(() => [...testHost.entries])).toEqual(before);
  await frame.getByRole('dialog').getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await page.evaluate(() => { testHost.failWrites = false; });
  await action(frame, 'retry-save').click(); await saved(frame); await reloadFrame(page);
  await expect(titles(frame)).toHaveText(['Gesichert', 'Ungesichert']);
});

test('read failure never overwrites existing keys and recovers without data loss', async ({ page }) => {
  const frame = await openBoard(page);
  await createCard(frame, 'Original'); await saved(frame);
  const before = await page.evaluate(() => ({ entries: [...testHost.entries], writes: testHost.writes, deletes: testHost.deletes }));
  await page.evaluate(() => { testHost.failReads = true; }); await reloadFrame(page);
  await expect(frame.getByRole('heading', { name: 'Board konnte nicht geladen werden' })).toBeVisible();
  expect(await page.evaluate(() => ({ entries: [...testHost.entries], writes: testHost.writes, deletes: testHost.deletes }))).toEqual(before);
  await expect(action(frame, 'add')).toHaveCount(0);
  await page.evaluate(() => { testHost.failReads = false; });
  await action(frame, 'retry-load').click();
  await expect(titles(frame)).toHaveText('Original');
});

test('backup above 32k uses a complete manual fallback; clipboard denial also falls back', async ({ page }) => {
  const frame = await openBoard(page);
  const large = { schemaVersion: 1, focusId: null, cards: Array.from({ length: 32 }, (_, index) => v1Card(String(index), { notes: 'a'.repeat(1200) })) };
  await seedBoard(page, large);
  await action(frame, 'backup-copy').first().click();
  const text = await frame.getByRole('dialog').getByLabel('Vollständiges Backup').inputValue();
  expect(text.length).toBeGreaterThan(32000);
  expect(JSON.parse(text).board.cards).toHaveLength(32);
  expect(await requests(page, 'clipboard-write')).toHaveLength(0);
  await action(frame, 'select-backup').click();
  expect(await frame.getByRole('dialog').getByLabel('Vollständiges Backup').evaluate((element) => element.selectionEnd - element.selectionStart)).toBe(text.length);
  await frame.getByRole('dialog').getByLabel('Schließen', { exact: true }).click();
  await seedBoard(page, { ...large, cards: large.cards.slice(0, 1) });
  await page.evaluate(() => { testHost.failClipboard = true; });
  await action(frame, 'backup-copy').first().click();
  await expect(frame.getByRole('dialog')).toContainText('Zwischenablage ist nicht verfügbar');
  expect(JSON.parse(await frame.getByRole('dialog').getByLabel('Vollständiges Backup').inputValue()).board.cards).toHaveLength(1);
});

test('collect-idea message creates only an editable unsaved draft and preserves source link', async ({ page }) => {
  const frame = await openBoard(page);
  await page.evaluate(() => testHost.pushItem({ kind: 'message', action: 'collect-idea', sessionId: 'ses-source', sessionTitle: 'Quellchat',
    messageId: 'msg-one', directory: '/fake/project', role: 'assistant', text: '# Gesammelte Idee\nDetails <script>alert(1)</script>' }));
  await expect(frame.getByRole('dialog').getByLabel('Titel', { exact: true })).toHaveValue('Gesammelte Idee');
  await expect(frame.getByRole('dialog').locator('[name="notes"]')).toHaveValue('# Gesammelte Idee\nDetails <script>alert(1)</script>');
  expect(await page.evaluate(() => testHost.writes)).toBe(0);
  expect(await requests(page, 'start-session')).toHaveLength(0);
  await action(frame, 'save-card').click();
  await expect(card(frame, 'Gesammelte Idee')).toBeVisible();
  await expect(frame.locator('.task-card script')).toHaveCount(0);
  await card(frame, 'Gesammelte Idee').getByRole('button', { name: '◉ Quellchat', exact: true }).click();
  await expect.poll(async () => (await requests(page, 'open-session')).length).toBe(1);
  expect((await requests(page, 'open-session'))[0].payload.sessionId).toBe('ses-source');
  await saved(frame);
});

test('current chat is linked only after an explicit click and repeated linking does not duplicate', async ({ page }) => {
  const frame = await openBoard(page);
  await page.evaluate(() => { testHost.pushSession({ id: 'ses-current', title: 'Aktueller Chat', busy: false }); testHost.pushDirectory('/fake/project'); });
  await createCard(frame, 'Verknüpfen');
  const dialog = await openChat(frame, 'Verknüpfen');
  expect(await requests(page, 'session-link')).toHaveLength(0);
  expect(await requests(page, 'start-session')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Aktuellen Chat verknüpfen', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Chat öffnen: Aktueller Chat', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Aktuellen Chat verknüpfen', exact: true }).click();
  await expect.poll(async () => (await requests(page, 'session-link')).length).toBe(2);
  await expect(dialog.getByRole('button', { name: 'Chat öffnen: Aktueller Chat', exact: true })).toHaveCount(1);
  expect(await requests(page, 'start-session')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Chat öffnen: Aktueller Chat', exact: true }).click();
  await expect.poll(async () => (await requests(page, 'open-session')).length).toBe(1);
  await dialog.getByLabel('Schließen', { exact: true }).click(); await saved(frame);
});

for (const sent of ['sent', 'no-model', 'failed']) {
  test(`explicit session start with project picker returns ${sent}, links the existing chat and never auto-retries`, async ({ page }) => {
    const frame = await openBoard(page);
    await page.evaluate((sent) => { testHost.startSent = sent; }, sent);
    await createCard(frame, 'Sitzungsidee', { notes: 'Konkrete Notiz', checklist: '[ ] Prüfen', links: 'Referenz | https://example.com/' });
    const dialog = await openChat(frame, 'Sitzungsidee');
    await expect(action(frame, 'start-session')).toBeDisabled();
    expect(await requests(page, 'start-session')).toHaveLength(0);
    await dialog.getByLabel('Projekt für die Arbeitssitzung', { exact: true }).selectOption('project-one');
    await expect(action(frame, 'start-session')).toBeEnabled();
    await action(frame, 'start-session').click();
    await expect(dialog.getByRole('button', { name: 'Chat öffnen: Sitzungsidee', exact: true })).toBeVisible();
    await expect(dialog).toContainText(sent === 'sent' ? 'Karten-Prompt gesendet' : 'Karten-Prompt wurde nicht gesendet');
    const starts = await requests(page, 'start-session');
    expect(starts).toHaveLength(1);
    expect(starts[0].payload).toMatchObject({ projectId: 'project-one', navigation: 'preserve', providerId: 'ideenboard', title: 'Sitzungsidee' });
    // SDK clampStartSessionRequest intentionally omits worktree:false on the wire.
    expect(starts[0].payload.worktree).toBeUndefined();
    expect(starts[0].payload.text).toContain('Konkrete Notiz');
    expect(starts[0].payload.text).toContain('- [ ] Prüfen');
    expect(starts[0].payload.text).toContain('https://example.com/');
    await action(frame, 'start-session').click();
    await expect(frame.getByRole('dialog', { name: 'Weitere Arbeitssitzung starten?' })).toBeVisible();
    expect(await requests(page, 'start-session')).toHaveLength(1);
    await action(frame, 'cancel-confirmation').click();
    await dialog.getByRole('button', { name: 'Chat öffnen: Sitzungsidee', exact: true }).click();
    await expect.poll(async () => (await requests(page, 'open-session')).length).toBe(1);
    expect((await requests(page, 'open-session'))[0].payload.sessionId).toBe('ses-test-1');
    expect(await requests(page, 'start-session')).toHaveLength(1);
    await dialog.getByLabel('Schließen', { exact: true }).click(); await saved(frame); await reloadFrame(page);
    await expect(card(frame, 'Sitzungsidee').getByRole('button', { name: '◉ Sitzungsidee', exact: true })).toHaveCount(1);
    expect(await requests(page, 'start-session')).toHaveLength(1);
  });
}

test('NOT_GRANTED session start reports denial without invented links or automatic retries', async ({ page }) => {
  const frame = await openBoard(page);
  await page.evaluate(() => { testHost.pushDirectory('/fake/project'); testHost.startFailure = 'NOT_GRANTED'; });
  await createCard(frame, 'Verweigert');
  const dialog = await openChat(frame, 'Verweigert');
  await action(frame, 'start-session').click();
  await expect(dialog).toContainText('Sitzungs- oder Promptberechtigung fehlt');
  await expect(dialog.getByRole('button', { name: /Chat öffnen:/ })).toHaveCount(0);
  await dialog.getByLabel('Schließen', { exact: true }).click();
  await expect(card(frame, 'Verweigert').locator('[data-action="open-chat"]')).toHaveCount(0);
  expect(await requests(page, 'start-session')).toHaveLength(1);
});

test('NOT_GRANTED current-chat link never claims or persists a successful link', async ({ page }) => {
  const frame = await openBoard(page);
  await page.evaluate(() => { testHost.pushSession({ id: 'ses-denied', title: 'Verweigert', busy: false }); testHost.failures['session-link'] = 'NOT_GRANTED'; });
  await createCard(frame, 'Kein Link');
  const dialog = await openChat(frame, 'Kein Link');
  await dialog.getByRole('button', { name: 'Aktuellen Chat verknüpfen', exact: true }).click();
  await expect(dialog).toContainText('verweigert');
  await expect(dialog.getByRole('button', { name: /Chat öffnen:/ })).toHaveCount(0);
  await dialog.getByLabel('Schließen', { exact: true }).click();
  expect(JSON.parse(await exportBackup(page, frame)).board.cards[0].sessionLinks).toEqual([]);
  expect(await requests(page, 'start-session')).toHaveLength(0);
});

test('sending the initial card prompt requires the separate prompt grant', async ({ page }) => {
  const frame = await openBoard(page);
  await page.evaluate(() => { testHost.pushDirectory('/fake/project'); testHost.grants = ['sessions']; });
  await createCard(frame, 'Prompt-Freigabe');
  const dialog = await openChat(frame, 'Prompt-Freigabe');
  await action(frame, 'start-session').click();
  await expect(dialog).toContainText('Sitzungs- oder Promptberechtigung fehlt');
  await expect(dialog.getByRole('button', { name: /Chat öffnen:/ })).toHaveCount(0);
  expect(await page.evaluate(() => testHost.sessionCounter)).toBe(0);
});

test('uncertain start prevents repeated starts even after closing and reopening chat', async ({ page }) => {
  const frame = await openBoard(page);
  await page.evaluate(() => { testHost.pushDirectory('/fake/project'); testHost.startFailure = 'HOST_TIMEOUT'; });
  await createCard(frame, 'Unklar');
  let dialog = await openChat(frame, 'Unklar');
  await action(frame, 'start-session').click();
  await expect(dialog).toContainText('Sitzungsstatus ist unklar');
  await expect(action(frame, 'start-session')).toBeDisabled();
  await dialog.getByLabel('Schließen', { exact: true }).click();
  dialog = await openChat(frame, 'Unklar');
  await expect(action(frame, 'start-session')).toBeDisabled();
  await expect(dialog.getByRole('button', { name: /Chat öffnen:/ })).toHaveCount(0);
  expect(await requests(page, 'start-session')).toHaveLength(1);
});

test('360px panel has no horizontal overflow and Escape restores editor trigger focus', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const frame = await openBoard(page);
  await createCard(frame, 'Mobile Idee', { labels: 'Mobil', notes: 'Langer Text '.repeat(20) });
  expect(await frame.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true);
  await action(frame, 'add').first().click();
  await expect(frame.getByRole('dialog').getByLabel('Titel', { exact: true })).toBeFocused();
  expect(await frame.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true);
  await frame.getByRole('dialog').getByLabel('Titel', { exact: true }).press('Escape');
  await expect(frame.getByRole('dialog')).toHaveCount(0);
  await expect(action(frame, 'add').first()).toBeFocused();
});

test('full board visual review with labels, checklist, focus and multiple columns', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  const frame = await openBoard(page);
  await seedBoard(page, documentV2([
    v2Card('one', { title: 'Ideen für die Website', labels: ['Privat', 'Website'], priority: 'high', notes: 'Eine klare Startseite und bessere Navigation planen.', checklist: [{ id: 'c1', text: 'Ersten Entwurf skizzieren', done: false }] }),
    v2Card('two', { title: 'Urlaubsplanung', status: 'next', labels: ['Privat'], dueDate: '2026-12-01' }),
    v2Card('three', { title: 'Am Ideenboard weiterarbeiten', status: 'in-progress', notes: 'Neue Funktionen ausprobieren und nächste Ideen festhalten.', priority: 'urgent' }),
    v2Card('four', { title: 'Arbeitsplatz aufgeräumt', status: 'done' }),
  ], [{ id: 'default', name: 'Mein Board', focusId: 'three' }]));
  await expect(frame.locator('.focus-card h3')).toHaveText('Am Ideenboard weiterarbeiten');
  expect(await frame.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('ideenboard-v2.png'), fullPage: true });
});
