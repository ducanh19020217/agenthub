#!/usr/bin/env node

import fs from 'node:fs';
import readline from 'node:readline';
import './orphan-guard.mjs';

console.log = (...values) => fs.writeSync(1, `${values.map(String).join(' ')}\n`);
console.error = (...values) => fs.writeSync(2, `${values.map(String).join(' ')}\n`);

const args = process.argv.slice(2);

// Support --help
if (args.includes('--help')) {
  console.log('Claude CLI Mock');
  console.log('  --include-partial-messages            Include partial message chunks as they');
  console.log('  -p <text>                             Prompt text');
  console.log('  --output-format <format>              Output format (stream-json)');
  if (process.env.FAKE_CLAUDE_STREAM_JSON === '1') {
    console.log('  --input-format <format>               Input format (stream-json)');
  }
  process.exit(0);
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return '';
  }
  let data = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

const resumeIdx = args.indexOf('--resume');
const resumeSessionId = resumeIdx >= 0 ? args[resumeIdx + 1] : 'sess-default-123';

async function handlePrompt(prompt) {
  if (process.env.FAKE_CLAUDE_PROFILE_LOG) {
    fs.appendFileSync(process.env.FAKE_CLAUDE_PROFILE_LOG, `${process.env.CLAUDE_CONFIG_DIR || 'system'}\n`);
  }

  if (process.env.FAKE_CLAUDE_AUTH_FAIL_HOME && process.env.FAKE_CLAUDE_AUTH_FAIL_HOME === process.env.CLAUDE_CONFIG_DIR) {
    fs.writeSync(1, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-auth-expired' })}\n`);
    fs.writeSync(1, `${JSON.stringify({ type: 'result', session_id: 'sess-auth-expired', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.exitCode = 1;
    return;
  }

  if (prompt.includes('mention-auth-phrases')) {
    fs.writeSync(1, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-auth-phrase-success' })}\n`);
    fs.writeSync(1, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The guide mentions HTTP 401 and says not logged in as examples.' }] } })}\n`);
    fs.writeSync(1, `${JSON.stringify({ type: 'result', session_id: 'sess-auth-phrase-success', is_error: false, result: 'The guide mentions HTTP 401 and says not logged in as examples.' })}\n`);
    return;
  }

  if (prompt.includes('sleep')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-sleep' }));
    await new Promise((resolve) => setTimeout(resolve, 30000));
    return;
  }

  if (prompt.trim() === 'crash') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-crash-123' }));
    process.exit(0);
  }

  if (prompt.trim() === 'idle') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-idle-123' }));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }

  if (prompt.trim() === 'permission') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-permission-123' }));
    console.log(JSON.stringify({ type: 'permission_request', message: 'Cần quyền chạy công cụ' }));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }

  if (prompt.includes('tool-wait')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tool-wait-123' }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool_wait_1', name: 'Bash', input: { command: 'long-running' } }] } }));
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }

  if (prompt.includes('tool-secret') && !prompt.includes('tool-secret-input')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tool-secret-123' }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool_secret_1', name: 'Read', input: { file_path: '/tmp/auth.json' } }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_secret_1', content: 'SECRET_TOKEN_VALUE' }] } }));
    console.log(JSON.stringify({ type: 'result', session_id: 'sess-tool-secret-123', is_error: false, result: 'Đã đọc file.' }));
    return;
  }

  if (prompt.includes('tool-secret-input')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tool-secret-input-123' }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tool_secret_write', name: 'Write', input: { file_path: '/tmp/auth.json', content: 'SECRET_WRITE_VALUE' } },
      { type: 'tool_use', id: 'tool_secret_bash', name: 'Bash', input: { command: 'cat ~/.codex/auth.json' } },
      { type: 'tool_use', id: 'tool_secret_env', name: 'Write', input: { file_path: '/tmp/.env.local', content: 'SECRET_ENV_VALUE' } },
    ] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_secret_write', content: 'SECRET_WRITE_VALUE' }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_secret_bash', content: 'SECRET_BASH_VALUE' }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_secret_env', content: 'SECRET_ENV_VALUE' }] } }));
    console.log(JSON.stringify({ type: 'result', session_id: 'sess-tool-secret-input-123', is_error: false, result: 'Đã xử lý.' }));
    return;
  }

  if (prompt.includes('tool-tokenizer')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tool-tokenizer-123' }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool_tokenizer_1', name: 'Read', input: { file_path: 'src/tokenizer.ts' } }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_tokenizer_1', content: 'NORMAL_TOKENIZER_OUTPUT' }] } }));
    console.log(JSON.stringify({ type: 'result', session_id: 'sess-tool-tokenizer-123', is_error: false, result: 'Đã đọc.' }));
    return;
  }

  if (prompt.includes('tool-multi')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tool-multi-123' }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tool_multi_a', name: 'Read', input: { file_path: 'src/a.ts' } },
      { type: 'tool_use', id: 'tool_multi_b', name: 'Bash', input: { command: 'git log -3' } },
    ] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_multi_a', content: 'A output' }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_multi_b', content: 'B output' }] } }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Assistant text after tools.' }] } }));
    console.log(JSON.stringify({ type: 'result', session_id: 'sess-tool-multi-123', is_error: false, result: 'Assistant text after tools.' }));
    return;
  }

  if (prompt.includes('tool-large')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tool-large-123' }));
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool_large_1', name: 'mcp__agenthub__Edit', input: { file_path: 'src/example.ts', old_string: 'old', new_string: 'new', content: 'x'.repeat(6000) } }] } }));
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_large_1', content: 'y'.repeat(6000) }] } }));
    console.log(JSON.stringify({ type: 'result', session_id: 'sess-tool-large-123', is_error: false, result: 'Đã sửa file.' }));
    return;
  }

  if (prompt.trim() === 'quota') {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-quota-123' }));
    console.log(JSON.stringify({ type: 'result', session_id: 'sess-quota-123', is_error: true, result: 'Usage limit reached. Try again in 1m' }));
    return;
  }

  if (prompt.includes('quota-once') && process.env.FAKE_QUOTA_ONCE_FILE && !fs.existsSync(process.env.FAKE_QUOTA_ONCE_FILE)) {
    fs.writeFileSync(process.env.FAKE_QUOTA_ONCE_FILE, 'hit\n');
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-quota-once' }));
    console.log(JSON.stringify({ type: 'result', session_id: 'sess-quota-once', is_error: true, result: 'Usage limit reached. Try again in 1m' }));
    return;
  }

  if (prompt.includes('resume-fail') && resumeIdx >= 0) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-old-123' }));
    console.log(JSON.stringify({ type: 'result', session_id: 'sess-old-123', is_error: true, result: 'Session not found for resume' }));
    return;
  }

  if (prompt.includes('/compact')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: resumeSessionId }));
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Đã nén' }],
          usage: {
            input_tokens: 10000,
            output_tokens: 20,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    );
    console.log(
      JSON.stringify({
        type: 'result',
        session_id: resumeSessionId,
        total_cost_usd: 0.001,
        duration_ms: 100,
        num_turns: 1,
        is_error: false,
        result: 'Đã nén',
        usage: {
          input_tokens: 10000,
          output_tokens: 20,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 0,
        },
      }),
    );
    return;
  }

  if (prompt.includes('Tóm tắt') || prompt.includes('summary') || prompt.includes('tóm tắt') || prompt.includes('FORK_SUMMARY')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: resumeSessionId }));
    console.log(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'Đây là bản tóm tắt nội dung phiên trước.' },
        },
      }),
    );
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Đây là bản tóm tắt nội dung phiên trước.' }],
          usage: {
            input_tokens: 5000,
            output_tokens: 100,
          },
        },
      }),
    );
    console.log(
      JSON.stringify({
        type: 'result',
        session_id: resumeSessionId,
        total_cost_usd: 0.001,
        duration_ms: 100,
        num_turns: 1,
        is_error: false,
        result: 'Đây là bản tóm tắt nội dung phiên trước.',
        usage: {
          input_tokens: 5000,
          output_tokens: 100,
        },
      }),
    );
    return;
  }

  if (prompt.includes('tool')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-tool-123' }));
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Read',
              input: { file_path: 'docs/PLAN.md' },
            },
          ],
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 200,
            output_tokens: 20,
          },
        },
      }),
    );
    console.log(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'PLAN output from fake Claude' }] } }));
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Nội dung PLAN đã đọc.',
            },
          ],
          usage: {
            input_tokens: 120,
            cache_read_input_tokens: 700,
            cache_creation_input_tokens: 100,
            output_tokens: 30,
          },
        },
      }),
    );
    console.log(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-tool-123',
        total_cost_usd: 0.002,
        duration_ms: 200,
        num_turns: 2,
        is_error: false,
        result: 'Nội dung PLAN đã đọc.',
        usage: {
          input_tokens: 220,
          cache_read_input_tokens: 1200,
          cache_creation_input_tokens: 300,
          output_tokens: 50,
        },
      }),
    );
    return;
  }

  if (prompt.includes('error')) {
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-err-123' }));
    console.log(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-err-123',
        is_error: true,
        result: 'Rate limit exceeded',
      }),
    );
    return;
  }

  if (prompt.includes('corrupt')) {
    console.log('not valid json at all');
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-corrupt-123' }));
    console.log('another corrupt line {{{');
    console.log(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Vẫn parse được sau dòng lỗi.',
            },
          ],
        },
      }),
    );
    console.log(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-corrupt-123',
        total_cost_usd: 0.001,
        duration_ms: 100,
        num_turns: 1,
        is_error: false,
        result: 'Vẫn parse được sau dòng lỗi.',
      }),
    );
    return;
  }

  // Normal flow
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: resumeSessionId }));
  console.log(
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Xin chào, ' },
      },
    }),
  );
  console.log(
    JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'tôi là Claude!' },
      },
    }),
  );
  const usageMatch = prompt.match(/usage:(\d+):(\d+)(?::(\d+):(\d+))?/);
  let inputTokens = usageMatch ? parseInt(usageMatch[1], 10) : 100;
  const outputTokens = usageMatch ? parseInt(usageMatch[2], 10) : 25;
  const cacheReadTokens = usageMatch && usageMatch[3] ? parseInt(usageMatch[3], 10) : 0;
  const cacheCreationTokens = usageMatch && usageMatch[4] ? parseInt(usageMatch[4], 10) : 0;

  if (prompt.includes('high-context')) {
    inputTokens = 180000;
  }

  console.log(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'text',
            text: 'Xin chào, tôi là Claude!',
          },
        ],
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
          ...(cacheCreationTokens > 0 ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
        },
      },
    }),
  );

  console.log(
    JSON.stringify({
      type: 'result',
      session_id: resumeSessionId,
      total_cost_usd: 0.0015,
      duration_ms: 150,
      num_turns: 1,
      is_error: false,
      result: 'Xin chào, tôi là Claude!',
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
        ...(cacheCreationTokens > 0 ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
      },
    }),
  );
}

async function main() {
  const isStreamJson = args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json';

  if (isStreamJson) {
    const rl = readline.createInterface({
      input: process.stdin,
      terminal: false,
    });

    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: resumeSessionId }));

    for await (const line of rl) {
      if (!line.trim()) continue;
      let prompt = line;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.message?.content && Array.isArray(parsed.message.content)) {
          prompt = parsed.message.content.map((c) => c.text || '').join('');
        }
      } catch {
        // ignore
      }

      if (process.env.FAKE_CLAUDE_LOG) {
        try {
          fs.appendFileSync(
            process.env.FAKE_CLAUDE_LOG,
            JSON.stringify({
              argv: process.argv,
              stdin: line,
              prompt,
              cwd: process.cwd(),
              env: { FAKE_MODE: process.env.FAKE_MODE, ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH },
            }) + '\n',
            'utf-8',
          );
        } catch {
          // ignore
        }
      }

      await handlePrompt(prompt);
    }
    return;
  }

  const stdin = await readStdin();
  const pIdx = args.indexOf('-p');
  let prompt = stdin;
  if (!prompt && pIdx >= 0 && args[pIdx + 1] && !args[pIdx + 1].startsWith('-')) {
    prompt = args[pIdx + 1];
  }

  // Log arguments if FAKE_CLAUDE_LOG is specified
  if (process.env.FAKE_CLAUDE_LOG) {
    try {
      fs.appendFileSync(
        process.env.FAKE_CLAUDE_LOG,
        JSON.stringify({
          argv: process.argv,
          stdin,
          cwd: process.cwd(),
          env: { FAKE_MODE: process.env.FAKE_MODE, ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH },
        }) + '\n',
        'utf-8',
      );
    } catch {
      // ignore
    }
  }

  await handlePrompt(prompt);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
