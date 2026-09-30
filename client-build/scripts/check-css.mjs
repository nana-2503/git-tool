/**
 * Report which classes the vendored components and the plugin name in
 * `className` but the compiled stylesheet does not define. Tailwind's scanner
 * occasionally skips a heavily-escaped arbitrary variant, and a silently missing
 * utility is a real visual bug — so this is checked rather than assumed.
 *
 * A class counts as defined when the stylesheet carries either its full form
 * (`focus:bg-accent` compiles to `.focus\:bg-accent:focus`, and no bare
 * `.bg-accent` exists) or the bare utility (`bg-popover` is used unqualified).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const UI = join(root, 'vendor', 'ui');

const css = readFileSync(join(root, 'dist', 'shadcn.css'), 'utf8');
const plugin = readFileSync(join(root, 'src', 'plugin.jsx'), 'utf8');

/** Pull every string literal that looks like a class list out of a source file. */
function classStrings(source) {
  const out = [];
  for (const m of source.matchAll(/cn\(([\s\S]*?)\)/g)) out.push(m[1]);
  for (const m of source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) out.push(m[1] ?? m[2] ?? '');
  return out;
}

/**
 * Strip every variant prefix down to the utility it modifies: `dark:`, `sm:`,
 * `hover:`, `data-[x]:`, `[&_svg]:`, `**:data-[slot=kbd]:` … A colon only counts
 * as a separator when it sits outside brackets, parens and quotes, so
 * `[&_svg:not([class*='size-'])]:size-4` reduces to `size-4` instead of to the
 * bracketed fragment. A trailing `!` is Tailwind's important marker.
 */
function utilityOf(token) {
  let depth = 0;
  let quote = null;
  let cut = -1;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) cut = i;
  }
  if (cut >= 0) token = token.slice(cut + 1);
  return token.replace(/!$/, '');
}

/** Candidate tokens: keep anything with a letter, drop quoted prose and variables. */
function candidates(text) {
  const found = new Set();
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^["'`]+|["'`,]+$/g, '');
    if (token === '' || /[^\x20-\x7E]/.test(token)) continue;
    if (/^[a-z-]/i.test(token) === false) continue;
    if (token.includes('$') || token.includes('{')) continue;
    found.add(token);
  }
  return found;
}

/** Does the compiled CSS define this class? Compare on de-escaped text. */
const flat = css.replace(/\\/g, '');
function defined(token) {
  return flat.includes('.' + token) || flat.includes('.' + utilityOf(token));
}

const files = readdirSync(UI).filter((f) => f.endsWith('.tsx'));
const missing = new Map();
const consider = (token, where) => {
  // Named group/peer anchors are not utilities; component prop names are not classes.
  if (token.startsWith('group/') || token.startsWith('peer/')) return;
  if (/^(defaultTagName|render|size|variant|className|orientation)$/.test(token)) return;
  if (defined(token)) return;
  if (!missing.has(token)) missing.set(token, new Set());
  missing.get(token).add(where);
};

for (const file of files) {
  const source = readFileSync(join(UI, file), 'utf8');
  for (const text of classStrings(source)) {
    for (const token of candidates(text)) consider(token, file);
  }
}
for (const text of classStrings(plugin)) {
  for (const token of candidates(text)) consider(token, 'plugin.jsx');
}

if (missing.size === 0) {
  console.log('every candidate is defined in the compiled stylesheet');
} else {
  console.log(`${missing.size} candidate(s) not found in dist/shadcn.css:`);
  for (const [token, where] of [...missing].sort()) {
    console.log(`  ${token}   <- ${[...where].join(', ')}`);
  }
  process.exitCode = 1;
}
