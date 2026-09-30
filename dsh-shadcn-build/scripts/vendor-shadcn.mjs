/**
 * Vendor the official shadcn components for this plugin's Client half.
 *
 * Source of truth: shadcn's own installer, i.e. exactly the command the shadcn
 * MCP returns for these registry items:
 *
 *   npx shadcn@latest add @shadcn/<name> … --yes --overwrite
 *
 * It resolves each item for this project's `style: base-vega` (the Base UI base)
 * out of components.json, writes the file, and rewrites the two things that only
 * make sense inside a shadcn app: the `@/registry/...` import aliases and the
 * docs-site `IconPlaceholder` shim (its `lucide` prop names the real icon).
 *
 * Two rewrites are still needed here, because we consume the result outside a
 * shadcn project:
 *   1. `"use client"` is a Next directive; noise in a Cordis client bundle.
 *   2. the installer writes sibling imports through this project's `ui` alias
 *      (`vendor/ui/button`); in one flat directory they become `./button`.
 *
 * The published style layer is deliberately NOT vendored. An earlier revision of
 * these components carried `cn-*` recipe classes defined in
 * `apps/v4/registry/styles/style-vega.css`; the current ones name only Tailwind
 * utilities, so there is no style layer to compile — and none to unwrap (that
 * unwrap existed because Base UI portals the dialog popup into `document.body`,
 * leaving no ancestor to carry shadcn's `.style-vega` scope).
 *
 * tests/verify-vendor.mjs re-fetches every item from the registry and proves the
 * files on disk are that source plus exactly these rewrites.
 *
 * Run with: npm run vendor
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codemod } from './codemod.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const UI_DIR = join(root, 'vendor', 'ui');

/** Components this plugin renders. */
const COMPONENTS = [
  'button',
  'card',
  'badge',
  'input',
  'label',
  'separator',
  'switch',
  'spinner',
  'alert',
  'empty',
  'field',
  'dialog',
  'select',
  'scroll-area',
  'skeleton',
  'item',
];

/** Rewrite one vendored file for this flat directory. */
function rewrite(source, name) {
  return codemod(source, name);
}

execFileSync(
  'npx',
  ['--yes', 'shadcn@latest', 'add', ...COMPONENTS.map((name) => `@shadcn/${name}`), '--yes', '--overwrite', '--cwd', root],
  { stdio: 'inherit' },
);

const report = [];
for (const file of readdirSync(UI_DIR).filter((f) => f.endsWith('.tsx')).sort()) {
  const path = join(UI_DIR, file);
  const raw = readFileSync(path, 'utf8');
  const out = rewrite(raw, file);
  if (out !== raw) writeFileSync(path, out);
  const imports = [...out.matchAll(/^import[^\n]*from "([^"]+)"/gm)].map((m) => m[1]);
  report.push({ file, bytes: out.length, imports: [...new Set(imports)].sort() });
}

console.log('vendored components:');
for (const row of report) {
  console.log(`  ${row.file.padEnd(16)} ${String(row.bytes).padStart(6)}B  imports=${row.imports.join(' | ')}`);
}
const unexpected = [...new Set(report.flatMap((r) => r.imports))]
  .filter((id) => id.startsWith('.') === false)
  .filter((id) => ['react', 'cn', 'lucide-react', 'class-variance-authority'].includes(id) === false)
  .filter((id) => id.startsWith('@base-ui/react') === false);
console.log('imports outside the plan:', unexpected.length === 0 ? 'none' : unexpected.join(', '));
