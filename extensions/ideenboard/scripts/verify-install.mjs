// Optional local integration check against an installed OpenChamber server package.
// All installation and storage writes stay inside a new isolated cache directory.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const webRoot = process.env.OPENCHAMBER_WEB_DIR;
if (!webRoot) throw new Error('OPENCHAMBER_WEB_DIR must point to the installed @openchamber/web package.');
const load = (name) => import(pathToFileURL(join(webRoot, 'server/lib/guests', `${name}.js`)));
const { installGuestFromZipBuffer } = await load('install');
const { inspectGuestPackage, listInstalledGuests } = await load('catalog');
const { runGuestStorage } = await load('storage');
const { setCapabilityGrants } = await load('persist');
const { guestGrantScope } = await load('grant-scope');
const { createBoardStorage, INDEX_KEY } = await import('../.test/board-storage.mjs');
const webManifest = JSON.parse(await readFile(join(webRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const zip = await readFile(new URL(`../dist/openchamber-ideenboard-${manifest.version}.zip`, import.meta.url));
const cache = join(homedir(), '.cache/openchamber/tmp/opencode');
await mkdir(cache, { recursive: true });
const directory = await mkdtemp(join(cache, 'ideenboard-verification-'));
const persistPath = join(directory, 'extensions.json');
const installed = await installGuestFromZipBuffer(zip, persistPath, { openchamberVersion: webManifest.version });
assert.equal(installed.ok, true, JSON.stringify(installed));
const [guest] = await listInstalledGuests({ persistPath });
assert.equal(guest.id, 'ideenboard');
assert.equal(guest.version, manifest.version);
assert.equal((await inspectGuestPackage(guest.packageRoot, { openchamberVersion: webManifest.version })).ok, true);
// Grant only the isolated test installation, never the live extension.
assert.deepEqual(guest.capabilities, ['sessions', 'prompt']);
await setCapabilityGrants(guest.id, persistPath, ['sessions', 'prompt'], guestGrantScope(guest));
const authorize = async () => {
  const [current] = await listInstalledGuests({ persistPath });
  assert.equal(current.id, guest.id);
  assert.notEqual(current.enabled, false);
};
const board = { schemaVersion: 1, focusId: 'test-idea', cards: [{
  id: 'test-idea', title: 'Isolierter Speichertest', notes: 'Keine Nutzerdaten',
  status: 'in-progress', createdAt: 1, updatedAt: 1,
}] };
await runGuestStorage(persistPath, guest.id, { op: 'set', key: 'ideenboard-v1', value: board }, authorize);
const read = await runGuestStorage(persistPath, guest.id, { op: 'get', key: 'ideenboard-v1' }, authorize);
assert.deepEqual(read.value, board);
const disk = JSON.parse(await readFile(join(directory, 'guest-storage/ideenboard.json'), 'utf8'));
assert.deepEqual(disk['ideenboard-v1'], board);
const storage = {
  get: async (key) => {
    const answer = await runGuestStorage(persistPath, guest.id, { op: 'get', key }, authorize);
    return answer.found ? answer.value : undefined;
  },
  set: async (key, value) => { await runGuestStorage(persistPath, guest.id, { op: 'set', key, value }, authorize); },
  delete: async (key) => { await runGuestStorage(persistPath, guest.id, { op: 'delete', key }, authorize); },
  keys: async () => (await runGuestStorage(persistPath, guest.id, { op: 'keys' }, authorize)).keys,
};
const repository = createBoardStorage(storage);
const migrated = await repository.load();
assert.equal(migrated.schemaVersion, 2);
assert.equal(migrated.boards[0].focusId, 'test-idea');
await repository.save(migrated);
assert.deepEqual(await createBoardStorage(storage).load(), migrated);
assert.ok(await storage.get(INDEX_KEY));
assert.equal(await storage.get('ideenboard-v1'), undefined);
console.log(JSON.stringify({
  ok: true, version: guest.version, hostVersion: webManifest.version,
  packageRoot: guest.packageRoot, isolatedDirectory: directory,
  checks: ['ZIP installer', 'manifest and built assets', 'isolated capability grant', 'SDK server storage write/read', 'on-disk persistence', 'v1 migration', 'v2 atomic snapshot save/reload'],
}, null, 2));
