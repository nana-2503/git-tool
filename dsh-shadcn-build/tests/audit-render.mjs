/**
 * Audit the rendered dialog against the compiled stylesheet.
 *
 * The question this answers is "does anything render unstyled?": every element the
 * plugin mounts, every class it carries, and whether the compiled CSS defines a
 * rule for it. A `cn-*` class with no rule is a shadcn part rendering bare — the
 * kind of thing that makes a screen feel "not quite right" without an obvious
 * cause.
 *
 * Run with: node tests/audit-render.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const artifact = join(root, '..', 'dsh-github-push', 'client.js');

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  url: 'http://127.0.0.1:3080/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
globalThis.requestAnimationFrame = (fn) => dom.window.setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => dom.window.clearTimeout(id);
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.DOMRect = dom.window.DOMRect;
dom.window.ResizeObserver = globalThis.ResizeObserver;
if (typeof dom.window.Element.prototype.getAnimations !== "function") dom.window.Element.prototype.getAnimations = () => [];
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = React;
const jsxRuntime = await import('react/jsx-runtime');
const reactDom = await import('react-dom');

const STATUS = {
  account: { login: 'octocat', name: 'The Octocat', avatarUrl: 'https://example.test/a.png' },
  token: { configured: true, source: 'GITHUB_PUSH_TOKEN', refs: [], writeRef: 'GITHUB_PUSH_TOKEN' },
  deviceFlowConfigured: true,
  bindings: [
    { workspacePath: '/root/demo', workspaceId: 'ws-1', workspaceTitle: 'demo', owner: 'octocat', repo: 'hello-world', branch: 'main', autoPush: true, autoCommit: true, configureRemote: true, lastPushAt: '2024-05-01T00:00:00.000Z', lastPushStatus: 'ok', lastPushMessage: 'Pushed octocat/hello-world#main (abc1234).' },
  ],
  workspaces: [
    { id: 'ws-1', path: '/root/demo', title: 'demo', sessionIds: ['s-1'] },
    { id: 'ws-2', path: '/root/other', title: 'other', sessionIds: [] },
  ],
  sessionWorkspace: '/root/demo',
  sessionBinding: null,
  activity: [{ at: '2024-05-01T00:00:00.000Z', repo: 'octocat/hello-world', branch: 'main', ok: true, trigger: 'session git push', message: 'ok' }],
  defaults: { autoPush: true, autoCommit: true },
  statePath: '/root/.dsh/github-push.json',
};
dom.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: STATUS }) });
globalThis.fetch = dom.window.fetch;

dom.window.__ModuleLoader__ = { load: (definition) => { dom.window.__DEF__ = definition; } };
new Function('window', 'document', readFileSync(artifact, 'utf8'))(dom.window, dom.window.document);
const plugin = dom.window.__DEF__.factory((id) => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  if (id === 'react-dom' || id === 'react-dom/client') return reactDom;
  throw new Error('unexpected external: ' + id);
});

const slots = [];
const fakeCtx = {
  effect: (fn) => fn(),
  locale: { register: () => () => {}, bind: () => (key) => key, subscribe: () => () => {} },
  slots: { inject: (_k, cb) => cb(), register: (options, component) => { slots.push({ options, component }); return () => {}; } },
};
plugin.apply(fakeCtx);
const css = dom.window.document.querySelector('style[data-dsh-plugin="dsh-github-push"]').textContent;

const launcher = slots.find((s) => s.options.name === 'sidebar.footer.action');
const overlay = slots.find((s) => s.options.name === 'shell.overlay');
const container = dom.window.document.getElementById('host');
await act(async () => {
  createRoot(container).render(
    React.createElement(React.Fragment, null,
      React.createElement(launcher.component, { wide: true }),
      React.createElement(overlay.component, {})),
  );
});
const row = container.querySelector('[data-slot="github-push-launcher"]');
await act(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
await act(async () => { await new Promise((r) => dom.window.setTimeout(r, 20)); });

const content = dom.window.document.querySelector('[data-slot="dialog-content"]');
assert.ok(content !== null, 'dialog open');

/* ------------------------------- the audit ------------------------------- */

// Every selector the compiled stylesheet defines, de-escaped.
const defined = new Set();
for (const m of css.matchAll(/([^{}@]+)\{/g)) {
  for (const sel of m[1].split(',')) defined.add(sel.trim().replace(/\\/g, ''));
}

/** Does any defined selector name this exact class? */
function classDefined(cls) {
  for (const sel of defined) {
    if (sel === '.' + cls) return true;
    if (sel.includes('.' + cls) && /[.\s>:[]/.test(sel.replace('.' + cls, ''))) return true;
  }
  return false;
}

const parts = [];
const walk = (element) => {
  const slot = element.getAttribute?.('data-slot');
  if (slot !== null) parts.push({ tag: element.tagName.toLowerCase(), slot, classes: [...element.classList] });
  for (const child of element.children) walk(child);
};
walk(content);

console.log(`${parts.length} shadcn parts inside the dialog:\n`);
const header = `  ${'data-slot'.padEnd(22)}${'element'.padEnd(10)}classes`;
console.log(header);
console.log('  ' + '-'.repeat(header.length - 2));
for (const part of parts) {
  console.log(`  ${part.slot.padEnd(22)}${part.tag.padEnd(10)}${part.classes.join(' ')}`);
}

// A `cn-*` class that no rule names is a part rendering bare.
const bare = [];
for (const part of parts) {
  for (const cls of part.classes) {
    if (cls.startsWith('cn-') === false) continue;
    if (classDefined(cls)) continue;
    if (!bare.some((b) => b.cls === cls)) bare.push({ cls, slot: part.slot });
  }
}
console.log('');
if (bare.length === 0) {
  console.log('every cn-* class on every part is defined in the compiled stylesheet');
} else {
  console.log('cn-* classes with NO rule (rendering unstyled):');
  for (const b of bare) console.log(`  ${b.cls}   <- ${b.slot}`);
  process.exitCode = 1;
}

// The same question for the plugin's own layout classes.
const gpBare = [];
for (const part of parts) {
  for (const cls of part.classes) {
    if (cls.startsWith('gp-') === false) continue;
    if (classDefined(cls)) continue;
    if (!gpBare.includes(cls)) gpBare.push(cls);
  }
}
console.log(gpBare.length === 0 ? 'every gp-* class is defined too' : 'gp-* classes with NO rule: ' + gpBare.join(', '));

// Which recipes actually paint each part's surface.
const selectorsSetting = (prop) => {
  const out = [];
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (m[2].includes(prop + ':') === false) continue;
    for (const sel of m[1].split(',')) out.push(sel.trim());
  }
  return out;
};
const painted = (element, prop) => selectorsSetting(prop).some((sel) => { try { return element.matches(sel); } catch { return false; } });
for (const part of parts) {
  const element = content.querySelector(`[data-slot="${part.slot}"]`);
  if (element === null) continue;
  const bg = painted(element, 'background-color');
  const ring = painted(element, 'box-shadow') || painted(element, 'border-color');
  console.log(`  ${part.slot.padEnd(22)} background:${bg ? 'yes' : 'no '} border/ring:${ring ? 'yes' : 'no '}`);
}
