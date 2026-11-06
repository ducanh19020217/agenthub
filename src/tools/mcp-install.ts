import { execFile } from 'node:child_process';

/** Đối số `claude mcp add` để đăng ký AgentHub ở cấp user (PLAN 3.8). */
export function mcpAddArgs(nodePath: string, cliPath: string): string[] {
  return ['mcp', 'add', '--scope', 'user', 'agenthub', '--', nodePath, cliPath, 'mcp'];
}

/**
 * Chạy `claude mcp add` bằng đường dẫn tuyệt đối của Claude Code.
 * Daemon có thể chạy bằng Node khác với Node cài Claude (nvm), nên không dựa vào PATH.
 */
export function runMcpInstall(opts: { claudeBin: string; nodePath: string; cliPath: string; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(opts.claudeBin, mcpAddArgs(opts.nodePath, opts.cliPath), { timeout: opts.timeoutMs ?? 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).trim()));
      else resolve(`${stdout}${stderr}`);
    });
  });
}
