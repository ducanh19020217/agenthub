#!/usr/bin/env node

/**
 * Fake agent for testing. Behavior controlled by FAKE_MODE env var:
 * - done: creates .agenthub/DONE
 * - blocked: creates .agenthub/BLOCKED
 * - quota: prints quota error to stdout
 * - crash: exits with code 1
 * - slow: waits 60 seconds then creates DONE
 * - sleep-loop: runs until killed (or until orphan-guard exits it)
 */

import fs from 'node:fs';
import path from 'node:path';
import './orphan-guard.mjs';

const mode = process.env.FAKE_MODE || 'done';
const cwd = process.env.FAKE_CWD || process.cwd();
const agentHubDir = path.join(cwd, '.agenthub');

// Ensure .agenthub directory exists
if (!fs.existsSync(agentHubDir)) {
  fs.mkdirSync(agentHubDir, { recursive: true });
}

async function run() {
  const reviewerResults = {
    'reviewer-approved': { verdict: 'approved', feedback: 'Diff and required checks reviewed.' },
    'reviewer-changes': { verdict: 'changes_requested', feedback: 'Please fix the failing check.' },
    'reviewer-malformed': 'not a reviewer result',
    'reviewer-mentions-limit': { verdict: 'approved', feedback: 'ElevenLabs client now maps HTTP 429 rate limit to a retryable error.' },
  };
  const auditResults = {
    'audit-pass': { verdict: 'pass', findings: [], summary: 'Pre-publish audit passed.' },
    'audit-p3': {
      verdict: 'pass',
      findings: [{ severity: 'P3', kind: 'out_of_scope', file: 'README.md', line: 1, detail: 'Minor typo in doc' }],
      summary: 'Pass with P3 notice.',
    },
    'audit-fail': {
      verdict: 'fail',
      findings: [{ severity: 'P1', kind: 'wrong_requirement', file: 'src/main.ts', line: 10, detail: 'Missing required feature X' }],
      summary: 'Audit failed due to missing requirements.',
    },
    'audit-fail-empty': {
      verdict: 'fail',
      findings: [],
      summary: 'Fail without findings.',
    },
    'audit-malformed': 'not valid json {',
  };
  if (mode.startsWith('audit-')) {
    if (mode === 'audit-error') {
      process.stderr.write('audit spawn failed');
      process.exit(1);
    }
    if (mode === 'audit-quota') {
      console.error('usage limit exceeded; try again in 2h 3m');
      process.exit(1);
    }
    if (mode === 'audit-malformed') {
      if (process.env.FAKE_OUTPUT_PATH) {
        fs.writeFileSync(process.env.FAKE_OUTPUT_PATH, 'malformed json {{{');
      }
      return;
    }
    if (process.env.FAKE_OUTPUT_PATH) {
      fs.writeFileSync(process.env.FAKE_OUTPUT_PATH, JSON.stringify(auditResults[mode] || auditResults['audit-pass']));
    }
    return;
  }
  if (process.env.FAKE_OUTPUT_PATH && (process.env.FAKE_PROMPT || '').includes('Pre-Publish Audit Agent')) {
    fs.writeFileSync(process.env.FAKE_OUTPUT_PATH, JSON.stringify(auditResults['audit-pass']));
    return;
  }
  if (mode.startsWith('reviewer-')) {
    if (mode === 'reviewer-chatter') {
      console.log('Codex banner: starting read-only review');
      console.log('tool chatter: inspected git diff and test output');
      fs.writeFileSync(process.env.FAKE_OUTPUT_PATH, JSON.stringify(reviewerResults['reviewer-approved']));
      console.log('Codex banner: finished');
      return;
    }
    if (mode === 'reviewer-auth-word-approved') {
      console.log('Inspecting auth module: handling 401 unauthenticated and rate limit 429');
      fs.writeFileSync(process.env.FAKE_OUTPUT_PATH, JSON.stringify({
        verdict: 'approved',
        feedback: 'Reviewed auth module: 401 unauthenticated and 429 rate limit errors handled properly.',
      }));
      return;
    }
    if (mode === 'reviewer-quota') {
      console.error('usage limit exceeded; try again in 2h 3m');
      process.exit(1);
    }
    if (mode === 'reviewer-missing-output') {
      console.log('{"verdict":"approved","feedback":"This must not be accepted from chatter."}');
      return;
    }
    if (mode === 'reviewer-error') {
      process.stderr.write('spawn failed');
      process.exit(1);
    }
    if (mode === 'reviewer-erofs') {
      fs.writeFileSync(process.env.FAKE_OUTPUT_PATH, JSON.stringify({ verdict: 'changes_requested', feedback: 'EROFS: reviewer cannot write temp output' }));
      return;
    }
    if (mode === 'reviewer-erofs-log') {
      console.error(process.env.FAKE_PROMPT);
      fs.writeFileSync(process.env.FAKE_OUTPUT_PATH, JSON.stringify({ verdict: 'changes_requested', feedback: 'The implementation leaves a race condition in the scheduler and does not persist the retry state consistently, so the reviewer cannot approve this change yet.' }));
      return;
    }
    fs.writeFileSync(process.env.FAKE_OUTPUT_PATH, JSON.stringify(reviewerResults[mode] ?? reviewerResults['reviewer-malformed']));
    return;
  }
  switch (mode) {
    case 'done-tokens':
      // Codex prints its token usage at the end of the run.
      console.log('tokens used');
      console.log('1.234');
    // falls through
    case 'done':
      console.log('Fake agent: completing task...');
      fs.writeFileSync(
        path.join(agentHubDir, 'DONE'),
        'Task completed successfully.\n\n- All tests pass\n- No remaining work',
      );
      console.log('Fake agent: done');
      break;

    case 'blocked':
      console.log('Fake agent: task is blocked...');
      fs.writeFileSync(
        path.join(agentHubDir, 'BLOCKED'),
        'Cannot proceed: missing dependency X.',
      );
      console.log('Fake agent: blocked');
      break;

    case 'quota':
      console.log('Fake agent: running...');
      // Simulate some work output first
      console.log('Working on task...');
      console.log('Making progress...');
      // Then quota error at the end
      console.log('AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h2m3s."}');
      process.exit(1);
      break;

    case 'auth-p1':
      if (process.env.FAKE_PROFILE === 'p1') {
        console.log('AGY_ERROR: {"short_error":"UNAUTHENTICATED (code 401): Request had invalid authentication credentials.","error_code":401}');
        process.exit(1);
      }
      fs.writeFileSync(path.join(agentHubDir, 'DONE'), 'done');
      break;

    case 'crash':
      console.log('Fake agent: crashing...');
      process.exit(1);
      break;

    case 'slow':
      console.log('Fake agent: working slowly...');
      await new Promise((resolve) => setTimeout(resolve, 60000));
      fs.writeFileSync(
        path.join(agentHubDir, 'DONE'),
        'Task completed (slowly).',
      );
      break;

    case 'sleep-done': {
      console.log('Fake agent: sleep-done waiting for trigger...');
      const triggerFile = path.join(agentHubDir, 'TRIGGER_DONE');
      let waiting = true;
      while (waiting) {
        if (fs.existsSync(triggerFile) || process.env.STOP_SLEEP === '1') {
          waiting = false;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      fs.writeFileSync(
        path.join(agentHubDir, 'DONE'),
        'Task completed successfully.\n\n- All tests pass\n- No remaining work',
      );
      console.log('Fake agent: sleep-done finished with DONE');
      break;
    }

    case 'sleep-loop': {
      console.log('Fake agent: sleep loop...');
      let running = true;
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (process.env.STOP_SLEEP === '1') {
          running = false;
        }
      }
      break;
    }

    case 'transient':
      console.log('Fake agent: transient error...');
      console.log('error: failed to send message: UNAVAILABLE (code 503): The service is currently unavailable.');
      process.exit(1);
      break;

    default:
      console.log(`Unknown FAKE_MODE: ${mode}`);
      process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
