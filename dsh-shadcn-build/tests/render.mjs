/**
 * Mount test for the built Client artifact.
 *
 * This is the strongest check available without a browser: it loads the real
 * bundle, mounts it into a real DOM (jsdom) with real `react` +
 * `react-dom/client`, and drives the plugin through the same path a person does
 * — clicking the sidebar row, opening the dialog, and reading the rendered DOM.
 * The official shadcn components and their Base UI primitives genuinely execute.
 *
 * The `paintedBy` guard below is the important one: it rejects a stylesheet whose
 * rules look right but cannot match the elements. shadcn's dialog surface is the
 * `bg-popover` utility, which compiles to `background-color: var(--popover)`;
 * `--popover` only exists on `[data-dsh-github-push]`, so a popup without that
 * attribute resolves the variable to nothing and renders with no background at
 * all. The guard therefore checks the rule that paints the popup *matches* it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const artifact = join(root, '..', 'dsh-github-push', 'client.js');

/* ------------------------------- the page -------------------------------- */

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
// Base UI's ScrollArea viewport waits on in-flight animations through
// `getAnimations({ subtree: true })`; jsdom implements neither the Web
// Animations API nor that method, and the empty list is the correct answer here
// because nothing in this test animates.
if (typeof dom.window.Element.prototype.getAnimations !== 'function') {
  dom.window.Element.prototype.getAnimations = () => [];
}
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom cannot parse @layer/nesting, so it warns 'Could not parse CSS stylesheet'.
// That is jsdom's parser, not the stylesheet: browsers compile it fine.

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = React;
const jsxRuntime = await import('react/jsx-runtime');
const reactDom = await import('react-dom');

/* -------------------------------- helpers -------------------------------- */

/** Declarations of a rule, order- and minifier-independent. */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(escaped + '\\{([^}]*)\\}'));
  return match ? match[1] : '';
}

/**
 * Every selector of a rule that sets `prop` in the injected stylesheet. Rules
 * inside `@supports` / `@media` are reached, because only the innermost
 * declaration block is matched.
 */
function selectorsSetting(css, prop) {
  const out = [];
  const needle = prop + ':';
  for (const match of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (match[2].includes(needle) === false) continue;
    for (const selector of match[1].split(',')) out.push(selector.trim());
  }
  return out;
}

/** Is `element` actually painted by the stylesheet? See the file header. */
function paintedBy(element, css, prop) {
  return selectorsSetting(css, prop).some((selector) => {
    try {
      return element.matches(selector);
    } catch {
      return false;
    }
  });
}

/** Span of a real `@layer` block, or null. */
function layerSpan(css, name) {
  const start = css.indexOf(`@layer ${name}{`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + `@layer ${name}`.length; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return { start, end: i };
  }
  return null;
}

/* ------------------------------ host fixtures ---------------------------- */

const STATUS = {
  account: { login: 'octocat', name: 'The Octocat', avatarUrl: 'https://example.test/a.png' },
  token: { configured: true, source: 'GITHUB_PUSH_TOKEN', refs: [], writeRef: 'GITHUB_PUSH_TOKEN' },
  deviceFlowConfigured: true,
  bindings: [
    {
      workspacePath: '/root/demo',
      workspaceId: 'ws-1',
      workspaceTitle: 'demo',
      owner: 'octocat',
      repo: 'hello-world',
      branch: 'main',
      autoPush: true,
      autoCommit: true,
      configureRemote: true,
      lastPushAt: '2024-05-01T00:00:00.000Z',
      lastPushStatus: 'ok',
      lastPushMessage: 'Pushed octocat/hello-world#main (abc1234) via GITHUB_PUSH_TOKEN.',
    },
  ],
  workspaces: [
    { id: 'ws-1', path: '/root/demo', title: 'demo', sessionIds: ['s-1'] },
    { id: 'ws-2', path: '/root/other', title: 'other', sessionIds: [] },
  ],
  sessionWorkspace: '/root/demo',
  sessionBinding: null,
  activity: [
    { at: '2024-05-01T00:00:00.000Z', repo: 'octocat/hello-world', branch: 'main', ok: true, trigger: 'session git push', message: 'ok' },
    { at: '2024-05-01T00:01:00.000Z', repo: 'octocat/hello-world', branch: 'main', ok: false, trigger: 'manual', message: 'rejected' },
  ],
  defaults: { autoPush: true, autoCommit: true },
  statePath: '/root/.dsh/github-push.json',
};

const calls = [];
let payload = STATUS;
dom.window.fetch = async (url, init) => {
  calls.push(JSON.parse(init.body).method);
  return { ok: true, status: 200, json: async () => ({ ok: true, value: payload }) };
};
globalThis.fetch = dom.window.fetch;

/* --------------------------------- load ---------------------------------- */

dom.window.__ModuleLoader__ = { load: (definition) => { dom.window.__DEF__ = definition; } };
new Function('window', 'document', readFileSync(artifact, 'utf8'))(dom.window, dom.window.document);

const definition = dom.window.__DEF__;
assert.equal(definition.id, '@local/dsh-github-push', 'module id');

const plugin = definition.factory((id) => {
  if (id === 'react') return React;
  if (id === 'react/jsx-runtime') return jsxRuntime;
  if (id === 'react-dom' || id === 'react-dom/client') return reactDom;
  throw new Error('unexpected external request: ' + id);
});

/* ------------------------------ registration ----------------------------- */

const slots = [];
let locale = 'zh';
const dicts = { zh: {}, en: {} };
const fakeCtx = {
  effect: (fn) => fn(),
  locale: {
    register: (ns, d) => { dicts.zh = d.zh; dicts.en = d.en; return () => {}; },
    bind: () => (key) => (locale === 'zh' ? dicts.zh : dicts.en)[key] ?? key,
    subscribe: () => () => {},
  },
  slots: {
    inject: (key, callback) => callback(),
    register: (options, component) => { slots.push({ options, component }); return () => {}; },
  },
};
plugin.apply(fakeCtx);

const styleTag = dom.window.document.querySelector('style[data-dsh-plugin="dsh-github-push"]');
assert.ok(styleTag !== null, 'stylesheet injected');
const injectedCss = styleTag.textContent;
assert.ok(injectedCss.length > 10000, 'stylesheet carries the compiled shadcn css');

// The token scope is what makes `bg-popover` resolvable at all.
assert.ok(injectedCss.includes('--popover:var(--dsw-alias-bg-layer-2)'), 'tokens bound to the harness theme');
// No style layer: the current Base UI components name only Tailwind utilities.
assert.equal(injectedCss.includes('cn-dialog-content'), false, 'no cn-* recipe classes are expected');

assert.equal(slots.length, 2, 'two slot registrations');
assert.deepEqual(slots.map((s) => s.options.name).sort(), ['shell.overlay', 'sidebar.footer.action']);
const launcher = slots.find((s) => s.options.name === 'sidebar.footer.action');
const overlay = slots.find((s) => s.options.name === 'shell.overlay');

/* --------------------------------- mount --------------------------------- */

const container = dom.window.document.getElementById('host');
const mountRoot = createRoot(container);

await act(async () => {
  mountRoot.render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(launcher.component, { wide: true }),
      React.createElement(overlay.component, {}),
    ),
  );
});

const row = container.querySelector('[data-slot="github-push-launcher"]');
assert.ok(row !== null, 'sidebar row mounted');
assert.equal(row.getAttribute('data-wide'), 'true');
assert.equal(row.getAttribute('data-dsh-github-push'), 'true', 'row is a token scope root');
assert.equal(row.getAttribute('aria-haspopup'), 'dialog');
assert.equal(row.getAttribute('aria-expanded'), 'false');
assert.match(row.textContent, /GitHub 设置/);
assert.ok(row.querySelector('svg[viewBox="0 0 16 16"]') !== null, 'glyph at the harness icon size');
assert.equal(dom.window.document.querySelector('[data-slot="dialog-content"]'), null, 'no dialog while closed');

// The collapsed rail: the label must still name the control, and must be hidden
// by a rule that actually matches — a missing `sr-only` would print the text
// inside a 36px square button.
const railHost = dom.window.document.createElement('div');
dom.window.document.body.appendChild(railHost);
const railRoot = createRoot(railHost);
await act(async () => {
  railRoot.render(React.createElement(launcher.component, { wide: false }));
});
const railRow = railHost.querySelector('[data-slot="github-push-launcher"]');
assert.equal(railRow.getAttribute('data-wide'), 'false', 'rail state');
assert.match(railRow.textContent, /GitHub 设置/, 'rail keeps an accessible name');
const railLabel = railRow.querySelector('.sr-only');
assert.ok(railLabel !== null, 'rail label carries the screen-reader class');
assert.ok(paintedBy(railLabel, injectedCss, 'clip-path'), 'the rail label is actually hidden by a matching rule');
await act(async () => {
  railRoot.unmount();
});
railHost.remove();

/* ------------------------------ open the dialog -------------------------- */

await act(async () => {
  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await act(async () => {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
});

assert.equal(row.getAttribute('aria-expanded'), 'true', 'row reports the open state');

// Base UI portals the popup into document.body, not into our container.
const content = dom.window.document.querySelector('[data-slot="dialog-content"]');
assert.ok(content !== null, 'dialog content mounted');
// Base UI expresses modality by inerting the rest of the page.
assert.equal(container.getAttribute('aria-hidden'), 'true', 'rest of the page is inert while modal');
assert.equal(content.getAttribute('data-dsh-github-push'), 'true', 'dialog is a token scope root');
assert.equal(content.getAttribute('role'), 'dialog');
assert.match(content.className, /bg-popover/, 'official dialog surface utility');
assert.match(content.className, /gp-dialog-panel/, 'plugin frame override');

// The regression guard: the popup must be painted by a rule that MATCHES it.
assert.ok(paintedBy(content, injectedCss, 'background-color'), 'a matching rule paints the dialog surface');
assert.ok(content.matches('.bg-popover'), 'the popup carries the utility that paints it');
// Self-test: the same predicate on a rule the popup cannot match must come back
// false, so the guard is discriminating rather than always true.
assert.equal(
  paintedBy(content, '.style-vega .bg-popover{background-color:var(--popover)}', 'background-color'),
  false,
  'the guard rejects a rule the popup cannot match',
);

const overlayEl = dom.window.document.querySelector('[data-slot="dialog-overlay"]');
assert.ok(overlayEl !== null, 'official dialog overlay mounted');
assert.ok(paintedBy(overlayEl, injectedCss, 'background-color'), 'a matching rule paints the overlay');

const close = dom.window.document.querySelector('[data-slot="dialog-close"]');
assert.ok(close !== null, 'the floated close button rendered');
// The close now lives inside the sticky header and is positioned by the
// unlayered `.gp-close` rule, not shadcn's `absolute top-4 right-4` utilities.
assert.match(close.className, /gp-close/, 'close carries the frame position class');

const refresh = dom.window.document.querySelector('[data-gp-action="refresh"]');
assert.ok(refresh !== null, 'plugin refresh corner action');
assert.match(refresh.className, /gp-refresh/, 'refresh sits one 32px step left of the close');
assert.equal(refresh.getAttribute('aria-label'), '刷新');
// An icon-only control must still name itself; there is no shadcn Tooltip here
// (see the README: Base UI's render prop cannot take a ref through shadcn's
// function-component Button on React 18).
assert.ok(refresh.getAttribute('title') !== null, 'refresh names itself for hover and a11y');
assert.ok(close.getAttribute('title') !== null, 'close names itself for hover and a11y');

// Both are authored on Tailwind's spacing scale, so they agree on one line at any
// root font size (`top-4` is calc(var(--spacing) * 4), not a literal 16px).
const refreshRule = ruleBody(injectedCss, '.gp-refresh');
assert.ok(refreshRule.includes('top:calc(var(--spacing) * 4)'), 'refresh shares the close line: ' + refreshRule);
assert.ok(refreshRule.includes('right:calc(var(--spacing) * 14)'), 'refresh clears the close by 2 units: ' + refreshRule);
const closeRule = ruleBody(injectedCss, '.gp-close');
assert.ok(closeRule.includes('top:calc(var(--spacing) * 4)') && closeRule.includes('right:calc(var(--spacing) * 4)'), 'the close sits at top-4/right-4: ' + closeRule);

/* ---------------------------- responsive frame --------------------------- *
 * The popup is `fixed`, so a box taller than the viewport cannot be reached at
 * all: the close button ends up above the top edge, the card footers below the
 * bottom edge, and the page behind the overlay does not scroll. shadcn's popup
 * bounds neither axis — that is the bug, and `.gp-dialog-panel` is the fix: a
 * definite box clamped by `max-height` that scrolls itself.
 */

const panelRule = ruleBody(injectedCss, '.gp-dialog-panel');
// A viewport unit, not a percentage: a percentage resolves against the
// containing block, and a `position: fixed` box only resolves it against the
// viewport while no ancestor establishes a different one. The `dvh` override
// lives in its own `@supports` rule so the minifier cannot fold the `vh`
// fallback away.
assert.ok(panelRule.includes('max-height:calc(100vh - 2rem)'), 'the panel is bounded by the viewport: ' + panelRule);
assert.ok(/@supports \(height:100dvh\)\{\.gp-dialog-panel\{max-height:calc\(100dvh - 2rem\)/.test(injectedCss), 'the dynamic-viewport override survives minification');
// Engines without `dvh` (older WebView/XWeb) resolve `vh` to the LARGE
// viewport; the popup must then anchor to the top instead of centring, or its
// ends hide behind the browser UI and cannot be reached. Chromium supports
// dvh, so this branch is only assertable statically.
assert.ok(/@supports not \(height:100dvh\)\{\.gp-dialog-panel\{margin:0 auto\}/.test(injectedCss), 'the no-dvh fallback anchors the popup to the top');
// iOS WebKit swallows touch panning under a `backdrop-filter` overlay; the
// rule must drop the blur for this dialog's own overlay only.
assert.ok(
  /div:has\(>\[data-gp-panel\]\)>\[data-slot=dialog-overlay\]\{[^}]*backdrop-filter:none/.test(injectedCss),
  'the overlay blur is dropped while our dialog is open',
);
assert.ok(panelRule.includes('padding:0'), 'the header and body own the insets');
// The popup itself is the scroller — one native overflow box, no flex/
// percentage chain that a live-page cascade can break. (The minifier folds
// `overflow-x:hidden; overflow-y:auto` into the `overflow:hidden auto`
// shorthand, so accept either spelling.)
assert.ok(
  panelRule.includes('overflow:hidden auto') || panelRule.includes('overflow-y:auto'),
  'the popup is the scrollport itself: ' + panelRule,
);
assert.ok(
  panelRule.includes('overflow:hidden auto') || panelRule.includes('overflow-x:hidden'),
  'no horizontal scroll, just clipping',
);
assert.ok(panelRule.includes('overscroll-behavior:contain'), 'a pan at the end cannot chain to the locked page behind');
assert.ok(panelRule.includes('touch-action:pan-y'), 'the vertical gesture is named explicitly for WebKit');
assert.ok(panelRule.includes('max-width:min(1040px,100vw - 2rem)'), 'phone width keeps a gutter, desktop widens for the master/detail grid');
// Transform-free centring: iOS WebKit mis-hits touches on a `fixed` element
// that carries a transform, so the frame centres with insets + auto margins.
assert.ok(panelRule.includes('inset:1rem'), 'the panel is inset on all four sides');
assert.ok(panelRule.includes('margin:auto'), 'the auto margins centre the definite box');
assert.ok(panelRule.includes('translate:none'), 'the translate utilities are killed, no transform on the fixed box');
assert.ok(panelRule.includes('height:fit-content'), 'the height is content-sized so margin:auto can centre it');
// `gap:0` cancels shadcn's own `gap-6` between the header and the body.
assert.ok(panelRule.includes('gap:0'), 'the panel contributes no spacing of its own');

// The sticky header rides the popup's scrollport, so the title and both
// corner buttons stay on screen while the body scrolls under it.
const headRule = ruleBody(injectedCss, '.gp-dialog-head');
assert.ok(headRule.includes('position:sticky') && headRule.includes('top:0'), 'the header sticks to the scrollport top: ' + headRule);
assert.ok(headRule.includes('z-index:2'), 'the header rides above the cards');
assert.ok(headRule.includes('background:var(--popover)'), 'the header is opaque, so content scrolls under it');
const header = content.querySelector('[data-slot="dialog-header"]');
assert.ok(header !== null, 'official dialog header');
assert.ok(header.className.includes('gp-dialog-head'), 'the header carries the sticky frame class');

// Both corner actions live inside the sticky header, so they ride it.
assert.ok(content.contains(refresh), 'the refresh action is mounted');
assert.ok(header.contains(refresh), 'the refresh action sits inside the sticky header');
assert.ok(content.contains(close), 'the close button is mounted');
assert.ok(header.contains(close), 'the close button sits inside the sticky header');

// Cascade: shadcn's popup sets `grid`/`p-6`/`gap-6`/`sm:max-w-md` as utilities in
// the `utilities` layer; `.gp-dialog-panel` is unlayered, so it wins. Prove the
// boundary rather than assume it.
const utilities = layerSpan(injectedCss, 'utilities');
assert.ok(utilities !== null, 'utilities live in a real @layer');
const panelIndex = injectedCss.indexOf('.gp-dialog-panel{');
assert.ok(panelIndex > utilities.end, 'the frame rules are unlayered, so they outrank the utilities');

// The one recipe whose `dark:` branch is unreachable keeps its fill.
assert.ok(
  ruleBody(injectedCss, '[data-dsh-github-push] .gp-fill:not(:hover):not(:disabled)').includes('background-color'),
  'the outline fill substitution is compiled',
);

/* ------------------------------ dialog contents -------------------------- */

const text = content.textContent;
assert.match(text, /GitHub 推送/, 'title');
assert.match(text, /登录 GitHub，为工作区绑定仓库/, 'subtitle');
assert.match(text, /GitHub 账户/, 'account card');
assert.match(text, /octocat/, 'signed-in account');
assert.match(text, /工作区/, 'workspace list section');
assert.match(text, /demo/, 'workspace row / editor');
assert.match(text, /会话 push 时自动同步/, 'auto-push switch label');
assert.match(text, /推送记录/, 'activity section');
assert.match(text, /\/root\/\.dsh\/github-push\.json/, 'state path footnote');

const cards = content.querySelectorAll('[data-slot="card"]');
assert.ok(cards.length >= 4, `official cards rendered in the rail + column layout (got ${cards.length})`);
assert.ok(paintedBy(cards[0], injectedCss, 'background-color'), 'a matching rule paints the cards');
assert.ok(paintedBy(cards[0], injectedCss, 'box-shadow'), 'cards keep the official ring');
assert.ok(content.querySelector('[data-slot="dialog-title"]').tagName === 'H2', 'official dialog title');
// The plugin ships no preflight, so the UA `h2 { margin: .83em 0 }` would pad the
// header by ~120px and outsize the title; the scoped base reset is the fix.
assert.ok(
  /\[data-dsh-github-push\][^{]*h2[^{]*\{[^}]*margin:0/.test(injectedCss),
  'UA heading margins are reset inside the plugin scope',
);
assert.ok(content.querySelector('[data-slot="field"]') !== null, 'official field');
assert.ok(content.querySelector('[data-slot="field-group"]') !== null, 'official field group');
assert.equal(content.querySelectorAll('[data-slot="switch"]').length, 3, 'three official switches');
// Buttons that sit in an Input row must be the Input's size: the Input is
// h-9, so the browse/create actions take the default button size (h-9), not
// the sm one (h-8) — a shorter sibling reads as a mis-set pair.
const editorBtns = [...content.querySelectorAll('[data-gp-editor] button')];
const browseBtn = editorBtns.find((b) => b.textContent.trim() === '浏览');
assert.ok(browseBtn !== undefined, 'the browse button is rendered');
assert.ok(browseBtn.className.includes('h-9') && !browseBtn.className.includes('h-8'), 'the browse button matches the input height');
const createBtn = editorBtns.find((b) => b.textContent.trim() === '新建仓库');
assert.ok(createBtn !== undefined && createBtn.className.includes('h-9'), 'the create-repo button matches the input height');
assert.ok(content.querySelector('[data-slot="separator"]') !== null, 'official separator');
assert.ok(content.querySelector('[data-slot="badge"]') !== null, 'official badge');

// Avatar: a photo URL that cannot load must fall back to the mark, not a
// broken-image icon — mobile networks often cannot reach the avatar CDN even
// while the API itself works. jsdom never fetches, so the `error` event is
// dispatched by hand; the component must swap the img for the glyph.
const avatarImg = content.querySelector('img');
assert.ok(avatarImg !== null, 'avatar photo rendered when a URL is present');
assert.equal(avatarImg.getAttribute('referrerpolicy'), 'no-referrer', 'the avatar sends no referrer');
await act(async () => {
  avatarImg.dispatchEvent(new dom.window.Event('error'));
});
await act(async () => {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
});
assert.equal(content.querySelector('img'), null, 'the failed avatar is replaced');
assert.ok(content.querySelector('[data-slot="card"] span svg') !== null, 'the GitHub mark fallback renders');

// The master selector is Base UI's listbox, not a native <select>, and it is
// one control however many workspaces exist — the whole point of the dropdown.
assert.equal(content.querySelectorAll('select').length, 0, 'no native select element');
assert.equal(content.querySelectorAll('[data-slot="select-trigger"]').length, 1, 'official select trigger');
const trigger = content.querySelector('[data-slot="select-trigger"]');
assert.match(trigger.textContent, /demo/, 'trigger shows the selected workspace');
assert.match(trigger.textContent, /octocat\/hello-world/, 'the trigger label carries the bound repository');
assert.ok(trigger.className.includes('gp-fill'), 'the trigger carries the unreachable-dark fill');
assert.ok(
  paintedBy(trigger, injectedCss, 'border-color') || paintedBy(trigger, injectedCss, 'border-radius'),
  'the select trigger is styled by a matching rule',
);
const switchEl = content.querySelector('[data-slot="switch"]');
assert.ok(paintedBy(switchEl, injectedCss, 'border-radius'), 'the switch is styled by a matching rule');

// The activity feed is shadcn's Item rows, scoped to its own card.
const items = content.querySelectorAll('[data-gp-activity] [data-slot="item"]');
assert.ok(items.length >= 2, `official item rows rendered (got ${items.length})`);
const firstItem = items[0];
assert.ok(firstItem.querySelector('[data-slot="item-title"]') !== null, 'item title');
assert.ok(firstItem.querySelector('[data-slot="item-description"]') !== null, 'item description');
assert.ok(firstItem.querySelector('[data-slot="item-actions"]') !== null, 'item actions');
assert.ok(firstItem.className.includes('flex-wrap'), 'item rows wrap their own content');
assert.equal(firstItem.querySelector('[data-slot="item-media"] .gp-dot') !== null, true, 'status dot inside the item media');
assert.equal(items[1].getAttribute('data-ok'), 'false', 'row state carried on the item');

/* ------------------------------ interactions ----------------------------- */

// Opening the picker: Base UI portals the popup out of the dialog — into the
// dialog's portal container, not into the dialog popup — so the token scope
// has to travel with it. Without the attribute every `bg-popover`,
// `text-popover-foreground`, `ring-foreground/10` and `rounded-md` resolves
// to nothing: measured in a real browser, a transparent background, a 0px
// radius and no ring at all.
await act(async () => {
  trigger.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await act(async () => {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
});
const listPopup = dom.window.document.querySelector('[data-slot="select-content"], [role="listbox"]');
assert.ok(listPopup !== null, 'select opens a popup listbox');
assert.equal(listPopup.hasAttribute('data-dsh-github-push'), true, 'the select popup carries the token scope');
assert.match(listPopup.className, /bg-popover/, 'the select popup keeps its official surface utility');
assert.ok(paintedBy(listPopup, injectedCss, 'background-color'), 'a matching rule paints the select popup');
const options = dom.window.document.querySelectorAll('[data-slot="select-item"], [role="option"]');
assert.ok(options.length >= 2, `one item per workspace (got ${options.length})`);

// Choosing the second workspace moves the editor — the master/detail contract.
// Base UI selects on a full pointer sequence; jsdom delivers none of it for
// free, so drive pointerdown → mousedown → pointerup → mouseup → click.
const pointerTap = (el) => {
  for (const [type, Ctor] of [
    ['pointerdown', dom.window.PointerEvent ?? dom.window.MouseEvent],
    ['mousedown', dom.window.MouseEvent],
    ['pointerup', dom.window.PointerEvent ?? dom.window.MouseEvent],
    ['mouseup', dom.window.MouseEvent],
    ['click', dom.window.MouseEvent],
  ]) {
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
  }
};
await act(async () => {
  pointerTap(options[1]);
});
await act(async () => {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
});
const editor = content.querySelector('[data-gp-editor]');
assert.ok(editor !== null, 'the binding editor is mounted');
assert.match(editor.textContent, /other/, 'choosing a workspace switches the editor to it');
assert.match(editor.textContent, /未绑定/, 'the newly selected workspace is unbound');
assert.match(trigger.textContent, /other/, 'the trigger shows the new selection');

// Escape closes through Base UI's own dismissal.
await act(async () => {
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
});
assert.equal(row.getAttribute('aria-expanded'), 'false', 'Escape closed the dialog');

// Reopen and close with shadcn's own X button. Base UI's Close renders shadcn's
// Button, which is a plain function component; on React 18 that costs a
// 'cannot be given refs' warning, so confirm the button still dismisses.
await act(async () => {
  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await act(async () => {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
});
const reopened = dom.window.document.querySelector('[data-slot="dialog-close"]');
assert.ok(reopened !== null, 'close button present after reopening');
await act(async () => {
  reopened.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
});
assert.equal(row.getAttribute('aria-expanded'), 'false', 'the X button closes the dialog');

assert.ok(calls.includes('status'), 'the dialog read status from the Host route');

/* ------------------------------- english --------------------------------- */

locale = 'en';
payload = STATUS;
await act(async () => {
  row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
});
await act(async () => {
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
});
const enContent = dom.window.document.querySelector('[data-slot="dialog-content"]');
assert.match(enContent.textContent, /GitHub account/, 'english dictionary');
assert.match(enContent.textContent, /Workspaces/, 'english workspace section');
assert.match(enContent.textContent, /Push activity/, 'english activity section');

console.log('CLIENT MOUNT TEST PASSED (official shadcn components, real React, real DOM)');
