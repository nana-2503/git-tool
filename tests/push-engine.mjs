/**
 * End-to-end push-engine test for @local/dsh-github-push.
 *
 * Points `gitBase` at a local directory of bare repositories, so the real
 * `git push` path runs without network: auto-commit, remote configuration,
 * branch resolution, the non-fast-forward hint, and the session-push mirror.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'dsh-ghp-e2e-'));
process.env.DSH_HOME = join(root, 'home');
mkdirSync(process.env.DSH_HOME, { recursive: true });

const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C' },
  }).trim();

const base = join(root, 'gitbase');
const remotePath = join(base, 'octocat', 'hello-world.git');
mkdirSync(join(base, 'octocat'), { recursive: true });
execFileSync('git', ['init', '--bare', '-b', 'main', remotePath]);

const ws = join(root, 'ws');
mkdirSync(ws, { recursive: true });
execFileSync('git', ['init', '-b', 'main', ws]);
writeFileSync(join(ws, 'a.txt'), 'one\n');
git(ws, ['add', '-A']);
git(ws, ['commit', '-m', 'first']);

/* ------------------------------ mount host ------------------------------ */

const mod = await import(new URL('../index.js', import.meta.url).href);

const registered = { tools: [], routes: [], events: [] };
const secrets = new Map([['GITHUB_PUSH_TOKEN', 'ghp_testtoken000000000000']]);

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => fn(),
  on: (name, fn) => registered.events.push({ name, fn }),
  get: (name) => (name === 'agents' ? { get: () => ({ session: { header: { cwd: ws } } }) } : undefined),
  tools: { register: (definition) => registered.tools.push(definition) },
  connection: { fetch: { register: (route) => registered.routes.push(route) } },
  credentials: {
    describe: async (ref) => ({ configured: secrets.has(ref), writable: true }),
    resolve: async (ref) => (secrets.has(ref) ? { value: secrets.get(ref), source: ref } : undefined),
    set: async (ref, value) => secrets.set(ref, value),
    unset: async (ref) => secrets.delete(ref),
  },
  workspaceRegistry: { list: () => [{ id: 'ws-1', path: ws, title: 'ws', sessionIds: [] }] },
};

mod.apply(ctx, { gitBase: base });
const route = registered.routes[0];
const call = async (method, params) => {
  const response = await route.fetch(
    new Request('http://x/api/github-push.rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    }),
  );
  return response.json();
};

/* -------------------------------- bind ---------------------------------- */

const bound = await call('bind.set', { workspace: ws, owner: 'octocat', repo: 'hello-world', branch: 'main' });
assert.equal(bound.ok, true, JSON.stringify(bound));
assert.equal(bound.value.remoteUrl, remotePath, 'gitBase drives the remote URL');

/* ------------------------------ first push ------------------------------ */

const first = await call('push.now', { workspace: ws });
assert.equal(first.value.ok, true, `first push failed: ${first.value.summary}`);
assert.match(first.value.summary, /Pushed octocat\/hello-world#main/);
assert.equal(git(remotePath, ['rev-parse', 'main']), git(ws, ['rev-parse', 'HEAD']), 'remote received the commit');
assert.equal(git(ws, ['remote', 'get-url', 'dsh-binding']), remotePath, 'binding remote configured');

/* --------------------------- auto-commit push --------------------------- */

writeFileSync(join(ws, 'a.txt'), 'two\n');
writeFileSync(join(ws, 'b.txt'), 'new\n');
const second = await call('push.now', { workspace: ws });
assert.equal(second.value.ok, true, `auto-commit push failed: ${second.value.summary}`);
assert.match(second.value.summary, /committed local changes/);
const remoteHead = git(remotePath, ['show', 'main:b.txt']);
assert.equal(remoteHead, 'new', 'uncommitted work reached the remote');

/* ------------------------ non-fast-forward hint ------------------------- */

// Diverge the remote so the next push cannot fast-forward.
const other = join(root, 'other');
execFileSync('git', ['clone', remotePath, other]);
writeFileSync(join(other, 'c.txt'), 'remote side\n');
git(other, ['add', '-A']);
git(other, ['commit', '-m', 'remote side']);
git(other, ['push', 'origin', 'main']);

writeFileSync(join(ws, 'd.txt'), 'local side\n');
const rejected = await call('push.now', { workspace: ws });
assert.equal(rejected.value.ok, false, 'divergent push must fail');
assert.match(rejected.value.summary, /already has commits this workspace does not/, rejected.value.summary);
assert.match(rejected.value.summary, /non-fast-forward|fetch first|\[rejected\]/i);

/* ---------------------------- force push -------------------------------- */

// Isolated repo so this does not disturb the shared ws <-> remote divergence
// the later mirror test depends on. Diverge the remote, then force over it.
const wsf = join(root, 'wsf');
execFileSync('git', ['init', '-b', 'main', wsf]);
execFileSync('git', ['init', '--bare', '-b', 'main', join(base, 'octocat', 'forced.git')]);
ctx.workspaceRegistry.list = () => [
  { id: 'ws-1', path: ws, title: 'ws', sessionIds: [] },
  { id: 'ws-f', path: wsf, title: 'wsf', sessionIds: [] },
];
await call('bind.set', { workspace: wsf, owner: 'octocat', repo: 'forced', branch: 'main', autoCommit: true });
writeFileSync(join(wsf, 'a.txt'), 'base\n');
const fBase = await call('push.now', { workspace: wsf });
assert.equal(fBase.value.ok, true, `force-test baseline push failed: ${fBase.value.summary}`);

// Another clone advances the remote, so wsf's next plain push cannot fast-forward.
const rival = join(root, 'rival');
execFileSync('git', ['clone', join(base, 'octocat', 'forced.git'), rival]);
writeFileSync(join(rival, 'r.txt'), 'rival\n');
git(rival, ['add', '-A']);
git(rival, ['commit', '-m', 'rival']);
git(rival, ['push', 'origin', 'main']);
writeFileSync(join(wsf, 'l.txt'), 'local\n');
const fRejected = await call('push.now', { workspace: wsf });
assert.equal(fRejected.value.ok, false, 'divergent push must fail before forcing');

// A force push overwrites the divergent remote history and reports as forced.
const fForced = await call('push.now', { workspace: wsf, force: true });
assert.equal(fForced.value.ok, true, `force push failed: ${fForced.value.summary}`);
assert.match(fForced.value.summary, /^Force-pushed /, fForced.value.summary);
const forcedRemote = join(base, 'octocat', 'forced.git');
assert.equal(git(forcedRemote, ['show', 'main:l.txt']), 'local', 'forced commit reached the remote');
assert.throws(() => git(forcedRemote, ['show', 'main:r.txt']), /r\.txt/, 'the rival-only commit was overwritten');

/* ------------------------- credential redaction ------------------------- */

const tokenInText = first.value.summary.includes('ghp_testtoken');
assert.equal(tokenInText, false, 'token never appears in a summary');
assert.equal(readFileSync(join(process.env.DSH_HOME, 'github-push.json'), 'utf8').includes('ghp_testtoken'), false, 'token never persisted');

/* ---------------------- configureRemote: false -------------------------- */

const ws2 = join(root, 'ws2');
mkdirSync(ws2, { recursive: true });
execFileSync('git', ['init', '-b', 'main', ws2]);
execFileSync('git', ['init', '--bare', '-b', 'main', join(base, 'octocat', 'second.git')]);
ctx.workspaceRegistry.list = () => [
  { id: 'ws-1', path: ws, title: 'ws', sessionIds: [] },
  { id: 'ws-2', path: ws2, title: 'ws2', sessionIds: [] },
];
const bound2 = await call('bind.set', {
  workspace: ws2, owner: 'octocat', repo: 'second', branch: 'main', configureRemote: false, autoPush: false,
});
assert.equal(bound2.value.configureRemote, false);
writeFileSync(join(ws2, 'x.txt'), 'x\n');
const third = await call('push.now', { workspace: ws2 });
assert.equal(third.value.ok, true, `push without autoCommit/remote failed: ${third.value.summary}`);
assert.throws(() => git(ws2, ['remote', 'get-url', 'dsh-binding']), /dsh-binding/, 'no remote was configured');

/* --------------------------- mirror on git push ------------------------- */

let mirrorEvents = 0;
const listener = registered.events.find((entry) => entry.name === 'tools/result').fn;
const beforeMirror = git(remotePath, ['rev-parse', 'main']);
listener(
  { name: 'bash', arguments: { command: 'git push origin main' }, agent: { id: 's-1', session: { header: { cwd: ws } } } },
  { isError: false },
);
mirrorEvents += 1;
await new Promise((resolve) => setTimeout(resolve, 2500));
const status = await call('status', {});
const mirrored = status.value.activity.find((entry) => entry.trigger === 'session git push');
assert.equal(mirrorEvents, 1);
assert.ok(mirrored !== undefined, `mirror did not run: ${JSON.stringify(status.value.activity)}`);
assert.equal(mirrored.ok, false, 'the mirror reused the real push engine (still divergent, so it failed)');
assert.ok(git(remotePath, ['rev-parse', 'main']) !== beforeMirror === false, 'remote unchanged after a failed mirror');

// A device-flow-shaped call with no clientId explains itself.
const device = await call('login.start', {});
assert.equal(device.ok, false);
assert.match(device.error.message, /clientId/);

// Repo creation validates its name before touching the network.
const created = await call('repo.create', { name: 'bad name' });
assert.equal(created.ok, false);
assert.match(created.error.message, /repository name must be/);

// The tool reports the same engine outcome as the route.
const toolPush = await registered.tools[0].execute(
  { action: 'push', workspace: ws2 },
  { agent: { id: 's-1', session: { header: { cwd: ws2 } } } },
);
assert.equal(toolPush.ok, true, toolPush.summary);

console.log('PUSH ENGINE E2E TEST PASSED');