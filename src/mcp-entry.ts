#!/usr/bin/env node

import { runMcpServer } from './mcp/index.js';

runMcpServer().catch((err: unknown) => {
  console.error('Lỗi khởi động MCP server:', err);
  process.exit(1);
});
