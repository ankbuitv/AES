/**
 * Thin wrapper around `wrangler d1 execute` for the maintenance scripts.
 *
 * The scripts never open the SQLite file directly: going through Wrangler is
 * what makes the same script work against the local dev database, a preview
 * database and production, and keeps the credentials in Wrangler's hands.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function parseTarget(argv = process.argv.slice(2)) {
  const remote = argv.includes('--remote');
  const envIndex = argv.indexOf('--env');
  const env = envIndex >= 0 ? argv[envIndex + 1] : undefined;
  return { remote, env, local: !remote };
}

function baseArgs(target) {
  const database = target.env === 'preview' ? 'ank-social-preview' : 'ank-social';
  const args = ['d1', 'execute', database];
  if (target.env) args.push('--env', target.env);
  args.push(target.remote ? '--remote' : '--local');
  return args;
}

/**
 * Execute one or more SQL statements. Long scripts are written to a temp file
 * and passed with `--file`, which avoids shell argument length limits.
 */
export function execSql(target, sql, { json = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ank-sql-'));
  const file = path.join(dir, 'statements.sql');
  writeFileSync(file, sql, 'utf8');

  try {
    const args = [...baseArgs(target), '--file', file, '--yes'];
    if (json) args.push('--json');

    const result = spawnSync('npx', ['wrangler', ...args], {
      encoding: 'utf8',
      stdio: json ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });

    if (result.status !== 0) {
      throw new Error(`wrangler d1 execute failed with exit code ${result.status}`);
    }

    if (!json) return null;
    const text = result.stdout ?? '';
    const start = text.indexOf('[');
    if (start < 0) return [];
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return [];
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** SQL string literal with proper escaping — the scripts build DDL/DML text. */
export function q(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
