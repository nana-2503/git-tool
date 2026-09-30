/**
 * Offline smoke test for @local/dsh-github-push's Host half.
 * Mounts `apply` against a fake Cordis context and exercises the RPC surface.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-ghp-'));

const mod = await import(new URL('../index.js', import.meta.url).href);
assert.equal(typeof mod.apply, 'function', 'apply export');
assert.deepEqual(mod.inject, ['tools', 'connection', 'credentials', 'workspaceRegistry']);

const cwd = mkdtempSync(join(tmpdir(), 'dsh-ws-'));
mkdirSync(join(cwd, 'sub'), { recursive: true });

const registered = { effects: [], events: [], tools: [], routes: [] };
const store = new Map();

const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect(fn, label) {
    const dispose = fn();
    registered.effects.push({ label, dispose });
    return dispose ?? (() => {});
  },
  on(name, fn) {
    registered.events.push({ name, fn });
    return () => {};
  },
  get(name) {
    if (name === 'agents') return { get: () => ({ session: { header: { cwd } } }) };
    return undefined;
  },
  tools: { register: (definition) => (registered.tools.push(definition), () => {}) },
  connection: { fetch: { register: (route) => (registered.routes.push(route), async () => {}) } },
  credentials: {
    async describe(ref) {
      return { configured: store.has(ref), writable: true };
    },
    async resolve(ref) {
      return store.has(ref) ? { value: store.get(ref), source: ref } : undefined;
    },
    async set(ref, value) {
      store.set(ref, value);
    },
    async unset(ref) {
      store.delete(ref);
    },
  },
  workspaceRegistry: {
    list: () => [
      { id: 'ws-1', path: cwd, title: 'demo', sessionIds: ['s-1'] },
    ],
  },
};

mod.apply(ctx, {});

assert.equal(registered.routes.length, 1, 'one RPC route');
assert.equal(registered.routes[0].path, '/api/github-push.rpc');
assert.deepEqual(registered.routes[0].methods, ['POST']);
assert.equal(registered.tools.length, 1, 'one tool');
assert.equal(registered.tools[0].name, 'github_push');
assert.equal(registered.events.length, 1, 'one listener');
assert.equal(registered.events[0].name, 'tools/result');

const route = registered.routes[0];
const call = async (method, params) => {
  const response = await route.fetch(
    new Request('http://127.0.0.1/api/github-push.rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    }),
  );
  assert.equal(response.status, 200, `${method} status`);
  return response.json();
};

// 1. status without a token
const first = await call('status', {});
assert.equal(first.ok, true, 'status ok');
assert.equal(typeof first.value.token.configured, 'boolean');
assert.equal(first.value.workspaces[0].path, cwd);
assert.equal(first.value.sessionBinding, null, 'nothing bound yet');
assert.ok(Array.isArray(first.value.activity));

// 2. bind validation rejects junk
const bad = await call('bind.set', { workspace: cwd, owner: 'bad owner', repo: 'x' });
assert.equal(bad.ok, false, 'bad owner rejected');
assert.match(bad.error.message, /plain GitHub names/);

// 3. a real bind
const bound = await call('bind.set', { workspace: cwd, owner: 'octocat', repo: 'hello-world', branch: 'main' });
assert.equal(bound.ok, true, JSON.stringify(bound));
assert.equal(bound.value.owner, 'octocat');
assert.equal(bound.value.remoteUrl, 'https://github.com/octocat/hello-world.git');

// 4. the binding is visible from a session id (cwd → workspace)
const scoped = await call('status', { sessionId: 's-1' });
assert.equal(scoped.value.sessionBinding.owner, 'octocat');
assert.equal(scoped.value.sessionWorkspace, cwd);

// 5. push without a token explains itself instead of throwing
const noToken = await call('push.now', { workspace: cwd });
assert.equal(noToken.ok, true, 'push.now resolves with an outcome');
assert.equal(noToken.value.ok, false);
assert.match(noToken.value.summary, /No GitHub token|not a git repository/);

// 6. the agent tool reports the same state
const toolStatus = await registered.tools[0].execute(
  { action: 'status' },
  { agent: { id: 's-1', session: { header: { cwd } } } },
);
assert.equal(toolStatus.ok, true);
assert.match(toolStatus.summary, /octocat\/hello-world/);

const toolPush = await registered.tools[0].execute(
  { action: 'push' },
  { agent: { id: 's-1', session: { header: { cwd } } } },
);
assert.equal(toolPush.ok, false);
assert.equal(typeof toolPush.summary, 'string');

// 7. the mirror listener ignores non-push tools and fires for `git push`
registered.events[0].fn({ name: 'read', arguments: { path: 'x' } }, { isError: false });
registered.events[0].fn({ name: 'bash', arguments: { command: 'ls -la' } }, { isError: false });
registered.events[0].fn({ name: 'bash', arguments: { command: 'git push origin main' } }, { isError: true });
assert.equal(registered.tools.length, 1);
registered.events[0].fn(
  { name: 'bash', arguments: { command: 'git push origin main' }, agent: { id: 's-1', session: { header: { cwd } } } },
  { isError: false },
);
await new Promise((resolve) => setTimeout(resolve, 400));

// 8. unknown method
const unknown = await call('nope', {});
assert.equal(unknown.ok, false);
assert.match(unknown.error.message, /unknown method/);

// 9. unbind
const removed = await call('bind.remove', { workspace: cwd });
assert.equal(removed.ok, true);
const after = await call('status', {});
assert.equal(after.value.sessionBinding, null);

// 10. state persisted to disk
const statePath = after.value.statePath;
writeFileSync(join(process.env.DSH_HOME, 'probe.txt'), 'x');
assert.ok(statePath.startsWith(process.env.DSH_HOME), statePath);

// 11. all effects disposed cleanly
for (const effect of registered.effects) {
  if (typeof effect.dispose === 'function') await effect.dispose();
  else if (typeof effect.dispose === 'function') await effect.dispose();
}

console.log('HOST SMOKE TEST PASSED');