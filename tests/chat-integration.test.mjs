import assert from 'node:assert/strict';
import test from 'node:test';
import { cardPrompt, draftFromMessage, linkCurrentSession, startCardSession } from '../.test/chat-integration.mjs';

const card = (overrides = {}) => ({
  id: 'idea-1', boardId: 'board-1', title: 'Website überarbeiten', notes: 'Startseite vereinfachen',
  status: 'ideas', createdAt: 1, updatedAt: 1,
  checklist: [{ id: 'step-1', text: 'Entwurf prüfen', done: false }, { id: 'step-2', text: 'Recherche', done: true }],
  links: [{ id: 'link-1', title: 'Referenz', url: 'https://example.com/design' }],
  attachments: [{ id: 'image-1', name: 'PRIVATE_IMAGE', data: 'BINARY_SECRET' }],
  sessionLinks: [{ sessionId: 'PRIVATE_SESSION', title: 'PRIVATE_SESSION_TITLE', directory: '/private' }],
  ...overrides,
});

const message = (overrides = {}) => ({
  kind: 'message', action: 'collect-idea', sessionId: 'ses-1', sessionTitle: 'Quellchat',
  directory: '/project', messageId: 'msg-1', role: 'assistant', text: '# Eine Idee\n\nMit Details.',
  ...overrides,
});

function fakeHost(result = { sessionId: 'ses-new', directory: '/chosen', sent: 'sent', linked: true }) {
  const calls = [];
  return {
    calls,
    async startSession(payload) { calls.push(['startSession', payload]); return result; },
    async sessionLink(payload) { calls.push(['sessionLink', payload]); },
  };
}

test('prompt includes explicit text fields, excludes attachments and chat details, and is pure', () => {
  const input = card();
  const before = structuredClone(input);
  const prompt = cardPrompt(input);
  for (const expected of [input.title, input.notes, '- [ ] Entwurf prüfen', '- [x] Recherche', 'Referenz', 'https://example.com/design']) {
    assert.ok(prompt.includes(expected), expected);
  }
  for (const excluded of ['PRIVATE_IMAGE', 'BINARY_SECRET', 'PRIVATE_SESSION', '/private']) assert.ok(!prompt.includes(excluded));
  assert.ok(prompt.length <= 16_000);
  assert.deepEqual(input, before);
});

test('prompt caps oversized sections without losing checklist or link headings', () => {
  const prompt = cardPrompt(card({
    title: 'T'.repeat(20_000), notes: 'N'.repeat(30_000),
    checklist: [{ id: 'x', text: 'C'.repeat(30_000), done: false }],
    links: [{ title: 'L'.repeat(30_000), url: 'https://example.org/' }],
  }));
  assert.ok(prompt.length <= 16_000);
  assert.match(prompt, /gekürzt/);
  assert.match(prompt, /Checkliste:/);
  assert.match(prompt, /Links /);
});

test('prompt permits only safe HTTP(S) links and strips control characters', () => {
  const prompt = cardPrompt(card({ notes: 'Hello\u0000world', links: [
    { title: 'script', url: 'javascript:alert(1)' },
    { title: 'data', url: 'data:image/png;base64,PRIVATE' },
    { title: 'credentials', url: 'https://alice:SECRET@example.org/' },
    { title: 'invalid', url: 'not a url' },
    { title: 'plain', url: 'http://example.org/' },
  ] }));
  for (const excluded of ['\u0000', 'javascript:', 'base64', 'SECRET', 'not a url']) assert.ok(!prompt.includes(excluded));
  assert.match(prompt, /http:\/\/example.org\//);
});

test('collect-idea messages create an editable draft retaining provenance, without modifying input', () => {
  for (const role of ['assistant', 'user']) {
    const input = message({ role });
    const before = structuredClone(input);
    assert.deepEqual(draftFromMessage(input), {
      title: 'Eine Idee', notes: '# Eine Idee\n\nMit Details.',
      sessionLink: { sessionId: 'ses-1', title: 'Quellchat', directory: '/project' },
    });
    assert.deepEqual(input, before);
  }
});

test('draft rejects other actions, session items, attached chips, and empty messages', () => {
  for (const input of [message({ action: 'other' }), message({ kind: 'session' }),
    { providerId: 'ideenboard', id: '1', title: 'Chip', url: 'https://example.org' }, message({ text: ' \n\t' })]) {
    assert.equal(draftFromMessage(input), null);
  }
});

test('draft caps title and notes with clear notices, preserving valid emoji boundaries', () => {
  const draft = draftFromMessage(message({ text: '😀'.repeat(5_000), directory: null }));
  assert.ok(draft.title.length <= 120);
  assert.ok(draft.notes.length <= 6_000);
  assert.match(draft.title, /gekürzt/);
  assert.match(draft.notes, /Nachricht gekürzt/);
  assert.equal(draft.title.isWellFormed(), true);
  assert.equal(draft.notes.isWellFormed(), true);
  assert.equal(draft.sessionLink.directory, null);
});

test('start payload targets the explicit project without navigation, worktree, or model overrides', async () => {
  const host = fakeHost();
  const input = card({ id: 'space /?#' });
  const result = await startCardSession(host, input, 'project-2');
  assert.deepEqual(host.calls, [['startSession', {
    providerId: 'ideenboard', id: input.id, title: input.title,
    url: 'https://openchamber.dev/#ideenboard-space%20%2F%3F%23',
    text: cardPrompt(input), data: { cardId: input.id, boardId: input.boardId },
    projectId: 'project-2', navigation: 'preserve', worktree: false,
  }]]);
  assert.deepEqual(result.link, { sessionId: 'ses-new', title: input.title, directory: '/chosen' });
  assert.equal(result.sent, 'sent');
  assert.equal(result.uncertain, undefined);
});

test('default project is omitted and missing result directory becomes null', async () => {
  const host = fakeHost({ sessionId: 'ses-new', sent: 'sent' });
  const result = await startCardSession(host, card());
  assert.equal(Object.hasOwn(host.calls[0][1], 'projectId'), false);
  assert.equal(result.link.directory, null);
});

for (const sent of ['sent', 'failed', 'no-model', 'skipped']) {
  test(`created sessions survive ${sent} status and linked:false without retry`, async () => {
    const host = fakeHost({ sessionId: 'ses-existing', directory: '/p', sent, linked: false });
    const result = await startCardSession(host, card());
    assert.equal(result.link.sessionId, 'ses-existing');
    assert.equal(result.sent, sent);
    assert.match(result.message, /Warnung.*Kartenreferenz/);
    if (sent !== 'sent') assert.match(result.message, /Sitzung existiert.*nicht gesendet/);
    assert.equal(host.calls.length, 1);
  });
}

for (const failure of ['bootstrap-failed', 'session-create-failed']) {
  test(`partial worktree failure ${failure} does not retry or claim a session`, async () => {
    const host = fakeHost({ sessionId: null, sent: 'skipped', directory: '/retained-worktree',
      worktree: { directory: '/retained-worktree', name: 'retained', branch: 'retained', status: 'invalid' }, failure });
    const result = await startCardSession(host, card());
    assert.equal(result.link, null);
    assert.equal(result.sent, 'skipped');
    assert.match(result.message, /Worktree bleibt.*retained-worktree/);
    assert.match(result.message, /keine automatische Wiederholung/);
    assert.equal(host.calls.length, 1);
  });
}

for (const code of ['HOST_TIMEOUT', 'HOST_UNAVAILABLE', 'REQUEST_FAILED', undefined]) {
  test(`ambiguous ${code ?? 'unknown'} failure warns about a possibly created session`, async () => {
    let calls = 0;
    const host = { async startSession() { calls += 1; throw Object.assign(new Error('PRIVATE_ERROR'), { code }); } };
    const result = await startCardSession(host, card());
    assert.equal(result.link, null);
    assert.equal(result.uncertain, true);
    assert.match(result.message, /Sitzung existiert möglicherweise.*Sitzungsliste prüfen/);
    assert.ok(!result.message.includes('PRIVATE_ERROR'));
    assert.equal(calls, 1);
  });
}

for (const code of ['NOT_GRANTED', 'NO_DIRECTORY', 'NOT_FOUND', 'DISABLED', 'UNSUPPORTED', 'HOST_REJECTED', 'DENIED']) {
  test(`clear ${code} refusal returns a user message without a fabricated link`, async () => {
    let calls = 0;
    const result = await startCardSession({ async startSession() { calls += 1; throw { code }; } }, card());
    assert.equal(result.link, null);
    assert.equal(result.sent, 'skipped');
    assert.equal(result.uncertain, undefined);
    assert.ok(result.message.length > 20);
    assert.equal(calls, 1);
  });
}

test('linkCurrentSession awaits the host acknowledgement before returning a link', async () => {
  let finish;
  let payload;
  let settled = false;
  const host = { sessionLink(request) { payload = request; return new Promise((resolve) => { finish = resolve; }); } };
  const pending = linkCurrentSession(host, card(), { id: 'ses-current', title: 'Aktueller Chat' }, '/current')
    .then((link) => { settled = true; return link; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(payload.providerId, 'ideenboard');
  assert.equal(payload.id, 'idea-1');
  assert.deepEqual(payload.data, { cardId: 'idea-1', boardId: 'board-1' });
  assert.equal(payload.url, 'https://openchamber.dev/#ideenboard-idea-1');
  assert.equal(payload.text, cardPrompt(card()));
  finish();
  assert.deepEqual(await pending, { sessionId: 'ses-current', title: 'Aktueller Chat', directory: '/current' });
});

test('linkCurrentSession propagates refusal, never returns an unconfirmed link', async () => {
  const error = Object.assign(new Error('Not granted'), { code: 'NOT_GRANTED' });
  const host = { async sessionLink() { throw error; } };
  await assert.rejects(linkCurrentSession(host, card(), { id: 'ses-current', title: 'Chat' }, null), (received) => received === error);
});
