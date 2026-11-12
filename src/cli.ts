#!/usr/bin/env node
// Launcher mỏng: `agenthub mcp` chạy một tiến trình stdio cho mỗi phiên Claude Code,
// nên không được nạp daemon/scheduler/fastify. Mọi lệnh khác đi qua cli-main.
// File này không import tĩnh module nào của hub.
if (process.argv[2] === 'mcp') {
  await import('./mcp-entry.js');
} else {
  const { runCli } = await import('./cli-main.js');
  runCli();
}

export {};
