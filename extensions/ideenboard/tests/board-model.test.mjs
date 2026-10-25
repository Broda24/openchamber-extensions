import assert from 'node:assert/strict';
import test from 'node:test';
import * as model from '../.test/board-model.mjs';
const { emptyBoard, parseBoard, parseBackup, addCard, replaceCard, moveCard, setFocus, deleteCard, archiveCard, restoreCard, bulkDeleteCards, permanentlyDeleteCards, addBoard, renameBoard, moveCardToBoard, filterCards, dueState, safeHttpUrl } = model;

const card = (overrides = {}) => ({
  id: 'idea-1', boardId: 'default', title: 'Website überarbeiten', notes: 'Startseite vereinfachen',
  status: 'ideas', createdAt: 1700000000000, updatedAt: 1700000000000,
  labels: [], priority: 'normal', dueDate: null, checklist: [], links: [], attachments: [], sessionLinks: [],
  archivedAt: null, deletedAt: null, ...overrides,
});
const doc = (...cards) => ({ ...emptyBoard(), cards });
const legacyCard = (overrides = {}) => ({ id: 'old', title: '  Alte Idee  ', notes: '💡\nAlt', status: 'in-progress', createdAt: 1, updatedAt: 2, ...overrides });
const focus = (board, boardId = 'default') => board.boards.find((v) => v.id === boardId).focusId;
const attachment = (overrides = {}) => ({ id: 'file', name: 'Notiz.txt', mime: 'text/plain', base64: 'SGFsbG8=', size: 5, ...overrides });

test('v1 migrates losslessly to v2 with per-board focus and defaults', () => {
  const old = legacyCard();
  const board = parseBoard({ schemaVersion: 1, cards: [old], focusId: old.id });
  assert.equal(board.schemaVersion, 2);
  assert.equal(focus(board), old.id);
  for (const [key, value] of Object.entries(old)) assert.deepEqual(board.cards[0][key], value);
  assert.deepEqual(board.cards[0], card({ ...old, notes: old.notes }));
  assert.equal(focus(parseBoard({ schemaVersion: 1, cards: [legacyCard({ status: 'ideas' })], focusId: 'old' })), null);
});

test('v1 and v2 backups migrate; unknown formats and versions are rejected', () => {
  for (const version of [1, 2]) {
    assert.ok(parseBackup({ format: model.BACKUP_FORMAT, version, board: version === 1 ? { schemaVersion: 1, cards: [legacyCard()], focusId: null } : doc(card()) }));
  }
  assert.equal(model.BACKUP_VERSION, 2);
  assert.equal(parseBackup({ format: 'other', version: 2, board: emptyBoard() }), null);
  assert.equal(parseBackup({ format: model.BACKUP_FORMAT, version: 3, board: emptyBoard() }), null);
});

test('v2 roundtrip retains nested content, archive, trash and multiple boards', () => {
  const board = addBoard(doc(card({
    labels: ['Web', 'Privat'], priority: 'urgent', dueDate: '2028-02-29',
    checklist: [{ id: 'step', text: 'Startseite', done: true }],
    links: [{ id: 'link', title: 'Projekt', url: 'https://example.org/path' }],
    attachments: [attachment()], sessionLinks: [{ sessionId: 'ses_123', title: 'Chat', directory: '/home/ops' }],
    archivedAt: 3, deletedAt: 4,
  })), 'second', 'Zweites Board');
  assert.deepEqual(parseBoard(board), board);
  const parsed = parseBoard(board);
  parsed.cards[0].labels.push('Anders');
  assert.equal(board.cards[0].labels.length, 2);
});

test('strict validation rejects malformed fields, unknown versions and duplicate identities', () => {
  const invalid = [
    { schemaVersion: 3, cards: [] }, { ...doc(), boards: [] },
    { ...doc(), boards: [...emptyBoard().boards, ...emptyBoard().boards] }, doc(card(), card()),
    ...[
      { id: '' }, { id: '\u0000' }, { id: 'x'.repeat(129) }, { title: ' ' }, { title: 'a'.repeat(121) },
      { notes: 'a'.repeat(6001) }, { boardId: 'missing' }, { priority: 'extreme' }, { status: 'missing' },
      { createdAt: Infinity }, { updatedAt: -1 }, { archivedAt: undefined }, { deletedAt: NaN },
      { dueDate: '2026-02-29' }, { dueDate: '2026-04-31' }, { dueDate: '2026-2-01' }, { dueDate: '0000-01-01' },
      { labels: ['x', 'x'] }, { labels: ['x'.repeat(41)] }, { labels: Array.from({ length: 21 }, (_, i) => String(i)) },
      { checklist: [{ id: 's', text: 'x', done: 'yes' }] },
      { checklist: [{ id: 's', text: 'x', done: true }, { id: 's', text: 'x', done: false }] },
      { links: [{ id: 'l', title: 'x', url: 'javascript:alert(1)' }] },
      { sessionLinks: [{ sessionId: 's', title: 'x', directory: 3 }] },
      { attachments: [attachment({ mime: 'text/html' })] }, { attachments: [attachment({ mime: 'image/svg+xml' })] },
      { attachments: [attachment({ mime: 'text/plain;charset=utf-8' })] },
      { attachments: [attachment({ base64: 'SGFsbG8' })] }, { attachments: [attachment({ base64: 'AB==', size: 1 })] },
      { attachments: [attachment({ size: 4 })] }, { attachments: [attachment({ size: model.MAX_ATTACHMENT_BYTES + 1 })] },
    ].map((fields) => doc(card(fields))),
  ];
  for (const value of invalid) assert.equal(parseBoard(value), null, JSON.stringify(value).slice(0, 140));
  assert.equal(parseBoard(doc(...Array.from({ length: 401 }, (_, i) => card({ id: String(i) })))), null);
  assert.equal(parseBoard({ schemaVersion: 1, cards: [legacyCard(), legacyCard()], focusId: null }), null);
});

test('validation is bounded and ignores unknown fields without traversing them', () => {
  const cyclic = {}; cyclic.self = cyclic;
  assert.ok(parseBoard({ ...doc(card({ ignored: cyclic })), ignored: 1n }));
  const max = attachment({ base64: Buffer.alloc(65536).toString('base64'), size: 65536 });
  assert.ok(parseBoard(doc(card({ attachments: [max] }))));
  assert.equal(parseBoard(doc(card({ attachments: Array.from({ length: 5 }, (_, i) => attachment({ id: String(i) })) }))), null);
});

test('focus is independent per board and implies active in-progress', () => {
  const board = addBoard(doc(card(), card({ id: 'two', boardId: 'other' })), 'other', 'Andere');
  const first = setFocus(board, 'idea-1', 10);
  const both = setFocus(first, 'two', 11);
  assert.equal(focus(both), 'idea-1'); assert.equal(focus(both, 'other'), 'two');
  assert.equal(both.cards[1].status, 'in-progress'); assert.equal(both.cards[1].updatedAt, 11);
  assert.equal(focus(setFocus(both, null, 12, 'other'), 'other'), null);
  assert.equal(focus(board), null);
  assert.equal(focus(setFocus(doc(card({ archivedAt: 2 })), 'idea-1')), null);
  assert.equal(focus(setFocus(doc(card({ deletedAt: 2 })), 'idea-1')), null);
});

test('move reorders within/across columns without mutating the original', () => {
  const board = doc(card(), card({ id: 'b' }), card({ id: 'c', status: 'next' }));
  assert.deepEqual(moveCard(board, 'b', 'ideas', 10, 'idea-1').cards.map((v) => v.id), ['b', 'idea-1', 'c']);
  assert.deepEqual(moveCard(board, 'idea-1', 'ideas', 10, null).cards.map((v) => v.id), ['b', 'idea-1', 'c']);
  const moved = moveCard(board, 'idea-1', 'next', 10, 'c');
  assert.deepEqual(moved.cards.map((v) => v.id), ['b', 'idea-1', 'c']);
  assert.equal(moved.cards[1].status, 'next'); assert.equal(moved.cards[1].updatedAt, 10);
  assert.equal(board.cards[0].status, 'ideas');
});

test('moving, replacing, archiving, moving boards and trashing clear invalid focus', () => {
  const board = setFocus(addBoard(doc(card()), 'other', 'Andere'), 'idea-1', 10);
  for (const changed of [moveCard(board, 'idea-1', 'done', 11), replaceCard(board, { ...board.cards[0], status: 'next' }), archiveCard(board, 'idea-1', true, 11), deleteCard(board, 'idea-1', 11), moveCardToBoard(board, 'idea-1', 'other', 11)]) assert.equal(focus(changed), null);
  assert.equal(focus(board), 'idea-1');
});

test('trash is soft, restore is active, archive is reversible, permanent deletion only removes selected trash', () => {
  const board = doc(card(), card({ id: 'b', deletedAt: 2 }));
  const trashed = deleteCard(board, 'idea-1', 10);
  assert.equal(trashed.cards.length, 2); assert.equal(trashed.cards[0].deletedAt, 10);
  assert.equal(restoreCard(trashed, 'idea-1').cards[0].deletedAt, null);
  const archived = archiveCard(board, 'idea-1', true, 10);
  assert.equal(archiveCard(archived, 'idea-1', false, 11).cards[0].archivedAt, null);
  assert.equal(restoreCard(archived, 'idea-1').cards[0].archivedAt, null);
  assert.deepEqual(permanentlyDeleteCards(trashed, 'default', ['b']).cards.map((v) => v.id), ['idea-1']);
  assert.equal(permanentlyDeleteCards(board, 'default', ['idea-1']).cards.length, 2);
  assert.equal(permanentlyDeleteCards(trashed, 'default').cards.length, 0);
});

test('bulk trash has three independent scopes, board boundary and preserves prior trash timestamps', () => {
  const board = addBoard(doc(
    card({ id: 'done', status: 'done' }), card({ id: 'archive', archivedAt: 3 }),
    card({ id: 'both', status: 'done', archivedAt: 3 }), card({ id: 'active' }),
    card({ id: 'trash', status: 'done', deletedAt: 4 }), card({ id: 'foreign', boardId: 'other', status: 'done' }),
  ), 'other', 'Andere');
  for (const [scope, expected] of [['done', ['done', 'both']], ['archived', ['archive', 'both']], ['done-or-archived', ['done', 'archive', 'both']]]) {
    const next = bulkDeleteCards(board, 'default', scope, 50);
    assert.deepEqual(next.cards.filter((v) => v.deletedAt === 50).map((v) => v.id), expected);
    assert.equal(next.cards.find((v) => v.id === 'trash').deletedAt, 4);
  }
});

test('boards have bounded unique identities and can be renamed without mutating previous state', () => {
  const base = emptyBoard(); const next = addBoard(base, 'work', 'Arbeit');
  assert.equal(next.boards.length, 2); assert.equal(base.boards.length, 1);
  assert.equal(addBoard(next, 'work', 'Duplikat'), next);
  assert.equal(renameBoard(next, 'work', 'Neu').boards[1].name, 'Neu');
  assert.equal(renameBoard(next, 'work', ' '), next);
});

test('filtering combines board, view, text, labels, status, priority and calendar due dates', () => {
  const board = doc(card({ labels: ['Web'], priority: 'high', dueDate: '2026-10-25', checklist: [{ id: 's', text: 'Suchwort', done: false }] }), card({ id: 'archive', archivedAt: 2 }), card({ id: 'trash', deletedAt: 2 }));
  const filter = { boardId: 'default', view: 'active', query: 'SUCHWORT', label: 'Web', priority: 'high', status: 'ideas', due: 'today' };
  assert.equal(filterCards(board, filter, '2026-10-25').length, 1);
  assert.equal(filterCards(board, { ...filter, priority: 'low' }, '2026-10-25').length, 0);
  assert.equal(filterCards(board, { boardId: 'default', view: 'active', label: 'all' }).length, 0);
  assert.equal(filterCards(doc(card({ labels: ['all'] })), { boardId: 'default', view: 'active', label: 'all' }).length, 1);
  assert.equal(filterCards(board, { boardId: 'default', view: 'archive' }).length, 1);
  assert.equal(filterCards(board, { boardId: 'default', view: 'trash' }).length, 1);
  for (const [date, expected] of [[null, 'none'], ['2026-10-24', 'overdue'], ['2026-10-25', 'today'], ['2026-10-26', 'upcoming']]) assert.equal(dueState(card({ dueDate: date }), '2026-10-25'), expected);
  assert.equal(dueState(card({ dueDate: '2026-10-24', status: 'done' }), '2026-10-25'), 'none');
});

test('links permit normalized http(s) only, without credentials or controls', () => {
  assert.equal(safeHttpUrl('https://EXAMPLE.org'), 'https://example.org/');
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///etc/passwd', '//example.org', 'https://u:p@example.org', 'https://example.org/\n']) assert.equal(safeHttpUrl(url), null);
});

test('size and card limits are enforced, UTF8 bytes rather than JS characters', () => {
  assert.ok(model.serializedBoardBytes(doc(card({ notes: '💡' }))) > JSON.stringify(doc(card({ notes: '💡' }))).length);
  const board = doc(...Array.from({ length: 400 }, (_, i) => card({ id: String(i) })));
  assert.equal(addCard(board, card({ id: 'extra' })), board);
  assert.equal(parseBoard(doc(...Array.from({ length: 150 }, (_, i) => card({ id: String(i), notes: 'a'.repeat(6000) })))), null);
});
