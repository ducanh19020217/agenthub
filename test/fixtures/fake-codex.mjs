#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import './orphan-guard.mjs';

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log('Codex CLI Mock');
  console.log('  exec [options] <prompt>');
  process.exit(0);
}

// Find prompt (last argument that doesn't start with -)
let prompt = '';
for (let i = args.length - 1; i >= 0; i--) {
  if (!args[i].startsWith('-') && (i === 0 || !args[i - 1].startsWith('-m') && !args[i - 1].startsWith('-C'))) {
    prompt = args[i];
    break;
  }
}

const currentRequest = prompt.includes('[Yêu cầu]') ? prompt.slice(prompt.lastIndexOf('[Yêu cầu]')) : prompt;

// Check for quota simulation
if (process.env.FAKE_CODEX_QUOTA === '1' || currentRequest.includes('sim-codex-quota')) {
  console.error('usage limit exceeded; try again in 1h');
  process.exit(1);
}

// Check for config/startup error simulation
if (process.env.FAKE_CODEX_CONFIG_ERROR === '1' || currentRequest.includes('sim-codex-config-fail') || currentRequest.includes('sim-codex-config-error')) {
  console.error('Error loading config.toml: invalid type: string "{\\"AGENTHUB_CHAT_SESSION_ID\\":\\"brain:department:chung\\"}", expected a map in `mcp_servers.agenthub.env`');
  process.exit(1);
}

// Find MCP env or session config
let mcpEnv = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-c' && args[i + 1]?.startsWith('mcp_servers.agenthub.env=')) {
    const raw = args[i + 1].slice('mcp_servers.agenthub.env='.length);
    try {
      mcpEnv = JSON.parse(raw);
    } catch {
      mcpEnv = {};
      const inner = raw.replace(/^\{|\}$/g, '').trim();
      if (inner) {
        const regex = /(?:([A-Za-z0-9_-]+)|"([^"]+)")\s*=\s*"((?:\\.|[^"\\])*)"/g;
        let match;
        while ((match = regex.exec(inner)) !== null) {
          const key = match[1] || match[2];
          const val = match[3].replace(/\\([\\"])/g, '$1');
          mcpEnv[key] = val;
        }
      }
    }
  }
}

// If task review is requested via prompt or env
const reviewMatch = prompt.match(/hub_review\s+([a-zA-Z0-9_/-]+)/) || prompt.match(/task\s+([a-zA-Z0-9_/-]+)/);
const taskId = process.env.FAKE_CODEX_TASK_ID || (reviewMatch ? reviewMatch[1] : undefined);

async function run() {
  if (taskId && (mcpEnv.AGENTHUB_PORT || process.env.AGENTHUB_PORT)) {
    const port = mcpEnv.AGENTHUB_PORT || process.env.AGENTHUB_PORT;
    const tokenPath = path.join(process.env.AGENTHUB_HOME || '', 'token');
    let token = '';
    try {
      token = fs.readFileSync(tokenPath, 'utf8').trim();
    } catch { /* ignore */ }

    // Execute actual review via HTTP API if token and port are available
    if (token && port) {
      try {
        const routeId = taskId.replace(/\//g, ':');
        await fetch(`http://127.0.0.1:${port}/api/tasks/${routeId}/review`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            verdict: 'approved',
            feedback: 'Codex review approved via MCP simulation.',
            by: 'codex-reviewer',
          }),
        });
      } catch { /* ignore API call failure in standalone unit tests */ }
    }
  }

  // Stream output in JSON format
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-codex-123' }));

  if (taskId) {
    console.log(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'call_codex_rev_1',
            name: 'hub_review',
            input: { id: taskId, verdict: 'approved', feedback: 'Codex approved.' },
          },
        ],
        usage: { input_tokens: 120, output_tokens: 30 },
      },
    }));
    console.log(JSON.stringify({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'call_codex_rev_1', content: '{"ok":true}' }],
      },
    }));
  }

  const responseText = taskId
    ? `Tôi đã gọi hub_review và duyệt task ${taskId} thành công.`
    : 'Xin chào, tôi là bộ não Codex!';

  console.log(JSON.stringify({
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: responseText }],
      usage: { input_tokens: 200, output_tokens: 50 },
    },
  }));

  console.log(JSON.stringify({
    type: 'result',
    session_id: 'sess-codex-123',
    is_error: false,
    result: responseText,
    usage: { input_tokens: 200, output_tokens: 50 },
  }));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
