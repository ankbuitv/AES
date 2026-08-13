#!/usr/bin/env node
/**
 * Create (or promote) an administrator account.
 *
 *   npm run create-admin -- --username ank --email me@example.com [--remote]
 *   # Add --env preview only when targeting the preview database.
 *
 * The password is read from stdin without echoing and is never written to the
 * shell history, the process arguments or the logs. Only the PBKDF2 hash — in
 * exactly the format the Worker verifies — reaches the database.
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { execSql, nowSeconds, parseTarget, q } from './lib/d1.mjs';
import { hashPassword, newId } from './lib/passwords.mjs';

/**
 * When stdin is a pipe (CI, `printf ... | npm run create-admin`) the whole
 * stream is buffered once: opening a second readline interface on a closed
 * pipe would hang forever.
 */
let pipedLines = null;
async function nextPipedLine() {
  if (pipedLines === null) {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }
  return pipedLines.shift() ?? '';
}

function arg(name, fallback = undefined) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function ask(question) {
  if (!stdin.isTTY) return nextPipedLine();
  const rl = createInterface({ input: stdin, output: stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

/**
 * Prompt without echoing keystrokes.
 *
 * When stdin is not a TTY (CI, or `printf ... | npm run create-admin`) there
 * is nothing to mask, so the line is simply read — masking a pipe would hang
 * waiting for keypress events that never arrive.
 */
function askSecret(question) {
  if (!stdin.isTTY) return nextPipedLine();

  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true });
    const onData = () => {
      stdout.write('\u001b[2K\u001b[200D' + question + '*'.repeat(rl.line.length));
    };
    stdout.write(question);
    stdin.on('data', onData);
    rl.question('', (answer) => {
      stdin.removeListener('data', onData);
      rl.close();
      stdout.write('\n');
      resolve(answer);
    });
  });
}

const target = parseTarget();

const username = String(arg('username') || (await ask('Username: '))).trim().toLowerCase();
const email = String(arg('email') || (await ask('Email: '))).trim().toLowerCase();
const displayName = String(arg('display-name') || username).trim();

if (!/^[a-z0-9_]{3,24}$/.test(username)) {
  console.error('Username must be 3–24 characters of a-z, 0-9 or _');
  process.exit(1);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('That does not look like an email address.');
  process.exit(1);
}

const password = await askSecret('Password (min 10 chars): ');
if (password.length < 10) {
  console.error('Password must be at least 10 characters.');
  process.exit(1);
}
const confirm = await askSecret('Confirm password: ');
if (password !== confirm) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const hash = await hashPassword(password);
const id = newId('usr');
const ts = nowSeconds();

// Idempotent: a second run promotes the existing account and resets its
// password rather than failing on the UNIQUE constraint.
const sql = `
INSERT INTO users (
  id, username, display_name, email, password_hash,
  role, status, level, xp, created_at, updated_at, last_seen_at, email_verified_at
) VALUES (
  ${q(id)}, ${q(username)}, ${q(displayName)}, ${q(email)}, ${q(hash)},
  'admin', 'active', 1, 0, ${ts}, ${ts}, ${ts}, ${ts}
)
ON CONFLICT (username) DO UPDATE SET
  role = 'admin',
  status = 'active',
  password_hash = excluded.password_hash,
  updated_at = ${ts};

-- Revoke every existing session for that account: a password reset performed
-- out of band must not leave old sessions alive.
UPDATE sessions SET revoked_at = ${ts}
 WHERE revoked_at IS NULL
   AND user_id = (SELECT id FROM users WHERE username = ${q(username)});
`;

execSql(target, sql);

console.log(`\n✅ Administrator @${username} is ready (${target.remote ? 'remote' : 'local'}).`);
console.log('   Sign in at /login and open /admin.');
