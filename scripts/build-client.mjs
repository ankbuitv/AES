#!/usr/bin/env node
/**
 * Bundles the progressive-enhancement client (`src/client/app.ts`) into
 * `public/assets/app.js`.
 *
 * esbuild is used directly rather than a framework build: the output is one
 * small ES module with no runtime dependencies, which is all the site needs.
 * The Worker serves it from the Assets binding with a nonce'd <script> tag.
 */

import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'public', 'assets', 'app.js');
const watch = process.argv.includes('--watch');

await mkdir(path.dirname(outfile), { recursive: true });

const options = {
  entryPoints: [path.join(root, 'src', 'client', 'app.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  target: ['es2022', 'chrome110', 'firefox110', 'safari16'],
  platform: 'browser',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
  console.log('[build-client] watching src/client …');
} else {
  const result = await build(options);
  if (result.errors.length) process.exit(1);
  console.log(`[build-client] wrote ${path.relative(root, outfile)}`);
}
