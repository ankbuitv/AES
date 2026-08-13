#!/usr/bin/env node
/**
 * Wipe and rebuild the LOCAL development database.
 *
 *   npm run db:reset:local            # drop, migrate
 *   npm run db:reset:local -- --seed  # drop, migrate, seed
 *
 * Refuses to touch anything remote: the local D1 state lives under `.wrangler`
 * and deleting it is the only reliable way to replay migrations from scratch.
 */

import { rmSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--remote') || process.argv.includes('--env')) {
  console.error('This script only resets the LOCAL database. Refusing to run against a remote D1.');
  process.exit(1);
}

const stateDir = path.join(root, '.wrangler', 'state', 'v3', 'd1');
if (existsSync(stateDir)) {
  rmSync(stateDir, { recursive: true, force: true });
  console.log('• removed local D1 state');
} else {
  console.log('• no local D1 state to remove');
}

const migrations = readdirSync(path.join(root, 'migrations')).filter((f) => f.endsWith('.sql'));
console.log(`• applying ${migrations.length} migrations`);

function run(args) {
  const result = spawnSync('npx', ['wrangler', ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['d1', 'migrations', 'apply', 'ank-social', '--local']);

if (process.argv.includes('--seed')) {
  const result = spawnSync('node', [path.join(root, 'scripts', 'seed.mjs'), '--local'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('\n✅ Local database rebuilt.');
