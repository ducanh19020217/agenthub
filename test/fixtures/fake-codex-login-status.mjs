#!/usr/bin/env node
// Giả lập `codex login status`: đăng nhập khi $CODEX_HOME/auth.json có đúng cấu trúc Codex CLI.
import fs from 'node:fs';
import path from 'node:path';

const [cmd, sub] = process.argv.slice(2);
if (cmd === '--version') {
  process.stdout.write('codex-cli 0.0.0-fake\n');
  process.exit(0);
}
if (cmd !== 'login' || sub !== 'status') process.exit(2);

let ok = false;
try {
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || '', 'auth.json'), 'utf8'));
  ok = ['id_token', 'access_token', 'refresh_token'].every((key) => typeof auth?.tokens?.[key] === 'string' && auth.tokens[key]);
} catch {
  ok = false;
}
if (!ok) {
  process.stderr.write('Not logged in\n');
  process.exit(1);
}
process.stdout.write('Logged in using ChatGPT\n');
