#!/usr/bin/env node
/**
 * Bundles /migrations/*.sql into src/db/bundledMigrations.ts so the Worker
 * can apply the same files that Wrangler applies via `d1 migrations apply`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'migrations');
const files = readdirSync(dir)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const entries = files.map((file) => ({
  name: file,
  sql: readFileSync(path.join(dir, file), 'utf8'),
}));

const out = `/**
 * AUTO-GENERATED from /migrations. Do not edit by hand.
 * Regenerate with: node scripts/bundle-migrations.mjs
 */

export interface BundledMigration {
  name: string;
  sql: string;
}

export const BUNDLED_MIGRATIONS: BundledMigration[] = ${JSON.stringify(entries, null, 2)};
`;

writeFileSync(path.join(root, 'src/db/bundledMigrations.ts'), out);
console.log(`bundled ${files.length} migrations (${out.length} bytes)`);
