/**
 * Prove the vendored components really come from shadcn's own installer.
 *
 * The check is end-to-end rather than a re-implementation of the installer's
 * rewriting: it stands up a throwaway project with the same components.json,
 * runs the very command the shadcn MCP returns, applies the one shared codemod,
 * and diffs the result against `vendor/ui/`. Identical bytes mean the files on
 * disk are the official registry output plus that codemod and nothing else.
 *
 * A difference is not automatically a failure — shadcn may have published a new
 * revision since the last `npm run vendor` — but it is always reported, and
 * re-running the vendor step is what resolves it.
 *
 * Run with: node tests/verify-vendor.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { codemod } from '../scripts/codemod.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const COMPONENTS = [
  'button', 'card', 'badge', 'input', 'label', 'separator', 'switch', 'spinner',
  'alert', 'empty', 'field', 'dialog', 'select', 'scroll-area', 'skeleton', 'item',
];

/* --------------------------- a throwaway project -------------------------- */

const scratch = mkdtempSync(join(tmpdir(), 'shadcn-verify-'));
mkdirSync(join(scratch, 'vendor', 'ui'), { recursive: true });
writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'shadcn-verify', private: true, type: 'module' }, null, 2));
writeFileSync(join(scratch, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2020', lib: ['DOM', 'ES2020'], jsx: 'react-jsx', module: 'ESNext',
    moduleResolution: 'bundler', baseUrl: '.', paths: { '@/*': ['./*'] },
    strict: true, skipLibCheck: true, noEmit: true,
  },
  include: ['vendor'],
}, null, 2));
// Same shape as the build workspace's components.json: Base UI base, vega style.
writeFileSync(join(scratch, 'components.json'), JSON.stringify({
  $schema: 'https://ui.shadcn.com/schema.json',
  style: 'base-vega',
  tailwind: { config: '', css: 'src/styles.css', baseColor: 'neutral', cssVariables: true },
  rsc: false,
  tsx: true,
  aliases: {
    components: 'src/components',
    ui: 'vendor/ui',
    utils: 'vendor/lib/utils',
    lib: 'src/lib',
    hooks: 'src/hooks',
  },
  iconLibrary: 'lucide',
}, null, 2));
// The installer reads the project's stylesheet to decide which font classes to
// inject (`font-heading` on CardTitle / DialogTitle / EmptyTitle once the theme
// declares `--font-heading`). Mirror it, or a fresh install legitimately differs
// from the vendored copy for a reason that has nothing to do with provenance.
mkdirSync(join(scratch, 'src'), { recursive: true });
writeFileSync(join(scratch, 'src', 'styles.css'), readFileSync(join(root, 'src', 'styles.css')));

console.log(`running the official installer in ${scratch}`);
execFileSync(
  'npx',
  ['--yes', 'shadcn@latest', 'add', ...COMPONENTS.map((name) => `@shadcn/${name}`), '--yes', '--overwrite', '--cwd', scratch],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

/* -------------------------------- the diff -------------------------------- */

let identical = 0;
const drifted = [];

for (const file of readdirSync(join(root, 'vendor', 'ui')).filter((f) => f.endsWith('.tsx')).sort()) {
  const fresh = join(scratch, 'vendor', 'ui', file);
  let expected;
  try {
    expected = codemod(readFileSync(fresh, 'utf8'), file);
  } catch {
    drifted.push(`${file} (not produced by the installer)`);
    console.log(`  ${file.padEnd(16)} NOT PRODUCED by the installer`);
    continue;
  }
  const onDisk = readFileSync(join(root, 'vendor', 'ui', file), 'utf8');
  if (expected === onDisk) {
    identical++;
    console.log(`  ${file.padEnd(16)} identical`);
  } else {
    drifted.push(file);
    console.log(`  ${file.padEnd(16)} DIFFERS`);
    const a = expected.split('\n');
    const b = onDisk.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.log(`      line ${i + 1}`);
        console.log(`        installer: ${JSON.stringify(a[i])}`);
        console.log(`        on disk  : ${JSON.stringify(b[i])}`);
        break;
      }
    }
  }
}

console.log(`\n${identical} file(s) identical to a fresh official install.`);
if (drifted.length > 0) {
  console.log('drifted: ' + drifted.join(', '));
  console.log('re-run `npm run vendor` to pick up the published revision.');
  process.exitCode = 1;
}
