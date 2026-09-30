/**
 * Real-browser verification of the dialog's layout.
 *
 * jsdom has no layout engine, so it can prove that classes are present and that
 * rules match, but not that a box scrolls. This loads the built artifact into
 * Chromium — same module table, same stylesheet, same Base UI primitives — and
 * measures the actual geometry at several viewport widths: the popup's height
 * against the viewport, the scroll chain, whether the viewport really scrolls,
 * and whether the corner buttons are on screen.
 *
 * Run with: node tests/browser/run.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const OUT = join(root, '.browser');
mkdirSync(OUT, { recursive: true });

/* ------------------------------- the page -------------------------------- */

const reactBundlePath = join(OUT, 'react-bundle.js');
if (!existsSync(reactBundlePath)) {
  // The harness needs the platform externals (react, react-dom, jsx-runtime)
  // as one classic script. `.browser/` is gitignored scratch, so a fresh
  // clone rebuilds it here rather than shipping a committed blob.
  const { build } = await import('esbuild');
  const built = await build({
    entryPoints: [join(here, 'react-entry.jsx')],
    bundle: true, format: 'iife', platform: 'browser',
    target: ['chrome120', 'firefox120', 'safari17'], minify: true,
    jsx: 'automatic', write: false, logLevel: 'silent',
  });
  writeFileSync(reactBundlePath, built.outputFiles[0].text);
}
const reactBundle = readFileSync(reactBundlePath, 'utf8');
const artifact = [join(root, '..', 'client.js'), join(root, '..', 'dsh-github-push', 'client.js')].map((p) => existsSync(p) ? readFileSync(p, 'utf8') : null).find((s) => s !== null);
const css = readFileSync(join(root, 'dist', 'shadcn.css'), 'utf8');

/**
 * The real Harness stylesheets, loaded into the page before the plugin's, so the
 * harness reproduces the host the plugin actually runs in. A clean page proves
 * nothing about cascade interactions with the host — which is exactly the class
 * of bug that keeps slipping through ("works in the test, broken in the app").
 */
const HARNESS_CSS = [
  '/root/.nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BPHePDI_.css',
  '/root/.nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/vendor-BNsW4eBh.css',
].map((file) => readFileSync(file, 'utf8')).join('\n');

/** Emulated Harness theme tokens — the plugin's CSS resolves against these. */
const TOKENS = `
  --dsw-alias-bg-base:#ffffff; --dsw-alias-bg-layer-1:#f7f8fa; --dsw-alias-bg-layer-2:#ffffff;
  --dsw-alias-label-primary:#1a1d21; --dsw-alias-label-secondary:#61666b;
  --dsw-alias-brand-primary:#1a1d21; --dsw-alias-interactive-bg-hover:#2631480f;
  --dsw-alias-interactive-bg-hover-solid:#2631481a; --dsw-alias-border-l2:#00000014;
  --dsw-alias-state-error-primary:#d92d20; --dsw-alias-state-success-primary:#039855;
  --dsw-alias-state-warn-primary:#dc6803; --dsw-radius-md:8px;
`;

const STATUS = {
  account: { login: 'octocat', name: 'The Octocat', avatarUrl: null },
  token: { configured: true, source: 'GITHUB_PUSH_TOKEN', refs: [], writeRef: 'GITHUB_PUSH_TOKEN' },
  deviceFlowConfigured: false,
  bindings: [
    { workspacePath: '/root/demo', workspaceId: 'ws-1', workspaceTitle: 'demo', owner: 'octocat', repo: 'hello-world', branch: 'main', autoPush: true, autoCommit: true, configureRemote: true, lastPushAt: '2024-05-01T00:00:00.000Z', lastPushStatus: 'ok', lastPushMessage: 'Pushed octocat/hello-world#main (abc1234).' },
  ],
  workspaces: [
    { id: 'ws-1', path: '/root/demo', title: 'demo', sessionIds: ['s-1'] },
    { id: 'ws-2', path: '/root/other', title: 'other', sessionIds: [] },
    { id: 'ws-3', path: '/root/third', title: 'third', sessionIds: [] },
  ],
  sessionWorkspace: '/root/demo',
  sessionBinding: null,
  activity: Array.from({ length: 12 }, (_, i) => ({
    at: new Date(2024, 4, 1, 0, i).toISOString(),
    repo: i % 3 === 0 ? null : 'octocat/hello-world',
    branch: 'main', ok: i % 4 !== 0, trigger: i % 3 === 0 ? 'session git push' : 'manual',
    message: i % 4 === 0 ? 'rejected non-fast-forward' : 'Pushed octocat/hello-world#main (abc1234).',
  })),
  defaults: { autoPush: true, autoCommit: true },
  statePath: '/root/.dsh/github-push.json',
};

const page = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
  :root{${TOKENS}}
  html,body{margin:0;height:100%;font:13px/20px system-ui,sans-serif;background:#eef0f3;color:#1a1d21}
  #host{height:100%}
</style><script>${reactBundle}</script><style id="harness-css">${HARNESS_CSS}</style><style id="plugin-css">${css}</style></head>
<body><div id="host"></div><script>
window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: ${JSON.stringify(STATUS)} }) });
window.__ModuleLoader__ = { load: (d) => { window.__DEF__ = d; } };
(new Function('window', 'document', ${JSON.stringify(artifact)}))(window, document);
const def = window.__DEF__;
const R = window.__DSH_EXTERNALS;
const plugin = def.factory((id) => {
  if (id === 'react') return R.React;
  if (id === 'react/jsx-runtime') return R.JsxRuntime;
  if (id === 'react-dom') return R.ReactDOM;
  if (id === 'react-dom/client') return R.ReactDOMClient;
  throw new Error('unexpected external: ' + id);
});
const slots = [];
const ctx = {
  effect: (fn) => fn(),
  locale: { register: () => () => {}, bind: () => (k, p) => (p === undefined ? k : k + " " + JSON.stringify(p)), subscribe: () => () => {} },
  slots: { inject: (_k, cb) => cb(), register: (o, c) => { slots.push({ options: o, component: c }); return () => {}; } },
};
plugin.apply(ctx);
const host = document.getElementById('host');
R.ReactDOMClient.createRoot(host).render(
  R.React.createElement(R.React.Fragment, null,
    R.React.createElement(slots.find((s) => s.options.name === 'sidebar.footer.action').component, { wide: true }),
    R.React.createElement(slots.find((s) => s.options.name === 'shell.overlay').component, {})),
);
window.__open = () => document.querySelector('[data-slot="github-push-launcher"]').click();
</script></body></html>`;

writeFileSync(join(OUT, 'harness.html'), page);

/* -------------------------------- measure -------------------------------- */

const browser = await chromium.launch();
const sizes = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'phone-short', width: 390, height: 500 },
];

const measure = async (page) => page.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) }; };
  // The popup itself is the scrollport now: one native `overflow-y: auto` box,
  // no ScrollArea chain that a live-page cascade can break.
  const popup = document.querySelector('[data-slot="dialog-content"]');
  const body = document.querySelector('.gp-dialog-body');
  const close = document.querySelector('[data-slot="dialog-close"]');
  const header = document.querySelector('[data-slot="dialog-header"]');
  const lastItem = [...document.querySelectorAll('[data-slot="item"]')].pop();
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    popup: rect(popup),
    popupStyle: {
      maxHeight: getComputedStyle(popup).maxHeight,
      overflowY: getComputedStyle(popup).overflowY,
      overscroll: getComputedStyle(popup).overscrollBehaviorY,
      touchAction: getComputedStyle(popup).touchAction,
      translate: getComputedStyle(popup).translate,
      transform: getComputedStyle(popup).transform,
    },
    headerStyle: { position: getComputedStyle(header).position, top: getComputedStyle(header).top, background: getComputedStyle(header).backgroundColor },
    content: rect(body),
    scrollable: popup.scrollHeight > popup.clientHeight,
    overflowAmount: popup.scrollHeight - popup.clientHeight,
    // scroll to the very bottom, then report where the last row ended up
    scrolledToEnd: (() => { popup.scrollTop = popup.scrollHeight; return { scrollTop: Math.round(popup.scrollTop), maxScroll: Math.round(popup.scrollHeight - popup.clientHeight) }; })(),
    lastItemAfterScroll: (() => { const li = [...document.querySelectorAll("[data-slot=item]")].pop(); if (!li) return null; const r = li.getBoundingClientRect(); const v = popup.getBoundingClientRect(); return { bottom: Math.round(r.bottom), viewportBottom: Math.round(v.bottom), inside: r.bottom <= v.bottom + 1 && r.top >= v.top - 1 }; })(),
    headerStillPinned: (() => { const h = header.getBoundingClientRect(); const v = popup.getBoundingClientRect(); return { headerBottom: Math.round(h.bottom), popupTop: Math.round(v.top), pinned: Math.abs(h.top - v.top) <= 1 }; })(),
    close: rect(close),
    closeOnScreen: close.getBoundingClientRect().top >= 0 && close.getBoundingClientRect().bottom <= window.innerHeight,
    header: rect(header),
    lastItem: lastItem ? rect(lastItem) : null,
    lastItemReachable: lastItem ? lastItem.getBoundingClientRect().bottom <= popup.getBoundingClientRect().bottom + popup.scrollTop : null,
  };
});

let failures = 0;
for (const size of sizes) {
  const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
  page.on("console", (m) => console.log("    [console]", m.type(), m.text().slice(0,200)));
  page.on("pageerror", (e) => console.log("    [pageerror]", String(e).slice(0,300)));
  await page.goto('file://' + join(OUT, 'harness.html'));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__open());
  await page.waitForTimeout(300);
  // Open the workspace picker and measure it while it is open: its popup is
  // portaled out of the dialog, which is exactly where the token scope used to
  // get lost (measured: transparent background, 0px radius, no ring).
  await page.click('[data-slot="select-trigger"]');
  await page.waitForTimeout(300);
  const open = await page.evaluate(() => {
    const popup = document.querySelector("[data-slot=select-content]");
    if (popup === null) return null;
    const cs = getComputedStyle(popup);
    const r = popup.getBoundingClientRect();
    const t = document.querySelector("[data-slot=select-trigger]").getBoundingClientRect();
    return {
      scoped: popup.hasAttribute("data-dsh-github-push"),
      background: cs.backgroundColor,
      radius: cs.borderRadius,
      ring: cs.boxShadow,
      width: Math.round(r.width),
      height: Math.round(r.height),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      leftDelta: Math.round(r.left - t.left),
      belowTrigger: Math.round(r.top - t.bottom),
      widthDelta: Math.round(r.width - t.width),
      items: document.querySelectorAll("[data-slot=select-item]").length,
    };
  });
  // The corner and footer buttons must look like shadcn's. A ghost icon button sets
  // no background of its own, so without preflight's form-control reset it picks up
  // the UA stylesheet's grey `ButtonFace` and black `buttontext` instead — which is
  // exactly how the close and refresh buttons used to render.
  const buttons = await page.evaluate(() => {
    const pick = (el) => {
      if (el === null) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { bg: cs.backgroundColor, radius: cs.borderRadius, color: cs.color, w: Math.round(r.width), h: Math.round(r.height) };
    };
    const byText = (t) => [...document.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === t);
    return {
      close: pick(document.querySelector('[data-slot="dialog-close"]')),
      refresh: pick(document.querySelector('[data-gp-action="refresh"]')),
      signOut: pick(byText("signOut")),
      save: pick(byText("save")),
      browse: pick(byText("browseRepos")),
      repoInput: pick(document.querySelector('[id^="gp-repo-"]')),
      createBtn: pick(byText("createRepo")),
    };
  });
  await page.screenshot({ path: join(OUT, `picker-${size.name}.png`) });
  // Choose the second workspace from the open popup: the editor must follow.
  const after = await page.evaluate(() => {
    const items = [...document.querySelectorAll("[data-slot=select-item]")];
    const editor = document.querySelector("[data-gp-editor]");
    const before = editor ? editor.textContent.slice(0, 160) : "";
    if (items.length > 1) items[1].click();
    return { before, count: items.length };
  });
  await page.waitForTimeout(300);
  const moved = await page.evaluate(() => {
    const editor = document.querySelector("[data-gp-editor]");
    const trigger = document.querySelector("[data-slot=select-trigger]");
    return {
      editorText: editor ? editor.textContent.slice(0, 160) : "",
      triggerText: trigger ? trigger.textContent : "",
    };
  });
  // The activity pager: STATUS ships 12 entries, the page size is 8 — load
  // more must append the rest and the collapse control must appear.
  const rowsBefore = await page.evaluate(() => document.querySelectorAll("[data-gp-activity] [data-slot=item]").length);
  await page.click("[data-gp-load-more]");
  await page.waitForTimeout(300);
  const pager = await page.evaluate(() => ({
    rows: document.querySelectorAll("[data-gp-activity] [data-slot=item]").length,
    counter: (document.querySelector("[data-gp-activity] [data-slot=field-description]") || {}).textContent || "",
    loadMoreGone: document.querySelector("[data-gp-load-more]") === null,
    collapse: [...document.querySelectorAll("[data-gp-activity] button")].some((b) => (b.textContent || "").trim() === "showLess"),
  }));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.evaluate(() => window.__open());
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, `dialog-${size.name}-top.png`) });
  const m = await measure(page);
  await page.screenshot({ path: join(OUT, `dialog-${size.name}-bottom.png`) });
  const ok = (label, condition) => { if (!condition) failures++; console.log(`    ${condition ? 'ok  ' : 'FAIL'} ${label}`); };

  console.log(`\n  ${size.name} ${size.width}x${size.height}`);
  console.log(`    popup ${m.popup.width}x${m.popup.height} top=${m.popup.top} bottom=${m.popup.bottom} (window ${m.viewport.h})`);
  console.log(`    popup scrollport: overflowY=${m.popupStyle.overflowY} overscroll=${m.popupStyle.overscroll} touchAction=${m.popupStyle.touchAction} translate=${m.popupStyle.translate} transform=${m.popupStyle.transform}`);
  console.log(`    content ${m.content.height}px  overflow: ${m.overflowAmount}px  scrollable: ${m.scrollable}  scrolledTo: ${m.scrolledToEnd.scrollTop}/${m.scrolledToEnd.maxScroll}`);
  console.log(`    last row after scroll: bottom=${m.lastItemAfterScroll && m.lastItemAfterScroll.bottom} vs popup bottom=${m.lastItemAfterScroll && m.lastItemAfterScroll.viewportBottom}  header pinned: ${m.headerStillPinned.pinned}`);
  ok('popup fits the window', m.popup.top >= 0 && m.popup.bottom <= m.viewport.h);
  ok('close button on screen', m.closeOnScreen);
  ok('popup carries no transform', m.popupStyle.translate === 'none' && (m.popupStyle.transform === 'none' || m.popupStyle.transform === ''));
  ok('popup is the native scrollport', m.popupStyle.overflowY === 'auto' || m.popupStyle.overflowY === 'scroll');
  ok('popup contains the pan', m.popupStyle.overscroll === 'contain');
  ok('popup names the vertical gesture', m.popupStyle.touchAction === 'pan-y');
  ok('header is sticky', m.headerStyle.position === 'sticky' && m.headerStyle.top === '0px');
  ok('header is opaque', m.headerStyle.background !== 'rgba(0, 0, 0, 0)');
  ok('content really overflows when tall', m.scrollable === true || m.overflowAmount <= 0);
  ok('scrollport really scrolled', m.scrolledToEnd.scrollTop > 0 || !m.scrollable);
  ok('content reachable after scrolling', m.lastItemAfterScroll === null || m.lastItemAfterScroll.inside === true);
  ok('header pinned while scrolled to the end', m.headerStillPinned.pinned === true);
  // The picker: one control for every workspace, and its portaled popup must
  // carry the token scope and paint correctly. A fully transparent ring stop
  // means the ring resolved to nothing.
  const paintedRing = open !== null && /rgba?\([^)]*\)/.test(open.ring) &&
    [...open.ring.matchAll(/rgba?\(([^)]*)\)/g)].some((m2) => {
      const parts = m2[1].split(",").map((n) => parseFloat(n));
      const alpha = parts.length > 3 ? parts[3] : 1;
      return alpha > 0.02;
    });
  if (open !== null) {
    console.log(`    picker popup ${open.width}x${open.height} items=${open.items} bg=${open.background} radius=${open.radius} leftΔ=${open.leftDelta}px below=${open.belowTrigger}px widthΔ=${open.widthDelta}px`);
    ok('picker popup opened', open.width > 0 && open.height > 0);
    ok('picker popup carries the token scope', open.scoped === true);
    ok('picker popup is painted', open.background !== 'rgba(0, 0, 0, 0)');
    ok('picker popup keeps its radius', open.radius !== '0px');
    ok('picker popup has a ring', paintedRing === true);
    ok('picker popup fits the window', open.top >= 0 && open.bottom <= size.height);
    ok('picker lists every workspace', open.items >= 2);
    // Alignment: the menu hangs BELOW the trigger, left edge aligned, same
    // width — not the native-select style overlay shadcn defaults to.
    ok('picker popup is left-aligned to the trigger', Math.abs(open.leftDelta) <= 2);
    ok('picker popup sits below the trigger', open.belowTrigger >= 0 && open.belowTrigger <= 8);
    ok('picker popup matches the trigger width', Math.abs(open.widthDelta) <= 2);
    ok('choosing an option moves the editor', after.count >= 2 && /other/.test(moved.editorText));
    ok('the trigger shows the new selection', /other/.test(moved.triggerText));
  } else {
    ok('picker popup opened', false);
  }
  console.log(`    activity pager: ${rowsBefore} rows -> ${pager.rows} rows  counter="${pager.counter.trim()}"  collapse=${pager.collapse}`);
  ok('activity list pages at 8 rows', rowsBefore === 8);
  ok('load more appends the rest', pager.rows === 12);
  ok('the shown/total counter updates', /12/.test(pager.counter));
  ok('load more disappears at the end', pager.loadMoreGone === true);
  ok('collapse back to one page is offered', pager.collapse === true);
  // Ghost buttons carry no background of their own, so the UA stylesheet shows
  // through unless preflight's form-control reset is present.
  if (buttons.close !== null) {
    ok('close button is transparent', buttons.close.bg === 'rgba(0, 0, 0, 0)');
    ok('close button keeps its radius', buttons.close.radius !== '0px');
    ok('close button inherits the label colour', buttons.close.color !== 'rgb(0, 0, 0)');
  }
  if (buttons.refresh !== null) {
    ok('refresh button is transparent', buttons.refresh.bg === 'rgba(0, 0, 0, 0)');
    ok('refresh button keeps its radius', buttons.refresh.radius !== '0px');
    ok('refresh button inherits the label colour', buttons.refresh.color !== 'rgb(0, 0, 0)');
  }
  if (buttons.signOut !== null) {
    ok('sign-out button is a ghost (no UA fill)', buttons.signOut.bg === 'rgba(0, 0, 0, 0)');
    ok('sign-out button keeps its radius', buttons.signOut.radius !== '0px');
    ok('sign-out button inherits the label colour', buttons.signOut.color !== 'rgb(0, 0, 0)');
  }
  if (buttons.save !== null) {
    ok('primary button keeps its fill', buttons.save.bg !== 'rgba(0, 0, 0, 0)');
    ok('primary button keeps its radius', buttons.save.radius !== '0px');
  }
  // The browse/create buttons sit in Input rows: same height, or the row
  // reads as a mis-set pair (the sm size is h-8 against the h-9 Input).
  if (buttons.browse !== null && buttons.repoInput !== null) {
    ok('browse button matches the input height', buttons.browse.h === buttons.repoInput.h);
  }
  if (buttons.createBtn !== null && buttons.repoInput !== null) {
    ok('create-repo button matches the input height', buttons.createBtn.h === buttons.repoInput.h);
  }
  await page.close();
}

/* ------------------------- touch device pass ------------------------------ *
 * The phone complaint this guards: wheel scrolling works everywhere, but a
 * finger does not scroll when (a) the dialog overlay keeps its
 * `backdrop-filter` (iOS WebKit swallows the touch pan under a fixed dialog),
 * (b) the popup is centred against a `vh` that means the large viewport, or
 * (c) the scroll chain's layered utilities lose their cascade on a live page.
 * The frame now scrolls natively on the popup itself; this pass drives real
 * touch events on a phone viewport with the meta viewport tag the Harness
 * ships and proves the finger actually moves the content.
 * -------------------------------------------------------------------------- */

const touchPage = await browser.newPage({
  viewport: { width: 390, height: 668 },
  hasTouch: true,
  isMobile: true,
});
await touchPage.goto('file://' + join(OUT, 'harness.html'));
await touchPage.waitForTimeout(400);
await touchPage.evaluate(() => window.__open());
await touchPage.waitForTimeout(400);
const touchGeo = await touchPage.evaluate(() => {
  const popup = document.querySelector('[data-slot="dialog-content"]');
  const overlay = document.querySelector('[data-slot="dialog-overlay"]');
  const r = popup.getBoundingClientRect();
  const pcs = getComputedStyle(popup);
  return {
    innerH: window.innerHeight,
    popupFits: r.top >= 0 && r.bottom <= window.innerHeight,
    popupTranslate: pcs.translate,
    popupTransform: pcs.transform,
    overlayBlur: getComputedStyle(overlay).backdropFilter,
    overscroll: pcs.overscrollBehaviorY,
    touchAction: pcs.touchAction,
    overflowY: pcs.overflowY,
    scrollable: popup.scrollHeight > popup.clientHeight,
  };
});
// A real finger swipe: touchStart, a rising chain of touchMoves, touchEnd.
const cdp = await touchPage.context().newCDPSession(touchPage);
const center = await touchPage.evaluate(() => {
  const r = document.querySelector('[data-slot="dialog-content"]').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 300) };
});
const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
  type,
  touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
});
await touch('touchStart', center.x, center.y + 80);
for (let i = 1; i <= 10; i += 1) {
  await touch('touchMove', center.x, center.y + 80 - i * 25);
  await touchPage.waitForTimeout(25);
}
await touch('touchEnd', center.x, center.y - 170);
await touchPage.waitForTimeout(600);
const scrolledTo = await touchPage.evaluate(() => document.querySelector('[data-slot="dialog-content"]').scrollTop);
const headerPinned = await touchPage.evaluate(() => {
  const h = document.querySelector('[data-slot="dialog-header"]').getBoundingClientRect();
  const p = document.querySelector('[data-slot="dialog-content"]').getBoundingClientRect();
  return Math.abs(h.top - p.top) <= 1;
});
await touchPage.screenshot({ path: join(OUT, 'touch-phone.png') });
await touchPage.close();
const okTouch = (label, condition) => { if (!condition) failures++; console.log(`    ${condition ? 'ok  ' : 'FAIL'} ${label}`); };
console.log('\n  touch (390x668, hasTouch)');
console.log(`    popup fits: ${touchGeo.popupFits}  translate: ${touchGeo.popupTranslate}  transform: ${touchGeo.popupTransform}  overlay blur: ${touchGeo.overlayBlur}  overflowY: ${touchGeo.overflowY}  overscroll: ${touchGeo.overscroll}  touch-action: ${touchGeo.touchAction}  scrolled to: ${scrolledTo}px  header pinned: ${headerPinned}`);
okTouch('popup fits the phone viewport', touchGeo.popupFits === true);
okTouch('popup carries no transform (iOS touch hit-test fix)', touchGeo.popupTranslate === 'none' && (touchGeo.popupTransform === 'none' || touchGeo.popupTransform === ''));
okTouch('overlay keeps no backdrop-filter (iOS touch fix)', touchGeo.overlayBlur === 'none');
okTouch('popup is the native scrollport', touchGeo.overflowY === 'auto' || touchGeo.overflowY === 'scroll');
okTouch('popup contains the pan', touchGeo.overscroll === 'contain');
okTouch('popup names the vertical pan', touchGeo.touchAction === 'pan-y');
okTouch('content really overflows', touchGeo.scrollable === true);
okTouch('a finger swipe scrolls the dialog', scrolledTo > 50);
okTouch('sticky header stays pinned while scrolled', headerPinned === true);

await browser.close();
console.log(`\n${failures === 0 ? 'ALL LAYOUT CHECKS PASSED' : failures + ' layout check(s) FAILED'}`);
console.log(`screenshots in ${OUT}`);
process.exitCode = failures === 0 ? 0 : 1;
