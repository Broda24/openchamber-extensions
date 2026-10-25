import assert from 'node:assert/strict';
import test from 'node:test';
import { createBoardStorage, INDEX_KEY, SNAPSHOT_PREFIX, MAX_CHUNK_BYTES } from '../.test/board-storage.mjs';
import { emptyBoard, STORAGE_KEY, SAFE_STORAGE_LIMIT_BYTES, serializedBoardBytes } from '../.test/board-model.mjs';

const bytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
function memory(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = [];
  let fail = () => false;
  let maxBytes = 0;
  const storage = {
    async get(key) { calls.push(['get', key]); if (fail('get', key)) throw Error('injected get'); return structuredClone(data.get(key)); },
    async set(key, value) {
      calls.push(['set', key]); if (fail('set', key)) throw Error('injected set');
      assert.ok(key.length >= 1 && key.length <= 128);
      assert.ok(bytes(value) <= 64 * 1024, 'SDK 64-KiB value limit');
      const next = new Map(data); next.set(key, structuredClone(value));
      const total = bytes(Object.fromEntries(next));
      assert.ok(total <= 2 * 1024 * 1024, 'SDK namespace 2-MiB limit');
      assert.ok(next.size <= 2000);
      maxBytes = Math.max(maxBytes, total); data.set(key, structuredClone(value));
    },
    async delete(key) { calls.push(['delete', key]); if (fail('delete', key)) throw Error('injected delete'); data.delete(key); },
    async keys() { calls.push(['keys']); if (fail('keys', '')) throw Error('injected keys'); return [...data.keys()]; },
  };
  return { data, calls, storage, setFailure(fn) { fail = fn; }, get maxBytes() { return maxBytes; } };
}
function board(notes = '💡 Hallo 世界', count = 1) {
  return { ...emptyBoard(), cards: Array.from({ length: count }, (_, i) => ({
    id: `card-${i}`, boardId: 'default', title: `Idee ${i}`, notes,
    status: 'ideas', createdAt: 1, updatedAt: 2, labels: [], priority: 'normal', dueDate: null,
    checklist: [], links: [], attachments: [], sessionLinks: [], archivedAt: null, deletedAt: null,
  })) };
}
const legacy = { schemaVersion: 1, focusId: 'old', cards: [{ id: 'old', title: 'Alt', notes: 'Notiz', status: 'in-progress', createdAt: 1, updatedAt: 2 }] };
const writes = (m) => m.calls.filter(([op]) => op === 'set' || op === 'delete');

test('missing storage loads an empty board without writing; v1 loads without writing or removing legacy', async () => {
  const m = memory(); assert.deepEqual(await createBoardStorage(m.storage).load(), emptyBoard()); assert.deepEqual(writes(m), []);
  const old = memory({ [STORAGE_KEY]: legacy });
  const loaded = await createBoardStorage(old.storage).load();
  assert.equal(loaded.schemaVersion, 2); assert.equal(loaded.boards[0].focusId, 'old');
  assert.equal(loaded.cards[0].title, 'Alt'); assert.deepEqual(writes(old), []);
});

test('save and reload are lossless across unicode chunk boundaries and <=60-KiB encoded chunk values', async () => {
  const m = memory(); const s = createBoardStorage(m.storage);
  const document = board('💡世界ä'.repeat(500), 40);
  await s.save(document);
  assert.deepEqual(await createBoardStorage(m.storage).load(), document);
  const chunks = [...m.data].filter(([key]) => key.startsWith(SNAPSHOT_PREFIX));
  assert.ok(chunks.length > 1);
  for (const [, value] of chunks) assert.ok(bytes(value) <= MAX_CHUNK_BYTES);
});

test('nearly full snapshots with hostile JSON escaping fit two copies plus legacy under SDK capacity', async () => {
  const m = memory({ [STORAGE_KEY]: legacy }); const s = createBoardStorage(m.storage);
  const document = board('\u0000'.repeat(1000), 112);
  assert.ok(serializedBoardBytes(document) < SAFE_STORAGE_LIMIT_BYTES);
  assert.ok(serializedBoardBytes(document) > 650 * 1024);
  await s.save(document); await s.save(document);
  assert.deepEqual(await s.load(), document);
  assert.ok(m.maxBytes < 2 * 1024 * 1024);
});

test('maximum-sized attachments, nested content, archive and trash roundtrip without loss', async () => {
  const m = memory(); const s = createBoardStorage(m.storage); const document = board();
  const card = document.cards[0];
  card.attachments = Array.from({ length: 4 }, (_, i) => ({ id: `file-${i}`, name: `Dokument-${i}.txt`, mime: 'text/plain', base64: Buffer.alloc(65536, i).toString('base64'), size: 65536 }));
  card.labels = ['Persönlich']; card.priority = 'urgent'; card.dueDate = '2028-02-29';
  card.checklist = [{ id: 'check', text: 'Prüfen', done: true }];
  card.links = [{ id: 'link', title: 'Beispiel', url: 'https://example.org/' }];
  card.sessionLinks = [{ sessionId: 'ses_123', title: 'Gespräch', directory: null }];
  card.archivedAt = 3; card.deletedAt = 4;
  await s.save(document); assert.deepEqual(await s.load(), document);
});

test('chunk and pointer write failures retain the entire committed snapshot', async () => {
  for (const failure of ['first-chunk', 'second-chunk', 'pointer']) {
    const m = memory(); const s = createBoardStorage(m.storage); const original = board('Original');
    await s.save(original); const pointer = structuredClone(m.data.get(INDEX_KEY));
    let chunks = 0;
    m.setFailure((op, key) => {
      if (op !== 'set') return false;
      if (key.startsWith(SNAPSHOT_PREFIX)) chunks++;
      return failure === 'pointer' ? key === INDEX_KEY : key.startsWith(SNAPSHOT_PREFIX) && chunks === (failure === 'first-chunk' ? 1 : 2);
    });
    await assert.rejects(s.save(board('a'.repeat(6000), 40)), /injected/);
    m.setFailure(() => false);
    assert.deepEqual(m.data.get(INDEX_KEY), pointer);
    assert.deepEqual(await createBoardStorage(m.storage).load(), original);
    await s.save(board('Retry'));
    assert.deepEqual(await s.load(), board('Retry'));
    const liveId = m.data.get(INDEX_KEY).snapshotId;
    assert.ok([...m.data.keys()].filter((key) => key.startsWith(SNAPSHOT_PREFIX)).every((key) => key.includes(liveId)));
  }
});

test('failed first v2 save retains legacy and can be retried after orphan cleanup', async () => {
  const m = memory({ [STORAGE_KEY]: legacy }); const s = createBoardStorage(m.storage);
  m.setFailure((op, key) => op === 'set' && key === INDEX_KEY);
  await assert.rejects(s.save(board()), /injected/);
  assert.deepEqual(m.data.get(STORAGE_KEY), legacy); assert.equal(m.data.has(INDEX_KEY), false);
  m.setFailure(() => false);
  assert.equal((await s.load()).cards[0].id, 'old');
  await s.save(board()); assert.equal(m.data.has(STORAGE_KEY), false);
});

test('malformed index, missing/corrupt chunks, invalid legacy and read errors never write, delete or fall back', async () => {
  for (const corrupt of ['index', 'missing', 'chunk', 'checksum', 'get']) {
    const m = memory({ [STORAGE_KEY]: legacy }); const s = createBoardStorage(m.storage);
    await s.save(board()); m.data.set(STORAGE_KEY, legacy);
    const chunkKey = [...m.data.keys()].find((v) => v.startsWith(SNAPSHOT_PREFIX));
    if (corrupt === 'index') m.data.set(INDEX_KEY, { version: 3 });
    if (corrupt === 'missing') m.data.delete(chunkKey);
    if (corrupt === 'chunk') m.data.set(chunkKey, '!!!!');
    if (corrupt === 'checksum') m.data.get(INDEX_KEY).checksum = '00000000';
    if (corrupt === 'get') m.setFailure((op) => op === 'get');
    m.calls.length = 0;
    await assert.rejects(s.load()); assert.deepEqual(writes(m), []);
    await assert.rejects(s.save(board('New'))); assert.deepEqual(writes(m), []);
  }
  const invalid = memory({ [STORAGE_KEY]: { schemaVersion: 99 } });
  await assert.rejects(createBoardStorage(invalid.storage).load()); assert.deepEqual(writes(invalid), []);
});

test('post-commit cleanup failure does not report a committed save as failed and is retried next save', async () => {
  const m = memory(); const s = createBoardStorage(m.storage); await s.save(board('First'));
  m.setFailure((op) => op === 'delete');
  await s.save(board('Second'));
  assert.deepEqual(await s.load(), board('Second'));
  m.setFailure(() => false); await s.save(board('Third'));
  assert.deepEqual(await s.load(), board('Third'));
  const liveId = m.data.get(INDEX_KEY).snapshotId;
  assert.ok([...m.data.keys()].filter((key) => key.startsWith(SNAPSHOT_PREFIX)).every((key) => key.includes(liveId)));
});

test('orphan cleanup only removes own recognized snapshot keys, preserving unrelated keys and legacy until commit', async () => {
  const orphan = `${SNAPSHOT_PREFIX}${'a'.repeat(32)}-0`;
  const unknown = `${SNAPSHOT_PREFIX}not-our-format`;
  const m = memory({ [STORAGE_KEY]: legacy, [orphan]: 'abandoned', [unknown]: 'keep', unrelated: { keep: true } });
  const s = createBoardStorage(m.storage);
  m.setFailure((op, key) => op === 'set' && key === INDEX_KEY);
  await assert.rejects(s.save(board()));
  assert.equal(m.data.has(orphan), false); assert.equal(m.data.get(unknown), 'keep');
  assert.deepEqual(m.data.get('unrelated'), { keep: true }); assert.deepEqual(m.data.get(STORAGE_KEY), legacy);
});

test('queued saves are serialized and capture the submitted value immediately; queue recovers after errors', async () => {
  const m = memory(); const s = createBoardStorage(m.storage); const a = board('First');
  const first = s.save(a); a.cards[0].notes = 'Mutated';
  const second = s.save(board('Second'));
  await first; await second; assert.deepEqual(await s.load(), board('Second'));
  const pointerCalls = m.calls.filter(([op, key]) => op === 'set' && key === INDEX_KEY); assert.equal(pointerCalls.length, 2);
  await assert.rejects(s.save({ ...emptyBoard(), schemaVersion: 3 }));
  await s.save(board('After error')); assert.deepEqual(await s.load(), board('After error'));
});

test('invalid and oversized save inputs are rejected without touching storage', async () => {
  const m = memory(); const s = createBoardStorage(m.storage);
  await assert.rejects(s.save(board('a'.repeat(6000), 130)));
  assert.deepEqual(m.calls, []);
});

test('cleanup failure before the next commit preserves the current snapshot and does not begin new chunks', async () => {
  const m = memory(); const s = createBoardStorage(m.storage); await s.save(board('Original'));
  m.data.set(`${SNAPSHOT_PREFIX}${'b'.repeat(32)}-0`, 'orphan'); m.calls.length = 0;
  m.setFailure((op) => op === 'delete');
  await assert.rejects(s.save(board('New')), /injected/);
  assert.equal(m.calls.some(([op]) => op === 'set'), false);
  m.setFailure(() => false); assert.deepEqual(await s.load(), board('Original'));
});
