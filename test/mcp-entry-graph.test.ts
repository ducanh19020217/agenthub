import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../src');
const HEAVY = ['daemon.ts', 'scheduler/index.ts', 'services/index.ts', 'api/server.ts', 'db/index.ts', 'engines/index.ts', 'cli-main.ts'];

/** Đồ thị import tĩnh (bỏ `import type` và `await import()`) bắt đầu từ một file. */
function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [path.join(SRC, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const re = /^\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"](\.[^'"]+)['"]/gm;
    for (const m of source.matchAll(re)) {
      const target = path.resolve(path.dirname(file), m[1].replace(/\.js$/, '.ts'));
      if (fs.existsSync(target)) stack.push(target);
    }
  }
  return new Set([...seen].map((f) => path.relative(SRC, f)));
}

describe('MCP entry nhẹ', () => {
  it('cli.ts không import tĩnh module nào của hub', () => {
    expect([...staticGraph('cli.ts')]).toEqual(['cli.ts']);
  });

  it('mcp-entry không kéo daemon, scheduler, services, db', () => {
    const graph = staticGraph('mcp-entry.ts');
    for (const heavy of HEAVY) expect(graph.has(heavy), heavy).toBe(false);
    expect(graph.has('mcp/index.ts')).toBe(true);
  });
});
