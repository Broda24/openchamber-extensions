import type { HostClient, JsonValue } from '@openchamber/sdk';
import { emptyBoard, parseBoard, SAFE_STORAGE_LIMIT_BYTES, STORAGE_KEY, type BoardDocument } from './board-model';

export const INDEX_KEY = 'ideenboard-v2-index';
export const SNAPSHOT_PREFIX = 'ideenboard-v2-snapshot-';
export const MAX_CHUNK_BYTES = 60 * 1024;
// Base64 avoids JSON escaping expansion (which can otherwise approach 6x).
// Two 700-KiB snapshots occupy < 1.9 MiB including keys and index metadata.
const RAW_CHUNK_BYTES = 44 * 1024;
const MAX_CHUNKS = Math.ceil(SAFE_STORAGE_LIMIT_BYTES / RAW_CHUNK_BYTES);
const SNAPSHOT_KEY = /^ideenboard-v2-snapshot-([a-f0-9]{32})-(\d{1,2})$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
type SnapshotIndex = { version: 2; snapshotId: string; chunks: number; bytes: number; checksum: string };
export type BoardStorage = { load(): Promise<BoardDocument>; save(board: BoardDocument): Promise<void> };

const keyFor = (index: SnapshotIndex, chunk: number) => `${SNAPSHOT_PREFIX}${index.snapshotId}-${chunk}`;
const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
function checksum(bytes: Uint8Array): string {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function parseIndex(value: unknown): SnapshotIndex {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Ungültiger Speicherindex. Daten wurden nicht verändert.');
  const v = value as Record<string, unknown>;
  if (v.version !== 2 || typeof v.snapshotId !== 'string' || !/^[a-f0-9]{32}$/.test(v.snapshotId)
    || typeof v.chunks !== 'number' || !Number.isInteger(v.chunks) || v.chunks < 1 || v.chunks > MAX_CHUNKS
    || typeof v.bytes !== 'number' || !Number.isInteger(v.bytes) || v.bytes < 1 || v.bytes > SAFE_STORAGE_LIMIT_BYTES
    || v.chunks !== Math.ceil(v.bytes / RAW_CHUNK_BYTES)
    || typeof v.checksum !== 'string' || !/^[a-f0-9]{8}$/.test(v.checksum)) throw new Error('Ungültiger Speicherindex. Daten wurden nicht verändert.');
  return { version: 2, snapshotId: v.snapshotId, chunks: v.chunks, bytes: v.bytes, checksum: v.checksum };
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

let fallbackCounter = 0;
function randomId(): string {
  if (globalThis.crypto?.getRandomValues) {
    return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (v) => v.toString(16).padStart(2, '0')).join('');
  }
  // Sandboxed hosts need not expose crypto. IDs are uniqueness tokens, not secrets.
  const prefix = (Date.now().toString(16) + (++fallbackCounter).toString(16)).padEnd(16, '0').slice(0, 16);
  return prefix + Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function createBoardStorage(storage: HostClient['storage']): BoardStorage {
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const pending = queue.then(operation);
    queue = pending.catch(() => undefined);
    return pending;
  }

  async function readSnapshot(index: SnapshotIndex): Promise<BoardDocument> {
    const bytes = new Uint8Array(index.bytes);
    let offset = 0;
    for (let i = 0; i < index.chunks; i++) {
      const value = await storage.get(keyFor(index, i));
      if (typeof value !== 'string' || bytesOf(value) > MAX_CHUNK_BYTES
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Speicherteil fehlt oder ist beschädigt.');
      let binary: string;
      try { binary = atob(value); } catch { throw new Error('Speicherteil ist beschädigt.'); }
      if (btoa(binary) !== value || binary.length !== Math.min(RAW_CHUNK_BYTES, index.bytes - offset)) throw new Error('Speicherteil hat eine ungültige Länge.');
      for (let j = 0; j < binary.length; j++) bytes[offset++] = binary.charCodeAt(j);
    }
    if (offset !== index.bytes || checksum(bytes) !== index.checksum) throw new Error('Speicherprüfung fehlgeschlagen.');
    let value: unknown;
    try { value = JSON.parse(decoder.decode(bytes)); } catch { throw new Error('Gespeicherte Boarddaten sind beschädigt.'); }
    const board = parseBoard(value);
    if (!board || (value as { schemaVersion?: unknown }).schemaVersion !== 2) throw new Error('Gespeicherte Boarddaten sind ungültig.');
    return board;
  }

  async function current(): Promise<SnapshotIndex | null> {
    const value = await storage.get(INDEX_KEY);
    return value === undefined ? null : parseIndex(value);
  }

  async function cleanup(keep: SnapshotIndex | null): Promise<void> {
    const keys = await storage.keys();
    for (const key of keys) {
      const match = SNAPSHOT_KEY.exec(key);
      if (match && match[1] !== keep?.snapshotId) await storage.delete(key);
    }
  }

  return {
    load: () => serial(async () => {
      const index = await current();
      if (index) return readSnapshot(index);
      const legacy = await storage.get(STORAGE_KEY);
      if (legacy === undefined) return emptyBoard();
      const board = parseBoard(legacy);
      if (!board) throw new Error('Bestehende Boarddaten sind ungültig. Es wurde nichts überschrieben.');
      return board;
    }),
    save: (board) => {
      // Capture now, not when an earlier queued operation finishes.
      const parsed = parseBoard(board);
      const captured = parsed && JSON.stringify(parsed);
      return serial(async () => {
        if (!captured) throw new Error('Boarddaten sind ungültig oder zu groß.');
        const bytes = encoder.encode(captured);
        if (bytes.length > SAFE_STORAGE_LIMIT_BYTES) throw new Error('Das Board überschreitet die sichere Speichergrenze.');
        const previous = await current();
        // Verify all current chunks before deleting anything, even old orphans.
        if (previous) await readSnapshot(previous);
        else {
          const legacy = await storage.get(STORAGE_KEY);
          if (legacy !== undefined && !parseBoard(legacy)) throw new Error('Bestehende Boarddaten sind ungültig.');
        }
        await cleanup(previous);
        const existingKeys = new Set(await storage.keys());
        let snapshotId: string;
        do { snapshotId = randomId(); } while (snapshotId === previous?.snapshotId || [...existingKeys].some((key) => key.startsWith(`${SNAPSHOT_PREFIX}${snapshotId}-`)));
        const index: SnapshotIndex = { version: 2, snapshotId, chunks: Math.ceil(bytes.length / RAW_CHUNK_BYTES), bytes: bytes.length, checksum: checksum(bytes) };
        for (let i = 0; i < index.chunks; i++) {
          const chunk = toBase64(bytes.subarray(i * RAW_CHUNK_BYTES, (i + 1) * RAW_CHUNK_BYTES));
          if (bytesOf(chunk) > MAX_CHUNK_BYTES) throw new Error('Speicherteil überschreitet die sichere Größe.');
          await storage.set(keyFor(index, i), chunk);
        }
        // This is the only commit point. All prior failures leave the old pointer intact.
        await storage.set(INDEX_KEY, index as unknown as JsonValue);
        // Post-commit housekeeping is best effort: a committed save must not report failure.
        // Failed cleanup is retried before the next save, before consuming snapshot space.
        try { await cleanup(index); await storage.delete(STORAGE_KEY); } catch { /* keep committed data */ }
      });
    },
  };
}
