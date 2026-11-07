#!/usr/bin/env node
// Fake interactive Claude Code for runClaudeUsage: the onboarding screens of CLI 2.1.x
// (theme picker, security notes, trust folder) must each be answered before the prompt
// appears; then `/usage` prints the recorded usage screen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-usage.txt'), 'utf8');
const screens = [
  { text: 'Choose the text style that looks best with your terminal\n❯ 1. Dark mode\nSyntax theme: Monokai Extended (ctrl+t to disable)\n', advance: (input) => input.includes('\r') },
  { text: 'Security notes:\n1. Claude can make mistakes.\nPress Enter to continue…\n', advance: (input) => input.includes('\r') },
  { text: 'Quick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder\nEnter to confirm · Esc to cancel\n', advance: (input, seen) => seen.includes('\x1b[B') && input.includes('\r') },
];

let step = 0;
let seen = '';
let typed = '';
process.stdin.setRawMode?.(true);
process.stdout.write(screens[0].text);
process.stdin.on('data', (chunk) => {
  const input = chunk.toString();
  if (step < screens.length) {
    // Keys sent before a screen is shown do not count for it.
    seen += input;
    if (screens[step].advance(input, seen)) {
      seen = '';
      step += 1;
      process.stdout.write(step < screens.length ? screens[step].text : '\n❯ ');
    } else if (step === 2 && input.includes('\r')) {
      process.exit(1); // "No, exit"
    }
    return;
  }
  if (input === '\x1b') process.exit(0);
  typed += input;
  if (typed.includes('/usage') && input.includes('\r')) process.stdout.write(usage);
});
