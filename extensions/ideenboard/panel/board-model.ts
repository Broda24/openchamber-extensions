export const STORAGE_KEY = 'ideenboard-v1';
export const BACKUP_FORMAT = 'openchamber-ideenboard-backup';
export const BACKUP_VERSION = 2;
export const SAFE_STORAGE_LIMIT_BYTES = 700 * 1024;
export const MAX_CARDS = 400;
export const MAX_BOARDS = 20;
export const MAX_TITLE_LENGTH = 120;
export const MAX_NOTE_LENGTH = 6000;
export const MAX_ATTACHMENT_BYTES = 64 * 1024;
export const MAX_ATTACHMENTS = 4;
export const MAX_LABELS = 20;
export const MAX_LABEL_LENGTH = 40;
export const MAX_CHECKLIST_ITEMS = 100;
export const MAX_LINKS = 20;
export const MAX_SESSION_LINKS = 20;
export const MAX_BOARD_NAME_LENGTH = 80;
export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/markdown', 'application/json', 'text/csv'] as const;

export const COLUMNS = [
  { id: 'ideas', label: 'Ideen', tone: 'ideas' },
  { id: 'next', label: 'Als Nächstes', tone: 'next' },
  { id: 'in-progress', label: 'In Arbeit', tone: 'working' },
  { id: 'done', label: 'Erledigt', tone: 'done' },
] as const;

export type BoardStatus = (typeof COLUMNS)[number]['id'];
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export type BoardInfo = { id: string; name: string; focusId: string | null };
export type ChecklistItem = { id: string; text: string; done: boolean };
export type CardLink = { id: string; title: string; url: string };
export type CardAttachment = { id: string; name: string; mime: string; base64: string; size: number };
export type SessionLink = { sessionId: string; title: string; directory: string | null };
export type BoardCard = {
  id: string;
  boardId: string;
  title: string;
  notes: string;
  status: BoardStatus;
  createdAt: number;
  updatedAt: number;
  labels: string[];
  priority: Priority;
  dueDate: string | null;
  checklist: ChecklistItem[];
  links: CardLink[];
  attachments: CardAttachment[];
  sessionLinks: SessionLink[];
  archivedAt: number | null;
  deletedAt: number | null;
};
export type BoardDocument = { schemaVersion: 2; boards: BoardInfo[]; cards: BoardCard[] };

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number, nonempty = false): v is string => typeof v === 'string' && v.length <= max && (!nonempty || v.trim().length > 0);
const id = (v: unknown): v is string => text(v, 128, true) && !/[\u0000-\u001f\u007f]/.test(v);
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const nullableTimestamp = (v: unknown) => v === null || timestamp(v);
const statusIds = new Set<string>(COLUMNS.map((column) => column.id));
const priorities = new Set<string>(['low', 'normal', 'high', 'urgent']);
const active = (card: BoardCard) => card.archivedAt === null && card.deletedAt === null;

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function safeHttpUrl(value: string): string | null {
  if (!text(value, 4096, true) || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function uniqueArray(value: unknown, max: number, validate: (item: unknown) => boolean, key: (item: any) => string): value is any[] {
  if (!Array.isArray(value) || value.length > max) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (!validate(item)) return false;
    const identity = key(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
  }
  return true;
}

function attachment(value: unknown): boolean {
  if (!record(value) || !id(value.id) || !text(value.name, 255, true)
    || typeof value.mime !== 'string' || !(ATTACHMENT_MIMES as readonly string[]).includes(value.mime)
    || !timestamp(value.size) || value.size > MAX_ATTACHMENT_BYTES || typeof value.base64 !== 'string'
    || value.base64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) return false;
  try {
    const decoded = atob(value.base64);
    return decoded.length === value.size && btoa(decoded) === value.base64;
  } catch { return false; }
}

function basicCard(value: unknown): value is Record<string, unknown> {
  return record(value) && id(value.id) && text(value.title, MAX_TITLE_LENGTH, true)
    && text(value.notes, MAX_NOTE_LENGTH) && typeof value.status === 'string' && statusIds.has(value.status)
    && timestamp(value.createdAt) && timestamp(value.updatedAt);
}

function validCard(value: unknown, boards: Set<string>): value is BoardCard {
  return basicCard(value) && typeof value.boardId === 'string' && boards.has(value.boardId)
    && typeof value.priority === 'string' && priorities.has(value.priority)
    && (value.dueDate === null || validDate(value.dueDate))
    && nullableTimestamp(value.archivedAt) && nullableTimestamp(value.deletedAt)
    && uniqueArray(value.labels, MAX_LABELS, (v) => text(v, MAX_LABEL_LENGTH, true), (v) => v)
    && uniqueArray(value.checklist, MAX_CHECKLIST_ITEMS, (v) => record(v) && id(v.id) && text(v.text, 500, true) && typeof v.done === 'boolean', (v) => v.id)
    && uniqueArray(value.links, MAX_LINKS, (v) => record(v) && id(v.id) && text(v.title, MAX_TITLE_LENGTH) && typeof v.url === 'string' && safeHttpUrl(v.url) !== null, (v) => v.id)
    && uniqueArray(value.attachments, MAX_ATTACHMENTS, attachment, (v) => v.id)
    && uniqueArray(value.sessionLinks, MAX_SESSION_LINKS, (v) => record(v) && id(v.sessionId) && text(v.title, 500) && (v.directory === null || text(v.directory, 4096, true)), (v) => v.sessionId);
}

export const emptyBoard = (): BoardDocument => ({
  schemaVersion: 2, boards: [{ id: 'default', name: 'Mein Board', focusId: null }], cards: [],
});

function clearInvalidFocus(board: BoardDocument): BoardDocument {
  const boards = board.boards.map((info) => {
    if (info.focusId === null || board.cards.some((card) => card.id === info.focusId && card.boardId === info.id && active(card) && card.status === 'in-progress')) return info;
    return { ...info, focusId: null };
  });
  return boards.every((info, index) => info === board.boards[index]) ? board : { ...board, boards };
}

export function parseBoard(value: unknown): BoardDocument | null {
  if (!record(value) || !Array.isArray(value.cards) || value.cards.length > MAX_CARDS) return null;
  let result: BoardDocument;
  if (value.schemaVersion === 1) {
    if (!uniqueArray(value.cards, MAX_CARDS, basicCard, (v) => v.id)
      || !(value.focusId === null || value.focusId === undefined || id(value.focusId))) return null;
    result = emptyBoard();
    result.boards[0].focusId = typeof value.focusId === 'string' ? value.focusId : null;
    result.cards = value.cards.map((card) => ({
      id: card.id, title: card.title, notes: card.notes, status: card.status,
      createdAt: card.createdAt, updatedAt: card.updatedAt,
      boardId: 'default', labels: [], priority: 'normal', dueDate: null, checklist: [],
      links: [], attachments: [], sessionLinks: [], archivedAt: null, deletedAt: null,
    }));
  } else if (value.schemaVersion === 2) {
    if (!uniqueArray(value.boards, MAX_BOARDS, (v) => record(v) && id(v.id) && text(v.name, MAX_BOARD_NAME_LENGTH, true) && (v.focusId === null || id(v.focusId)), (v) => v.id)
      || value.boards.length === 0) return null;
    const boards = new Set<string>(value.boards.map((info) => info.id));
    if (!uniqueArray(value.cards, MAX_CARDS, (v) => validCard(v, boards), (v) => v.id)) return null;
    // Only copy known fields: unknown input can contain cycles or non-JSON values.
    result = { schemaVersion: 2,
      boards: value.boards.map(({ id, name, focusId }) => ({ id, name, focusId })),
      cards: value.cards.map((card) => ({
        id: card.id, boardId: card.boardId, title: card.title, notes: card.notes,
        status: card.status, createdAt: card.createdAt, updatedAt: card.updatedAt,
        priority: card.priority, dueDate: card.dueDate, archivedAt: card.archivedAt, deletedAt: card.deletedAt,
        labels: [...card.labels],
        checklist: card.checklist.map(({ id, text, done }: ChecklistItem) => ({ id, text, done })),
        links: card.links.map(({ id, title, url }: CardLink) => ({ id, title, url })),
        attachments: card.attachments.map(({ id, name, mime, base64, size }: CardAttachment) => ({ id, name, mime, base64, size })),
        sessionLinks: card.sessionLinks.map(({ sessionId, title, directory }: SessionLink) => ({ sessionId, title, directory })),
      })),
    };
  } else return null;
  result = clearInvalidFocus(result);
  return serializedBoardBytes(result) <= SAFE_STORAGE_LIMIT_BYTES ? result : null;
}

export function parseBackup(value: unknown): BoardDocument | null {
  if (!record(value) || value.format !== BACKUP_FORMAT || (value.version !== 1 && value.version !== 2)) return null;
  return parseBoard(value.board);
}

export function serializedBoardBytes(board: BoardDocument): number {
  return new TextEncoder().encode(JSON.stringify(board)).byteLength;
}

export function addCard(board: BoardDocument, card: BoardCard): BoardDocument {
  if (board.cards.length >= MAX_CARDS || board.cards.some((v) => v.id === card.id) || !validCard(card, new Set(board.boards.map((v) => v.id)))) return board;
  const next = { ...board, cards: [...board.cards, card] };
  return serializedBoardBytes(next) <= SAFE_STORAGE_LIMIT_BYTES ? next : board;
}

export function replaceCard(board: BoardDocument, card: BoardCard): BoardDocument {
  if (!board.cards.some((v) => v.id === card.id) || !validCard(card, new Set(board.boards.map((v) => v.id)))) return board;
  const next = clearInvalidFocus({ ...board, cards: board.cards.map((v) => v.id === card.id ? card : v) });
  return serializedBoardBytes(next) <= SAFE_STORAGE_LIMIT_BYTES ? next : board;
}

export function moveCard(board: BoardDocument, cardId: string, status: BoardStatus, now = Date.now(), beforeId?: string | null): BoardDocument {
  const card = board.cards.find((v) => v.id === cardId);
  if (!card || !active(card) || !statusIds.has(status) || !timestamp(now) || beforeId === cardId) return board;
  const cards = board.cards.filter((v) => v.id !== cardId);
  let index = beforeId ? cards.findIndex((v) => v.id === beforeId && v.boardId === card.boardId && v.status === status && active(v)) : -1;
  if (index < 0) {
    let last = -1;
    for (let i = cards.length - 1; i >= 0; i--) {
      if (cards[i].boardId === card.boardId && cards[i].status === status && active(cards[i])) { last = i; break; }
    }
    index = last < 0 ? cards.length : last + 1;
  }
  cards.splice(index, 0, { ...card, status, updatedAt: now });
  return clearInvalidFocus({ ...board, cards });
}

export function setFocus(board: BoardDocument, cardId: string | null, now = Date.now(), boardId = 'default'): BoardDocument {
  if (cardId === null) return { ...board, boards: board.boards.map((v) => v.id === boardId ? { ...v, focusId: null } : v) };
  const card = board.cards.find((v) => v.id === cardId);
  if (!card || !active(card) || !timestamp(now)) return board;
  return {
    ...board,
    boards: board.boards.map((v) => v.id === card.boardId ? { ...v, focusId: cardId } : v),
    cards: board.cards.map((v) => v.id === cardId ? { ...v, status: 'in-progress', updatedAt: now } : v),
  };
}

export function deleteCard(board: BoardDocument, cardId: string, now = Date.now()): BoardDocument {
  const card = board.cards.find((v) => v.id === cardId);
  return !card || card.deletedAt !== null || !timestamp(now) ? board : replaceCard(board, { ...card, deletedAt: now, updatedAt: now });
}

export function archiveCard(board: BoardDocument, cardId: string, archive = true, now = Date.now()): BoardDocument {
  const card = board.cards.find((v) => v.id === cardId);
  return !card || card.deletedAt !== null || !timestamp(now) ? board : replaceCard(board, { ...card, archivedAt: archive ? now : null, updatedAt: now });
}

export function restoreCard(board: BoardDocument, cardId: string): BoardDocument {
  const card = board.cards.find((v) => v.id === cardId);
  return !card ? board : replaceCard(board, { ...card, deletedAt: null, archivedAt: null, updatedAt: Date.now() });
}

export function bulkDeleteCards(board: BoardDocument, boardId: string, scope: 'done' | 'archived' | 'done-or-archived', now = Date.now()): BoardDocument {
  if (!timestamp(now) || !['done', 'archived', 'done-or-archived'].includes(scope)) return board;
  const cards = board.cards.map((card) => {
    const matches = (scope !== 'archived' && card.status === 'done') || (scope !== 'done' && card.archivedAt !== null);
    return card.boardId === boardId && card.deletedAt === null && matches ? { ...card, deletedAt: now, updatedAt: now } : card;
  });
  return clearInvalidFocus({ ...board, cards });
}

export function permanentlyDeleteCards(board: BoardDocument, boardId: string, ids?: string[]): BoardDocument {
  const selected = ids ? new Set(ids) : null;
  return clearInvalidFocus({ ...board, cards: board.cards.filter((v) => !(v.boardId === boardId && v.deletedAt !== null && (!selected || selected.has(v.id)))) });
}

export function addBoard(board: BoardDocument, boardId: string, name: string): BoardDocument {
  return !id(boardId) || !text(name, MAX_BOARD_NAME_LENGTH, true) || board.boards.length >= MAX_BOARDS || board.boards.some((v) => v.id === boardId)
    ? board : { ...board, boards: [...board.boards, { id: boardId, name, focusId: null }] };
}

export function renameBoard(board: BoardDocument, boardId: string, name: string): BoardDocument {
  return !text(name, MAX_BOARD_NAME_LENGTH, true) ? board : { ...board, boards: board.boards.map((v) => v.id === boardId ? { ...v, name } : v) };
}

export function moveCardToBoard(board: BoardDocument, cardId: string, boardId: string, now = Date.now()): BoardDocument {
  const card = board.cards.find((v) => v.id === cardId);
  return !card || !board.boards.some((v) => v.id === boardId) || !timestamp(now) ? board : replaceCard(board, { ...card, boardId, updatedAt: now });
}

export function dueState(card: BoardCard, today: string): 'none' | 'overdue' | 'today' | 'upcoming' {
  if (!card.dueDate || card.status === 'done' || !active(card) || !validDate(today)) return 'none';
  return card.dueDate < today ? 'overdue' : card.dueDate === today ? 'today' : 'upcoming';
}

export type CardFilter = {
  boardId: string; view: 'active' | 'archive' | 'trash'; query?: string;
  status?: BoardStatus | 'all'; label?: string; priority?: Priority | 'all'; due?: 'all' | 'overdue' | 'today' | 'upcoming';
};
function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function filterCards(board: BoardDocument, filter: CardFilter, today = localToday()): BoardCard[] {
  const query = filter.query?.trim().toLocaleLowerCase();
  return board.cards.filter((card) => card.boardId === filter.boardId
    && (filter.view === 'trash' ? card.deletedAt !== null : card.deletedAt === null && (filter.view === 'archive' ? card.archivedAt !== null : card.archivedAt === null))
    && (!filter.status || filter.status === 'all' || card.status === filter.status)
    && (!filter.label || card.labels.includes(filter.label))
    && (!filter.priority || filter.priority === 'all' || card.priority === filter.priority)
    && (!filter.due || filter.due === 'all' || dueState(card, today) === filter.due)
    && (!query || [card.title, card.notes, ...card.labels, ...card.checklist.map((v) => v.text), ...card.links.flatMap((v) => [v.title, v.url])].join('\n').toLocaleLowerCase().includes(query)));
}
