import { connectHost, GUEST_CLIPBOARD_TEXT_MAX, type GuestItem, type GuestProject, type SessionSnapshot } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import {
  addBoard, addCard, archiveCard, BACKUP_FORMAT, BACKUP_VERSION, bulkDeleteCards,
  COLUMNS, deleteCard, dueState, emptyBoard, filterCards, MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES, MAX_CARDS, MAX_NOTE_LENGTH, MAX_TITLE_LENGTH, MAX_LABELS,
  MAX_LABEL_LENGTH, MAX_CHECKLIST_ITEMS, MAX_LINKS, moveCard,
  parseBackup, parseBoard, permanentlyDeleteCards, renameBoard,
  replaceCard, restoreCard, safeHttpUrl, SAFE_STORAGE_LIMIT_BYTES, serializedBoardBytes,
  setFocus, type BoardCard, type BoardDocument, type BoardStatus, type CardAttachment,
  type Priority, type SessionLink,
} from './board-model';
import { createBoardStorage } from './board-storage';
import { draftFromMessage, linkCurrentSession, startCardSession } from './chat-integration';

const host = connectHost();
const repository = createBoardStorage(host.storage);
const app = document.querySelector<HTMLElement>('#app')!;
if (!app) throw new Error('Ideenboard konnte nicht gestartet werden.');

type View = 'active' | 'archive' | 'trash';
type Draft = { card: BoardCard; existing: boolean; focus: boolean; labels: string; checklist: string; links: string };
type Confirmation = { title: string; message: string; confirm: string; run: () => void };
type Filters = { query: string; status: string; label: string; priority: string; due: string };
const PRIORITIES: Record<Priority, string> = { low: 'Niedrig', normal: 'Normal', high: 'Hoch', urgent: 'Dringend' };

let documentState = emptyBoard();
let boardId = 'default';
let view: View = 'active';
let filters: Filters = { query: '', status: '', label: '', priority: '', due: 'all' };
let loadState: 'loading' | 'ready' | 'error' = 'loading';
let loadError = '';
let saveState: 'saved' | 'saving' | 'error' | 'not-saved' = 'not-saved';
let revision = 0;
let saveQueue: Promise<void> = Promise.resolve();
let loaded = false;
let banner: { message: string; tone: 'info' | 'success' | 'error' } | null = null;
let draft: Draft | null = null;
let editorError = '';
let readingAttachments = false;
let boardDialog: { mode: 'create' | 'rename'; name: string; error: string } | null = null;
let confirmation: Confirmation | null = null;
let importOpen = false;
let importText = '';
let importError = '';
let exportText: string | null = null;
let exportMessage = '';
let preview: CardAttachment | null = null;
let history: { state: BoardDocument; label: string }[] = [];
let draggedId: string | null = null;
let pendingMessage: GuestItem | null = null;
let handledMessage = '';
let currentSession: SessionSnapshot | null = null;
let directory: string | null = null;
let chatCardId: string | null = null;
let chatProjects: GuestProject[] = [];
let chatProjectId = '';
let chatError = '';
let chatLoading = false;
const startingCards = new Set<string>();
const uncertainStarts = new Set<string>();

const e = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));
const id = (): string => crypto.randomUUID?.() ?? `idea-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const currentBoard = () => documentState.boards.find((board) => board.id === boardId) ?? documentState.boards[0];
const cardById = (cardId: string) => documentState.cards.find((card) => card.id === cardId);
const activeCards = () => documentState.cards.filter((card) => card.boardId === boardId && card.deletedAt === null);
const today = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};
const saveLabel = () => ({ saved: 'Gespeichert', saving: 'Speichert …', error: 'Speichern fehlgeschlagen', 'not-saved': 'Noch nicht gespeichert' }[saveState]);
const button = (action: string, text: string, cardId = '', primary = false, disabled = false) => `<button type="button" class="button ${primary ? 'button--primary' : 'button--quiet'} button--small" data-action="${action}"${cardId ? ` data-card-id="${e(cardId)}"` : ''}${disabled ? ' disabled' : ''}>${text}</button>`;
const statusOptions = (value: string, all = false) => `${all ? '<option value="">Alle Status</option>' : ''}${COLUMNS.map((column) => `<option value="${column.id}"${value === column.id ? ' selected' : ''}>${column.label}</option>`).join('')}`;
const priorityOptions = (value: string, all = false) => `${all ? '<option value="">Alle Prioritäten</option>' : ''}${Object.entries(PRIORITIES).map(([key, label]) => `<option value="${key}"${value === key ? ' selected' : ''}>${label}</option>`).join('')}`;

function shownCards(): BoardCard[] {
  return filterCards(documentState, {
    boardId, view, query: filters.query, status: filters.status as BoardStatus || undefined,
    label: filters.label || undefined, priority: filters.priority as Priority || undefined,
    due: filters.due as 'all' | 'overdue' | 'today' | 'upcoming',
  }, today());
}

function renderCard(card: BoardCard): string {
  const focused = currentBoard().focusId === card.id;
  const due = dueState(card, today());
  const completed = card.checklist.filter((item) => item.done).length;
  const inTrash = card.deletedAt !== null;
  return `<article class="task-card${focused ? ' task-card--focused' : ''}" data-card-id="${e(card.id)}" ${view === 'active' ? 'draggable="true"' : ''}>
    <div class="task-card__eyebrow"><span class="status-dot status-dot--${COLUMNS.find((column) => column.id === card.status)!.tone}"></span><span>${COLUMNS.find((column) => column.id === card.status)!.label}</span>${focused ? '<span class="focus-chip">Aktuell</span>' : ''}${view === 'active' ? '<span class="drag-handle" aria-hidden="true" title="Karte ziehen">⠿</span>' : ''}</div>
    <h3>${e(card.title)}</h3>
    ${card.notes ? `<p class="task-card__notes">${e(card.notes)}</p>` : ''}
    <div class="card-tags"><span class="priority priority--${card.priority}">${PRIORITIES[card.priority]}</span>${card.labels.map((label) => `<span class="tag">${e(label)}</span>`).join('')}${card.dueDate ? `<span class="due due--${due}">${due === 'overdue' ? 'Überfällig · ' : due === 'today' ? 'Heute · ' : ''}${e(card.dueDate.split('-').reverse().join('.'))}</span>` : ''}</div>
    ${card.checklist.length ? `<div class="card-checklist"><span class="eyebrow">Schritte ${completed}/${card.checklist.length}</span>${card.checklist.map((item) => `<label><input type="checkbox" data-check-id="${e(item.id)}" data-card-id="${e(card.id)}"${item.done ? ' checked' : ''}${inTrash ? ' disabled' : ''}><span class="${item.done ? 'checked-text' : ''}">${e(item.text)}</span></label>`).join('')}</div>` : ''}
    ${card.links.length ? `<div class="card-links">${card.links.map((link) => `<button type="button" class="text-button" data-action="open-link" data-card-id="${e(card.id)}" data-link-id="${e(link.id)}">↗ ${e(link.title || link.url)}</button>`).join('')}</div>` : ''}
    ${card.attachments.length ? `<div class="card-links">${card.attachments.map((file) => `<button type="button" class="text-button" data-action="preview-file" data-card-id="${e(card.id)}" data-file-id="${e(file.id)}">▧ ${e(file.name)} (${Math.ceil(file.size / 1024)} KB)</button>`).join('')}</div>` : ''}
    ${card.sessionLinks.length ? `<div class="card-links">${card.sessionLinks.map((link) => `<button type="button" class="text-button" data-action="open-chat" data-card-id="${e(card.id)}" data-session-id="${e(link.sessionId)}">◉ ${e(link.title || 'Chat öffnen')}</button>`).join('')}</div>` : ''}
    <div class="task-card__controls">
      ${!inTrash && card.archivedAt === null ? `<select class="move-select" data-action="move" data-card-id="${e(card.id)}" aria-label="Status ändern: ${e(card.title)}">${statusOptions(card.status)}</select>` : ''}
      <div class="task-card__buttons">
        ${inTrash ? `${button('restore', 'Wiederherstellen', card.id)}${button('permanent-one', 'Endgültig löschen', card.id)}` : `${button('edit', 'Bearbeiten', card.id)}${view === 'active' ? button('focus', focused ? 'Fokus lösen' : 'Aktuell markieren', card.id) : ''}${button('archive', card.archivedAt === null ? 'Archivieren' : 'Aus Archiv holen', card.id)}${button('chat', 'Chat', card.id)}${button('delete', 'Löschen', card.id)}`}
      </div>
      ${view === 'active' ? `<div class="order-buttons">${button('up', '↑ Nach oben', card.id)}${button('down', '↓ Nach unten', card.id)}</div>` : ''}
    </div>
  </article>`;
}

function renderColumns(): string {
  const cards = shownCards();
  if (view !== 'active') return `<div class="collection-grid">${cards.length ? cards.map(renderCard).join('') : '<p class="empty-state">Hier liegen noch keine Karten.</p>'}</div>`;
  return `<div class="board-grid">${COLUMNS.map((column) => {
    const items = cards.filter((card) => card.status === column.id);
    return `<section class="board-column board-column--${column.tone}" data-drop-status="${column.id}" aria-labelledby="column-${column.id}">
      <header class="board-column__header"><div class="board-column__title-wrap"><span class="status-dot status-dot--${column.tone}"></span><h2 id="column-${column.id}">${column.label}</h2></div><span class="column-count">${items.length}</span></header>
      <div class="board-column__cards">${items.length ? items.map(renderCard).join('') : '<p class="column-empty">Karte hier ablegen</p>'}</div>
      ${column.id === 'ideas' ? '<button class="column-add" type="button" data-action="add">＋ Idee hinzufügen</button>' : ''}
    </section>`;
  }).join('')}</div>`;
}

function modal(title: string, body: string, actions = ''): string {
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="modal__header"><h2 id="dialog-title">${title}</h2><button class="icon-button" type="button" data-action="close-modal" aria-label="Schließen">×</button></div>${body}${actions ? `<div class="modal__actions">${actions}</div>` : ''}</section></div>`;
}

function renderEditor(): string {
  if (!draft) return '';
  const { card } = draft;
  return modal(draft.existing ? 'Idee bearbeiten' : 'Neue Idee', `<div class="editor-form">
    <label class="field"><span>Titel</span><input name="title" maxlength="${MAX_TITLE_LENGTH}" required value="${e(card.title)}" placeholder="Worum geht's?"></label>
    <label class="field"><span>Notiz (optional)</span><textarea name="notes" rows="4" maxlength="${MAX_NOTE_LENGTH}" placeholder="Gedanken und nächste Schritte …">${e(card.notes)}</textarea></label>
    <div class="field-row"><label class="field"><span>Board</span><select name="card-board" aria-label="Board der Karte">${documentState.boards.map((board) => `<option value="${e(board.id)}"${card.boardId === board.id ? ' selected' : ''}>${e(board.name)}</option>`).join('')}</select></label><label class="field"><span>Spalte</span><select name="status" aria-label="Spalte">${statusOptions(card.status)}</select></label></div>
    <div class="field-row"><label class="field"><span>Priorität</span><select name="priority" aria-label="Priorität">${priorityOptions(card.priority)}</select></label><label class="field"><span>Fällig am</span><input type="date" name="dueDate" value="${card.dueDate ?? ''}"></label></div>
    <label class="field"><span>Labels (durch Komma trennen)</span><input name="labels" value="${e(draft.labels)}" placeholder="Privat, Website, Später" maxlength="500"></label>
    <label class="field"><span>Checkliste (ein Schritt pro Zeile, [x] für erledigt)</span><textarea name="checklist" rows="3" maxlength="5000" placeholder="[ ] Entwurf erstellen\n[x] Idee notiert">${e(draft.checklist)}</textarea></label>
    <label class="field"><span>Links (eine Zeile je Link: Titel | https://…)</span><textarea name="links" rows="2" maxlength="6000" placeholder="Dokumentation | https://example.com">${e(draft.links)}</textarea></label>
    <div class="field"><span>Anhänge (Text oder PNG/JPEG/WebP, je max. ${MAX_ATTACHMENT_BYTES / 1024} KB)</span><input type="file" name="attachments" accept=".txt,.md,.json,.csv,.png,.jpg,.jpeg,.webp" multiple>${card.attachments.map((file) => `<div class="attachment-row"><span>${e(file.name)}</span><button type="button" class="text-button" data-action="remove-attachment" data-file-id="${e(file.id)}">Entfernen</button></div>`).join('')}</div>
    <label class="focus-checkbox"><input type="checkbox" name="focus"${draft.focus ? ' checked' : ''}><span><strong>Das ist mein aktuelles Thema</strong><small>Wird in „In Arbeit“ angezeigt.</small></span></label>
    ${readingAttachments ? '<p role="status">Anhänge werden eingelesen …</p>' : ''}
    ${editorError ? `<p class="inline-error" role="alert">${e(editorError)}</p>` : ''}
    </div>`, `${button('close-modal', 'Abbrechen')}${button('save-card', draft.existing ? 'Speichern' : 'Idee hinzufügen', '', true, readingAttachments)}`);
}

function renderChat(): string {
  const card = chatCardId ? cardById(chatCardId) : null;
  if (!card) return '';
  const busy = startingCards.has(card.id);
  return modal('Chat und Arbeitssitzung', `<p class="modal__copy">${e(card.title)}</p>
    <div class="card-links">${card.sessionLinks.map((link) => button('open-chat', `Chat öffnen: ${e(link.title)}`, card.id).replace('data-action="open-chat"', `data-action="open-chat" data-session-id="${e(link.sessionId)}"`)).join('')}</div>
    <p class="modal__copy">${currentSession ? `Aktueller Chat: ${e(currentSession.title)}` : 'Kein aktueller Chat geöffnet.'}</p>
    ${button('link-current', 'Aktuellen Chat verknüpfen', card.id, false, !currentSession || busy)}
    <hr class="dialog-divider"><h3>Neue Arbeitssitzung</h3>
    <p class="modal__copy">Startet einen neuen Chat und sendet den Titel, die Notiz, die Checkliste und Links als erste Nachricht. Anhänge werden nicht automatisch an das Modell gesendet.</p>
    <label class="field"><span>Projekt für die Arbeitssitzung</span><select name="chat-project" aria-label="Projekt für die Arbeitssitzung"${busy || chatLoading ? ' disabled' : ''}>${directory ? `<option value=""${chatProjectId === '' ? ' selected' : ''}>Aktuelles Projekt</option>` : '<option value="">Projekt auswählen …</option>'}${chatProjects.map((project) => `<option value="${e(project.id)}"${chatProjectId === project.id ? ' selected' : ''}>${e(project.name)}</option>`).join('')}</select></label>
    ${chatLoading ? '<p role="status">Projekte werden geladen …</p>' : ''}
    ${chatError ? `<p class="inline-error" role="status">${e(chatError)}</p>` : ''}
    ${uncertainStarts.has(card.id) ? '<p class="inline-error">Der Sitzungsstatus ist unklar. Bitte prüfe deine Sitzungen, bevor du erneut startest.</p>' : ''}
    <div class="modal__actions">${button('load-projects', 'Projekte neu laden', card.id, false, busy)}${button('start-session', busy ? 'Wird gestartet …' : 'Arbeitssitzung starten', card.id, true, busy || chatLoading || (!directory && !chatProjectId) || uncertainStarts.has(card.id))}</div>`);
}

function renderModal(): string {
  if (confirmation) return modal(e(confirmation.title), `<p class="modal__copy">${e(confirmation.message)}</p>`, `${button('cancel-confirmation', 'Abbrechen')}${button('confirm', e(confirmation.confirm), '', true)}`);
  if (preview) {
    const text = preview.mime.startsWith('image/') ? '' : decodeText(preview.base64);
    return modal(e(preview.name), preview.mime.startsWith('image/')
      ? `<img class="attachment-preview" alt="${e(preview.name)}" src="data:${e(preview.mime)};base64,${preview.base64}">`
      : `<label class="field"><span>Dateiinhalt</span><textarea name="file-preview" readonly rows="14">${e(text)}</textarea></label>`);
  }
  if (exportText !== null) return modal('Backup manuell kopieren', `<p class="modal__copy">${e(exportMessage)} Kopiere den gesamten Text mit Strg+C (Mac: ⌘C) und speichere ihn als .json-Datei.</p><label class="field"><span>Vollständiges Backup</span><textarea name="export-backup" rows="12" readonly>${e(exportText)}</textarea></label>`, button('select-backup', 'Alles markieren', '', true));
  if (importOpen) return modal('Board wiederherstellen', `<div class="editor-form"><p class="modal__copy">Ein Backup ersetzt alle Boards, einschließlich Archiv, Papierkorb und Anhängen. Alte Version-1-Backups werden übernommen.</p><label class="field"><span>Backup-Datei auswählen</span><input type="file" name="backup-file" accept=".json,application/json"></label><label class="field"><span>Backup-Inhalt</span><textarea name="backup" rows="9" placeholder="Backup-Text hier einfügen …">${e(importText)}</textarea></label>${importError ? `<p class="inline-error" role="alert">${e(importError)}</p>` : ''}</div>`, `${button('close-modal', 'Abbrechen')}${button('validate-import', 'Backup prüfen', '', true)}`);
  if (boardDialog) return modal(boardDialog.mode === 'create' ? 'Neues Board' : 'Board umbenennen', `<label class="field"><span>Boardname</span><input name="board-name" required maxlength="60" value="${e(boardDialog.name)}"></label>${boardDialog.error ? `<p class="inline-error" role="alert">${e(boardDialog.error)}</p>` : ''}`, `${button('close-modal', 'Abbrechen')}${button('save-board', 'Board speichern', '', true)}`);
  if (chatCardId) return renderChat();
  return renderEditor();
}

function render(): void {
  const activeElement = document.activeElement;
  const fieldName = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement || activeElement instanceof HTMLSelectElement ? activeElement.name : null;
  const selection = activeElement instanceof HTMLTextAreaElement || (activeElement instanceof HTMLInputElement && ['text', 'search'].includes(activeElement.type)) ? [activeElement.selectionStart, activeElement.selectionEnd] : null;
  if (loadState !== 'ready') {
    app.innerHTML = loadState === 'loading' ? '<main class="loading-screen"><span class="spinner"></span><p>Board wird geladen …</p></main>' : `<main class="load-error"><h1>Board konnte nicht geladen werden</h1><p>${e(loadError)}</p>${button('retry-load', 'Erneut versuchen', '', true)}<small>Vorhandene Daten werden nicht verändert.</small></main>`;
    return;
  }
  if (!documentState.boards.some((board) => board.id === boardId)) boardId = documentState.boards[0].id;
  const board = currentBoard();
  const focus = board.focusId ? cardById(board.focusId) : null;
  const available = activeCards();
  const archivedCount = available.filter((card) => card.archivedAt !== null).length;
  const doneCount = available.filter((card) => card.status === 'done').length;
  const trashCount = documentState.cards.filter((card) => card.boardId === boardId && card.deletedAt !== null).length;
  const labels = [...new Set(available.flatMap((card) => card.labels))].sort((a, b) => a.localeCompare(b, 'de'));
  app.innerHTML = `<main class="app-shell">
    <header class="topbar"><div class="brand"><div class="brand__mark" aria-hidden="true"><span></span><span></span><span></span></div><div><p class="eyebrow">Ideen sammeln · Arbeit organisieren</p><h1>Ideenboard</h1></div></div>
      <div class="topbar__actions"><span class="save-state save-state--${saveState}" data-save-state role="status">${saveLabel()}</span>${button('undo', '↶ Rückgängig', '', false, history.length === 0)}${button('backup-copy', 'Backup')}${button('add', '＋ Neue Idee', '', true, documentState.cards.length >= MAX_CARDS)}</div></header>
    ${banner ? `<div class="banner banner--${banner.tone}" role="status"><span>${e(banner.message)}</span>${saveState === 'error' ? button('retry-save', 'Erneut speichern') : ''}<button class="icon-button" type="button" data-action="dismiss-banner" aria-label="Meldung schließen">×</button></div>` : ''}
    <div class="board-switcher"><label class="field"><span>Aktuelles Board</span><select name="selected-board" aria-label="Aktuelles Board">${documentState.boards.map((item) => `<option value="${e(item.id)}"${item.id === boardId ? ' selected' : ''}>${e(item.name)}</option>`).join('')}</select></label>${button('create-board', '＋ Board')}${button('rename-board', 'Umbenennen')}</div>
    <section class="focus-section" aria-labelledby="focus-heading"><div class="section-heading"><div><p class="eyebrow">Dein nächster Schritt</p><h2 id="focus-heading">Gerade in Arbeit</h2></div></div>${focus ? `<article class="focus-card"><div class="focus-card__icon">✦</div><div class="focus-card__content"><span class="focus-card__label">Aktuelles Thema · ${e(board.name)}</span><h3>${e(focus.title)}</h3>${focus.notes ? `<p>${e(focus.notes)}</p>` : ''}</div>${button('edit', 'Bearbeiten', focus.id)}${button('focus', 'Fokus lösen', focus.id)}</article>` : '<div class="focus-empty"><div class="focus-empty__icon">✦</div><div><strong>Noch kein aktuelles Thema</strong><p>Markiere eine Karte als aktuell, damit sie hier erscheint.</p></div></div>'}</section>
    <section class="board-section" aria-label="Kanban-Board"><div class="board-heading"><h2>${e(board.name)} <span>${shownCards().length}</span></h2>${button('import-open', 'Backup wiederherstellen')}</div>
      <nav class="view-tabs" aria-label="Kartenansicht">${(['active', 'archive', 'trash'] as const).map((mode) => `<button type="button" data-action="view" data-view="${mode}" aria-pressed="${view === mode}">${mode === 'active' ? 'Board' : mode === 'archive' ? `Archiv (${archivedCount})` : `Papierkorb (${trashCount})`}</button>`).join('')}</nav>
      <div class="filter-toolbar"><input name="query" type="search" aria-label="Karten durchsuchen" placeholder="Titel, Notizen, Schritte durchsuchen …" value="${e(filters.query)}"><select name="filter-status" aria-label="Status filtern">${statusOptions(filters.status, true)}</select><select name="filter-label" aria-label="Label filtern"><option value="">Alle Labels</option>${labels.map((label) => `<option${filters.label === label ? ' selected' : ''} value="${e(label)}">${e(label)}</option>`).join('')}</select><select name="filter-priority" aria-label="Priorität filtern">${priorityOptions(filters.priority, true)}</select><select name="filter-due" aria-label="Fälligkeit filtern">${[['all', 'Alle Termine'], ['overdue', 'Überfällig'], ['today', 'Heute fällig'], ['upcoming', 'Später fällig']].map(([value, label]) => `<option value="${value}"${filters.due === value ? ' selected' : ''}>${label}</option>`).join('')}</select>${button('reset-filters', 'Filter zurücksetzen')}</div>
      <div class="bulk-tools" aria-label="Sammelaktionen"><span>Ganzes Board, unabhängig von Filtern:</span>${button('bulk-done', `Alle Erledigten löschen (${doneCount})`, '', false, doneCount === 0)}${button('bulk-archive', `Alle Archivierten löschen (${archivedCount})`, '', false, archivedCount === 0)}${button('bulk-both', 'Erledigte + Archivierte löschen', '', false, doneCount + archivedCount === 0)}${button('empty-trash', `Papierkorb leeren (${trashCount})`, '', false, trashCount === 0)}</div>
      ${renderColumns()}
    </section><footer class="footer-note"><span>Server-Speicher · ${Math.ceil(serializedBoardBytes(documentState) / 1024)} / ${SAFE_STORAGE_LIMIT_BYTES / 1024} KB · Keine externen Dienste</span><span>Vor ZIP-Updates: ${button('backup-copy', 'Backup kopieren')}</span></footer>
    </main>${renderModal()}`;
  const dialog = app.querySelector<HTMLElement>('[role="dialog"]');
  app.querySelector<HTMLElement>('.app-shell')!.inert = dialog !== null;
  const field = fieldName ? Array.from(app.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('[name]')).find((element) => element.name === fieldName && (!dialog || dialog.contains(element))) : null;
  if (field) {
    field.focus();
    if (selection && selection[0] !== null && selection[1] !== null && (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)) field.setSelectionRange(selection[0], selection[1]);
  } else if (dialog) (dialog.querySelector<HTMLElement>('input:not([type="file"]), textarea, button'))?.focus();
}

function notify(message: string, tone: 'info' | 'success' | 'error' = 'info'): void {
  banner = { message, tone }; render();
}

function queueSave(): void {
  const snapshot = structuredClone(documentState);
  const savedRevision = revision;
  saveState = 'saving';
  const updateLabel = () => {
    const label = app.querySelector<HTMLElement>('[data-save-state]');
    if (label) { label.textContent = saveLabel(); label.className = `save-state save-state--${saveState}`; }
  };
  updateLabel();
  saveQueue = saveQueue.catch(() => undefined).then(async () => {
    await repository.save(snapshot);
    if (revision === savedRevision) {
      saveState = 'saved';
      if (banner?.tone === 'error') { banner = null; app.querySelector('.banner')?.remove(); }
      updateLabel();
    }
  }).catch((error: unknown) => {
    if (revision !== savedRevision) return;
    saveState = 'error';
    notify(`Speichern fehlgeschlagen: ${error instanceof Error ? error.message : 'Speicher nicht erreichbar'}. Vor dem Schließen Backup kopieren.`, 'error');
  });
}

function commit(next: BoardDocument, label: string, record = true): boolean {
  const validated = parseBoard(next);
  const error = !validated ? 'Die Eingaben sind ungültig oder überschreiten die erlaubten Grenzen.' : serializedBoardBytes(validated) > SAFE_STORAGE_LIMIT_BYTES ? 'Der Speicher ist voll. Bitte Anhänge oder Karten entfernen und den Papierkorb leeren.' : '';
  if (error) { if (draft) { editorError = error; render(); } else notify(error, 'error'); return false; }
  if (record) history = [...history.slice(-9), { state: documentState, label }];
  documentState = validated!;
  revision++;
  banner = null;
  saveState = 'saving';
  render(); queueSave(); return true;
}

async function load(): Promise<void> {
  loadState = 'loading'; render();
  try {
    documentState = await repository.load();
    loadState = 'ready'; saveState = 'saved'; render();
    if (pendingMessage) collectMessage(pendingMessage);
  } catch (error) {
    loadState = 'error'; loadError = error instanceof Error ? error.message : 'Speicher nicht erreichbar'; render();
  }
}

function newCard(): BoardCard {
  return { id: id(), boardId, title: '', notes: '', status: 'ideas', createdAt: Date.now(), updatedAt: Date.now(), labels: [], priority: 'normal', dueDate: null, checklist: [], links: [], attachments: [], sessionLinks: [], archivedAt: null, deletedAt: null };
}

function openEditor(card?: BoardCard): void {
  const value = structuredClone(card ?? newCard());
  draft = { card: value, existing: Boolean(card), focus: Boolean(card && documentState.boards.find((board) => board.id === card.boardId)?.focusId === card.id), labels: value.labels.join(', '), checklist: value.checklist.map((item) => `[${item.done ? 'x' : ' '}] ${item.text}`).join('\n'), links: value.links.map((link) => `${link.title} | ${link.url}`).join('\n') };
  editorError = ''; render(); app.querySelector<HTMLInputElement>('[name="title"]')?.focus();
}

function saveCard(): void {
  if (!draft || readingAttachments) return;
  const required = app.querySelector<HTMLInputElement>('input[name="title"]');
  if (required && !required.reportValidity()) return;
  try {
    const labels = [...new Set(draft.labels.split(',').map((label) => label.trim()).filter(Boolean))];
    if (labels.length > MAX_LABELS || labels.some((label) => label.length > MAX_LABEL_LENGTH)) throw new Error(`Maximal ${MAX_LABELS} Labels mit je ${MAX_LABEL_LENGTH} Zeichen.`);
    const checklist = draft.checklist.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const text = line.replace(/^\[[ xX]\]\s*/, '').trim();
      const previous = draft!.card.checklist[index];
      return { id: previous?.id ?? id(), text, done: /^\[[xX]\]/.test(line) };
    });
    const links = draft.links.split('\n').map((line) => line.trim()).filter(Boolean).map((line, index) => {
      const separator = line.indexOf('|');
      const title = separator >= 0 ? line.slice(0, separator).trim() : line;
      const url = safeHttpUrl(separator >= 0 ? line.slice(separator + 1).trim() : line);
      if (!url) throw new Error('Links müssen gültige http://- oder https://-Adressen sein.');
      return { id: draft!.card.links[index]?.id ?? id(), title, url };
    });
    if (checklist.length > MAX_CHECKLIST_ITEMS || checklist.some((item) => item.text.length > 500 || !item.text)) throw new Error(`Maximal ${MAX_CHECKLIST_ITEMS} Schritte mit je 1–500 Zeichen.`);
    if (links.length > MAX_LINKS || links.some((link) => link.title.length > MAX_TITLE_LENGTH)) throw new Error(`Maximal ${MAX_LINKS} Links mit je ${MAX_TITLE_LENGTH} Zeichen im Titel.`);
    const card = { ...draft.card, title: draft.card.title.trim(), notes: draft.card.notes.trim(), labels, checklist, links, updatedAt: Date.now() };
    if (!card.title) throw new Error('Bitte gib der Idee einen Titel.');
    let next = draft.existing ? replaceCard(documentState, card) : addCard(documentState, card);
    if (next === documentState) throw new Error(`Karte konnte nicht gespeichert werden. Bitte Eingaben, Speichergrenze und maximal ${MAX_CARDS} Karten (einschließlich Papierkorb) prüfen.`);
    if (draft.focus) next = setFocus(next, card.id);
    else if (documentState.boards.some((board) => board.focusId === card.id)) next = setFocus(next, null, Date.now(), card.boardId);
    if (commit(next, 'Karte bearbeiten')) {
      if (boardId !== card.boardId) filters = { query: '', status: '', label: '', priority: '', due: 'all' };
      boardId = card.boardId; draft = null; editorError = ''; view = card.archivedAt === null ? 'active' : 'archive'; render();
    }
  } catch (error) { editorError = error instanceof Error ? error.message : 'Eingaben prüfen'; render(); }
}

function closeModal(): void {
  readingAttachments = false;
  confirmation = null; draft = null; editorError = ''; boardDialog = null; importOpen = false; importText = ''; importError = ''; exportText = null; preview = null; chatCardId = null;
  render(); app.querySelector<HTMLElement>('[data-action="add"]')?.focus();
}

function ask(title: string, message: string, confirm: string, run: () => void): void {
  confirmation = { title, message, confirm, run }; render();
}

function requestBulk(scope: 'done' | 'archived' | 'done-or-archived'): void {
  const targetBoardId = boardId;
  const matches = activeCards().filter((card) => scope === 'done' ? card.status === 'done' : scope === 'archived' ? card.archivedAt !== null : card.status === 'done' || card.archivedAt !== null);
  if (!matches.length) return;
  ask('Karten gesammelt löschen?', `${matches.length} Karten aus „${currentBoard().name}“ werden in den Papierkorb verschoben. Suchfilter werden nicht berücksichtigt. Andere Boards bleiben unverändert.`, `${matches.length} Karten löschen`, () => {
    commit(bulkDeleteCards(documentState, targetBoardId, scope), 'Sammellöschen');
  });
}

function requestPermanent(card?: BoardCard): void {
  const targetBoardId = boardId;
  const count = card ? 1 : documentState.cards.filter((item) => item.boardId === boardId && item.deletedAt !== null).length;
  if (!count) return;
  ask(card ? 'Karte endgültig löschen?' : 'Papierkorb endgültig leeren?', `${count} Karte(n) aus „${currentBoard().name}“ inklusive Anhängen werden endgültig gelöscht. Das lässt sich nicht rückgängig machen. Andere Boards bleiben unverändert.`, 'Endgültig löschen', () => {
    if (commit(permanentlyDeleteCards(documentState, targetBoardId, card ? [card.id] : undefined), 'Endgültig löschen', false)) { history = []; render(); }
  });
}

function backup(): string {
  return JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), board: documentState });
}

async function exportBackup(): Promise<void> {
  const text = backup();
  const manual = (message: string) => { exportText = text; exportMessage = message; render(); };
  if (text.length > GUEST_CLIPBOARD_TEXT_MAX) return manual('Das Backup ist zu groß für die automatische Zwischenablage.');
  try { await host.writeClipboard(text); notify('Backup kopiert. Bitte lokal als .json-Datei speichern.', 'success'); }
  catch { manual('Die automatische Zwischenablage ist nicht verfügbar.'); }
}

function validateImport(): void {
  try {
    const parsed = parseBackup(JSON.parse(importText));
    if (!parsed) throw new Error('Das ist kein gültiges Ideenboard-Backup.');
    if (serializedBoardBytes(parsed) > SAFE_STORAGE_LIMIT_BYTES) throw new Error('Das Backup ist zu groß.');
    ask('Alle Boards ersetzen?', `${parsed.boards.length} Board(s) und ${parsed.cards.length} Karten werden übernommen. Alle derzeitigen Boards, Anhänge und der Papierkorb werden ersetzt. Bitte vorher ein Backup sichern.`, 'Backup wiederherstellen', () => {
      if (commit(parsed, 'Backup wiederherstellen', false)) { history = []; importOpen = false; importText = ''; importError = ''; boardId = parsed.boards[0].id; view = 'active'; render(); }
    });
  } catch (error) { importError = error instanceof Error ? error.message : 'Backup nicht lesbar'; render(); }
}

const decodeText = (base64: string): string => new TextDecoder().decode(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
async function readAttachments(files: FileList): Promise<void> {
  const currentDraft = draft;
  if (!currentDraft || readingAttachments) return;
  readingAttachments = true; render();
  try {
    const additions: CardAttachment[] = [];
    if (currentDraft.card.attachments.length + files.length > MAX_ATTACHMENTS) throw new Error(`Höchstens ${MAX_ATTACHMENTS} Anhänge pro Karte.`);
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name}: maximal ${MAX_ATTACHMENT_BYTES / 1024} KB pro Datei.`);
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      const mime = ({ txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[extension];
      if (!mime) throw new Error('Unterstützt werden TXT, MD, JSON, CSV, PNG, JPEG und WebP.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Spread only bounded chunks to avoid argument-limit exceptions.
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      additions.push({ id: id(), name: file.name, mime, base64: btoa(binary), size: file.size });
    }
    if (draft !== currentDraft) return;
    draft.card.attachments.push(...additions); editorError = '';
  } catch (error) { if (draft === currentDraft) editorError = error instanceof Error ? error.message : 'Datei nicht lesbar'; }
  finally { if (draft === currentDraft) { readingAttachments = false; render(); } }
}

async function loadProjects(): Promise<void> {
  chatLoading = true; chatError = ''; render();
  try {
    const snapshot = await host.listProjects();
    if (snapshot.state !== 'ready') throw new Error('Projektliste ist noch nicht verfügbar. Bitte erneut laden.');
    chatProjects = snapshot.projects;
    if (chatProjectId && !chatProjects.some((project) => project.id === chatProjectId)) chatProjectId = '';
  } catch (error) { chatError = error instanceof Error ? error.message : 'Projekte nicht erreichbar'; }
  finally { chatLoading = false; render(); }
}

function saveSessionLink(cardId: string, link: SessionLink): boolean {
  const card = cardById(cardId);
  if (!card) return false;
  const sessionLinks = [...card.sessionLinks.filter((item) => item.sessionId !== link.sessionId), link].slice(-5);
  return commit(replaceCard(documentState, { ...card, sessionLinks, updatedAt: Date.now() }), 'Chat verknüpfen');
}

async function linkChat(cardId: string): Promise<void> {
  const card = cardById(cardId);
  if (!card || !currentSession) return;
  try {
    const link = await linkCurrentSession(host, card, currentSession, directory);
    saveSessionLink(cardId, link);
    chatError = ''; render();
  } catch (error) { chatError = error instanceof Error ? error.message : 'Chat nicht verknüpft'; render(); }
}

async function startSession(cardId: string): Promise<void> {
  const card = cardById(cardId);
  if (!card || startingCards.has(cardId) || uncertainStarts.has(cardId) || (!directory && !chatProjectId)) return;
  startingCards.add(cardId); chatError = ''; render();
  try {
    const outcome = await startCardSession(host, card, chatProjectId || undefined);
    if (outcome.link && !saveSessionLink(cardId, outcome.link)) throw new Error('Sitzung wurde erstellt, aber der Karten-Speicher ist voll. Öffne sie über die Sitzungsliste.');
    if (outcome.uncertain) uncertainStarts.add(cardId);
    chatError = outcome.message;
  } catch (error) { chatError = error instanceof Error ? error.message : 'Sitzung konnte nicht gestartet werden'; }
  finally { startingCards.delete(cardId); render(); }
}

function collectMessage(item: GuestItem): void {
  const source = draftFromMessage(item);
  if (!source || item.kind !== 'message') return;
  if (loadState !== 'ready') { pendingMessage = item; return; }
  const key = `${item.sessionId}:${item.messageId}`;
  if (handledMessage === key) return;
  const collect = () => {
    handledMessage = key; pendingMessage = null;
    openEditor();
    draft!.card.title = source.title; draft!.card.notes = source.notes; draft!.card.sessionLinks = [source.sessionLink];
    render();
  };
  if (draft) ask('Entwurf ersetzen?', 'Es gibt einen ungespeicherten Entwurf. Diesen durch die ausgewählte Chat-Nachricht ersetzen?', 'Entwurf ersetzen', collect);
  else collect();
}

app.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const trigger = target?.closest<HTMLElement>('[data-action]');
  if (!trigger || trigger instanceof HTMLButtonElement && trigger.disabled) return;
  const action = trigger.dataset.action;
  const card = trigger.dataset.cardId ? cardById(trigger.dataset.cardId) : null;
  switch (action) {
    case 'add': if (documentState.cards.length < MAX_CARDS) openEditor(); break;
    case 'edit': if (card) openEditor(card); break;
    case 'save-card': saveCard(); break;
    case 'close-modal': closeModal(); break;
    case 'cancel-confirmation': confirmation = null; render(); break;
    case 'confirm': { const execute = confirmation?.run; confirmation = null; execute?.(); render(); break; }
    case 'focus': if (card) commit(setFocus(documentState, currentBoard().focusId === card.id ? null : card.id, Date.now(), boardId), 'Fokus ändern'); break;
    case 'archive': if (card) commit(archiveCard(documentState, card.id, card.archivedAt === null), 'Archiv ändern'); break;
    case 'delete': if (card) ask('Karte löschen?', `„${card.title}“ wird in den Papierkorb verschoben.`, 'Löschen', () => commit(deleteCard(documentState, card.id), 'Karte löschen')); break;
    case 'restore': if (card) commit(restoreCard(documentState, card.id), 'Karte wiederherstellen'); break;
    case 'permanent-one': if (card) requestPermanent(card); break;
    case 'bulk-done': requestBulk('done'); break;
    case 'bulk-archive': requestBulk('archived'); break;
    case 'bulk-both': requestBulk('done-or-archived'); break;
    case 'empty-trash': requestPermanent(); break;
    case 'undo': { const previous = history.pop(); if (previous && commit(previous.state, 'Rückgängig', false)) notify(`Rückgängig: ${previous.label}`); break; }
    case 'view': view = trigger.dataset.view as View; render(); break;
    case 'reset-filters': filters = { query: '', status: '', label: '', priority: '', due: 'all' }; render(); break;
    case 'create-board': boardDialog = { mode: 'create', name: '', error: '' }; render(); break;
    case 'rename-board': boardDialog = { mode: 'rename', name: currentBoard().name, error: '' }; render(); break;
    case 'save-board': {
      if (!boardDialog) break;
      const name = boardDialog.name.trim();
      if (!name) { boardDialog.error = 'Bitte einen Namen eingeben.'; render(); break; }
      const newId = boardDialog.mode === 'create' ? id() : boardId;
      const next = boardDialog.mode === 'create' ? addBoard(documentState, newId, name) : renameBoard(documentState, boardId, name);
      if (next === documentState) { boardDialog.error = 'Board konnte nicht angelegt werden. Bitte Grenzen und Namen prüfen.'; render(); break; }
      if (commit(next, 'Board bearbeiten')) { boardId = newId; boardDialog = null; view = 'active'; filters = { query: '', status: '', label: '', priority: '', due: 'all' }; render(); }
      break;
    }
    case 'up': case 'down': {
      if (!card) break;
      const group = documentState.cards.filter((item) => item.boardId === boardId && item.status === card.status && item.archivedAt === null && item.deletedAt === null);
      const index = group.findIndex((item) => item.id === card.id);
      if (action === 'up' && index > 0) commit(moveCard(documentState, card.id, card.status, Date.now(), group[index - 1].id), 'Karte sortieren');
      if (action === 'down' && index < group.length - 1) commit(moveCard(documentState, card.id, card.status, Date.now(), group[index + 2]?.id ?? null), 'Karte sortieren');
      break;
    }
    case 'remove-attachment': if (draft) { draft.card.attachments = draft.card.attachments.filter((file) => file.id !== trigger.dataset.fileId); render(); } break;
    case 'preview-file': if (card) { preview = card.attachments.find((file) => file.id === trigger.dataset.fileId) ?? null; render(); } break;
    case 'open-link': { const link = card?.links.find((item) => item.id === trigger.dataset.linkId); if (link && safeHttpUrl(link.url)) void host.openUrl(link.url).catch((error: Error) => notify(error.message, 'error')); break; }
    case 'backup-copy': void exportBackup(); break;
    case 'select-backup': app.querySelector<HTMLTextAreaElement>('[name="export-backup"]')?.select(); break;
    case 'import-open': importOpen = true; importText = ''; importError = ''; render(); break;
    case 'validate-import': validateImport(); break;
    case 'dismiss-banner': banner = null; render(); break;
    case 'retry-save': queueSave(); break;
    case 'retry-load': void load(); break;
    case 'chat': if (card) { chatCardId = card.id; chatError = ''; chatProjectId = ''; render(); void loadProjects(); } break;
    case 'load-projects': void loadProjects(); break;
    case 'link-current': if (card) void linkChat(card.id); break;
    case 'start-session':
      if (card && card.sessionLinks.length) ask('Weitere Arbeitssitzung starten?', 'Mit dieser Karte ist bereits ein Chat verknüpft. Bei fehlendem Modell oder einer ungesendeten Nachricht kannst du im vorhandenen Chat fortfahren. Nur bestätigen, wenn du bewusst einen zusätzlichen Chat möchtest.', 'Trotzdem neue Sitzung', () => { void startSession(card.id); });
      else if (card) void startSession(card.id);
      break;
    case 'open-chat': if (trigger.dataset.sessionId && card?.sessionLinks.some((link) => link.sessionId === trigger.dataset.sessionId)) void host.openSession(trigger.dataset.sessionId).catch((error: Error) => notify(`Chat nicht erreichbar: ${error.message}`, 'error')); break;
  }
});

app.addEventListener('input', (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) return;
  switch (field.name) {
    case 'query': filters.query = field.value; render(); break;
    case 'title': if (draft) draft.card.title = field.value; break;
    case 'notes': if (draft) draft.card.notes = field.value; break;
    case 'labels': if (draft) draft.labels = field.value; break;
    case 'checklist': if (draft) draft.checklist = field.value; break;
    case 'links': if (draft) draft.links = field.value; break;
    case 'dueDate': if (draft) draft.card.dueDate = field.value || null; break;
    case 'board-name': if (boardDialog) boardDialog.name = field.value; break;
    case 'backup': importText = field.value; break;
  }
});

app.addEventListener('change', (event) => {
  const field = event.target;
  if (!(field instanceof HTMLSelectElement || field instanceof HTMLInputElement)) return;
  if (field.dataset.checkId && field.dataset.cardId && field instanceof HTMLInputElement) {
    const card = cardById(field.dataset.cardId);
    if (card && card.deletedAt === null) commit(replaceCard(documentState, { ...card, checklist: card.checklist.map((item) => item.id === field.dataset.checkId ? { ...item, done: field.checked } : item), updatedAt: Date.now() }), 'Schritt abhaken');
    return;
  }
  if (field.dataset.action === 'move' && field.dataset.cardId) { commit(moveCard(documentState, field.dataset.cardId, field.value as BoardStatus), 'Karte verschieben'); return; }
  if (field.name === 'selected-board') { boardId = field.value; filters = { query: '', status: '', label: '', priority: '', due: 'all' }; render(); }
  if (field.name === 'filter-status') { filters.status = field.value; render(); }
  if (field.name === 'filter-label') { filters.label = field.value; render(); }
  if (field.name === 'filter-priority') { filters.priority = field.value; render(); }
  if (field.name === 'filter-due') { filters.due = field.value; render(); }
  if (field.name === 'chat-project') { chatProjectId = field.value; render(); }
  if (draft) {
    if (field.name === 'priority') draft.card.priority = field.value as Priority;
    if (field.name === 'card-board') draft.card.boardId = field.value;
    if (field.name === 'status') { draft.card.status = field.value as BoardStatus; if (field.value !== 'in-progress') { draft.focus = false; const focus = app.querySelector<HTMLInputElement>('[name="focus"]'); if (focus) focus.checked = false; } }
    if (field.name === 'focus' && field instanceof HTMLInputElement) { draft.focus = field.checked; if (field.checked) { draft.card.status = 'in-progress'; const select = app.querySelector<HTMLSelectElement>('[name="status"]'); if (select) select.value = 'in-progress'; } }
    if (field.name === 'attachments' && field instanceof HTMLInputElement && field.files) void readAttachments(field.files);
  }
  if (field.name === 'backup-file' && field instanceof HTMLInputElement && field.files?.[0]) {
    const file = field.files[0];
    if (file.size > SAFE_STORAGE_LIMIT_BYTES * 2) { importError = 'Backup-Datei ist zu groß.'; render(); }
    else void file.text().then((text) => { if (importOpen) { importText = text; render(); } }).catch(() => { importError = 'Backup-Datei konnte nicht gelesen werden.'; render(); });
  }
});

app.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  const target = event.target;
  if (event.key === 'Enter' && target instanceof HTMLInputElement && target.name === 'title') { event.preventDefault(); saveCard(); }
  if (event.key === 'Enter' && target instanceof HTMLInputElement && target.name === 'board-name') { event.preventDefault(); app.querySelector<HTMLButtonElement>('[data-action="save-board"]')?.click(); }
  if (event.key === 'Escape' && app.querySelector('[role="dialog"]')) { event.preventDefault(); if (confirmation) { confirmation = null; render(); } else closeModal(); }
  if (event.key === 'Tab') {
    const dialog = app.querySelector('[role="dialog"]');
    const fields = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select:not(:disabled)');
    if (!fields?.length) return;
    const first = fields[0]; const last = fields[fields.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});

app.addEventListener('dragstart', (event) => {
  const card = event.target instanceof Element ? event.target.closest<HTMLElement>('.task-card[draggable]') : null;
  if (!card || !event.dataTransfer) return;
  draggedId = card.dataset.cardId ?? null;
  if (!draggedId) return;
  event.dataTransfer.setData('text/plain', draggedId); event.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging');
});
app.addEventListener('dragover', (event) => {
  const column = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-drop-status]') : null;
  if (column && draggedId) { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'; app.querySelector('.drop-target')?.classList.remove('drop-target'); column.classList.add('drop-target'); }
});
app.addEventListener('drop', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const column = target?.closest<HTMLElement>('[data-drop-status]');
  const card = draggedId ? cardById(draggedId) : null;
  if (!column || !card || card.boardId !== boardId || card.deletedAt !== null || card.archivedAt !== null) return;
  event.preventDefault();
  const targetCard = target?.closest<HTMLElement>('.task-card');
  let beforeId: string | null = targetCard?.dataset.cardId ?? null;
  if (targetCard && beforeId !== card.id) {
    const rectangle = targetCard.getBoundingClientRect();
    if (event.clientY > rectangle.top + rectangle.height / 2) {
      const cards = documentState.cards.filter((item) => item.boardId === boardId && item.status === column.dataset.dropStatus && item.archivedAt === null && item.deletedAt === null && item.id !== card.id);
      beforeId = cards[cards.findIndex((item) => item.id === targetCard.dataset.cardId) + 1]?.id ?? null;
    }
  }
  const movingId = card.id; draggedId = null;
  if (beforeId !== movingId) commit(moveCard(documentState, movingId, column.dataset.dropStatus as BoardStatus, Date.now(), beforeId), 'Karte ziehen');
});
app.addEventListener('dragend', () => { draggedId = null; app.querySelectorAll('.dragging, .drop-target').forEach((element) => element.classList.remove('dragging', 'drop-target')); });

host.onReady((context) => {
  applyHostReady(context, document.documentElement); directory = context.directory;
  if (!loaded) { loaded = true; void load(); }
});
host.onSession((session) => { currentSession = session; if (chatCardId && loadState === 'ready') render(); });
host.onDirectory((value) => { directory = value; });
host.onItem((item) => { if (item) collectMessage(item); });
window.addEventListener('beforeunload', () => host.dispose(), { once: true });
