import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync, spawn, ChildProcess } from 'node:child_process';
import { findProjectRoot } from '../cli.js';

function loadBrainPlaybook(): string {
  const candidates = [
    path.resolve(path.dirname(new URL('.', import.meta.url).pathname), '../../docs/BRAIN-PLAYBOOK.md'),
    path.resolve(process.env.AGENTHUB_INSTALL_DIR || '', 'docs/BRAIN-PLAYBOOK.md'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    } catch {
      // Continue to the embedded fallback below.
    }
  }
  return 'BRAIN-PLAYBOOK không có sẵn; chỉ điều phối qua MCP, review trước merge và hỏi người dùng khi có rủi ro.';
}

function loadAssistantPlaybook(): string {
  const candidates = [
    path.resolve(path.dirname(new URL('.', import.meta.url).pathname), '../../docs/ASSISTANT-PLAYBOOK.md'),
    path.resolve(process.env.AGENTHUB_INSTALL_DIR || '', 'docs/ASSISTANT-PLAYBOOK.md'),
  ];
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8'); } catch { /* optional */ }
  }
  return 'Trả lời ngắn bằng tiếng Việt; đọc dữ liệu thật trước khi kết luận; việc duyệt/merge thuộc về bộ não.';
}

export const BRAIN_PROMPT =
  'Bạn là Claude, bộ não điều phối của AgentHub. Người dùng chat với bạn qua dashboard. Dùng trực tiếp các tool mcp__agenthub__hub_status, mcp__agenthub__hub_projects, mcp__agenthub__hub_register_project, mcp__agenthub__hub_profiles, mcp__agenthub__hub_create_task, mcp__agenthub__hub_update_task, mcp__agenthub__hub_create_batch, mcp__agenthub__hub_batch, mcp__agenthub__hub_dispatch_batch, mcp__agenthub__hub_tasks, mcp__agenthub__hub_task, mcp__agenthub__hub_task_log, mcp__agenthub__hub_review, mcp__agenthub__hub_retry, mcp__agenthub__hub_cancel, mcp__agenthub__hub_pause, mcp__agenthub__hub_resume, mcp__agenthub__hub_wait, mcp__agenthub__hub_mark_quota, mcp__agenthub__hub_git (git status/log/diff/show an toàn), cùng hub_effective_config, hub_presets, hub_departments, hub_integration_discover và hub_request_secret; không cần tìm tool. Các tool ghi cấu hình hub_preset_apply, hub_project_settings, hub_department, hub_config_set luôn phải gọi dryRun trước và chỉ ghi khi người dùng xác nhận. Không bao giờ yêu cầu người dùng gửi bí mật trong chat. Khi tạm dừng task vì quá tải, bắt buộc dùng hub_pause với reason:\'load\' để hệ thống tự resume khi máy hạ tải. Số % trong hub_profiles là phần CÒN LẠI. Ảnh chụp hub ở trên là mới nhất; KHÔNG gọi lại hub_status/hub_projects/hub_tasks/git log để tìm hiểu lại trừ khi cần chi tiết cụ thể. Trước khi khám phá nhiều bước, viết 1–2 câu cho người dùng biết bạn sẽ làm gì; sau mỗi khoảng 5 tool call, viết 1 câu báo tiến độ. {{PLANNING_RULE}}Trả lời ngắn gọn bằng tiếng Việt. Không tự viết code tính năng: hãy chia việc thành task nhỏ cho worker (Gemini/Codex) qua hub_create_task hoặc hub_create_batch, sau đó review.' + `\n\nSỔ TAY BRAIN-PLAYBOOK:\n${loadBrainPlaybook()}`;

export const ASSISTANT_PROMPT =
  'Bạn là Trợ lý AgentHub, chuyên trả lời người dùng nhanh bằng tiếng Việt. Đọc dữ liệu thật trước khi trả lời tiến độ, không bịa. Trước khi làm bất cứ điều gì dựa trên lịch sử hội thoại, hãy đọc trạng thái hiện tại bằng hub_status, hub_tasks và hub_git (chỉ đọc); không lặp lại thao tác cũ nếu người dùng chưa yêu cầu lại. Nếu người dùng chỉ hỏi tình hình, chỉ trả lời tình hình. Bạn có thể đọc cấu hình bằng hub_effective_config, hub_presets, hub_departments và hub_integration_discover; có thể xem trước các thay đổi bằng hub_preset_apply, hub_project_settings, hub_department và hub_config_set với dryRun, nhưng không được ghi cấu hình hay yêu cầu bí mật. Bạn có thể xem trạng thái và tạo/cập nhật task nháp hoặc queued, retry/cancel/pause/resume, và gửi thông báo; nếu tạo từ 2 task liên quan trở lên phải dùng hub_create_batch với goal. Không duyệt, merge hoặc dispatch thay bộ não; nếu cần quyết định duyệt/merge thì nói rõ và dùng hub_ask_brain. Các thay đổi cách làm của bộ não phải ghi bằng hub_brain_directive. Khi phiên dài, hãy compact hoặc mở phiên mới và giữ tóm tắt cần thiết. {{PLAYBOOK}}';

export function buildAssistantPrompt(projectKnowledge?: string): string {
  const knowledge = projectKnowledge ? `\n\n${projectKnowledge}` : '';
  return ASSISTANT_PROMPT.replace('{{PLAYBOOK}}', `\n\nSỔ TAY ASSISTANT-PLAYBOOK:\n${loadAssistantPlaybook()}${knowledge}`);
}

/** Planning rule follows the user's approval setting (Settings → Kế hoạch). */
export function planningRule(planning?: { requireApproval?: boolean; approvalMinTasks?: number }): string {
  if (planning?.requireApproval) {
    return 'Mọi task bạn tạo đều là nháp chờ người dùng duyệt: dùng hub_create_batch cho kế hoạch và báo người dùng bấm "Giao cả đợt". ';
  }
  const min = planning?.approvalMinTasks ?? 0;
  if (min > 0) {
    return `Kế hoạch từ ${min} task trở lên: dùng hub_create_batch (đợt nháp) và chờ người dùng duyệt, trừ khi họ bảo giao ngay; kế hoạch nhỏ hơn thì giao thẳng (hub_create_task với start=true). `;
  }
  return 'Người dùng không cần duyệt kế hoạch: mọi lần tạo từ 2 task liên quan trở lên bắt buộc dùng hub_create_batch với goal và dispatch=true; chỉ task đơn lẻ mới dùng hub_create_task với start=true. Sau đó báo ngắn gọn đã giao những gì. ';
}

export function buildBrainPrompt(planning?: { requireApproval?: boolean; approvalMinTasks?: number }): string {
  return BRAIN_PROMPT.replace('{{PLANNING_RULE}}', planningRule(planning));
}

export const FORK_SUMMARY_PROMPT =
  'Tóm tắt toàn bộ ngữ cảnh và các quyết định quan trọng của phiên trò chuyện này để tiếp tục trong phiên mới.';

export interface HubSnapshotInput {
  projects: Array<{ id: string; name: string; path: string; defaultBranch: string }>;
  tasks: Array<{ id: string; projectId: string; title: string; status: string }>;
  runs?: Array<{ taskId: string; model: string; outcome: string | null }>;
  profiles: Array<{ name: string; engine: string; email: string | null; authState?: string | null; enabled?: boolean | number }>;
  quotaUsage: Array<{ profileName: string; grp: string; window: string; remainingPct: number }>;
  quotaMarks: Array<{ profileName: string; family: string; until: number }>;
  currentProject?: { id: string; path: string } | null;
  memory?: string;
  planHeadings?: string[];
  gitLog?: string[];
  capturedAt?: string;
  eventUpdate?: string;
}

function maskEmail(email: string | null): string {
  if (!email) return 'chưa xác thực';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

export function buildHubSnapshot(input: HubSnapshotInput): string {
  const snapshotEpoch = input.capturedAt ? Math.floor(Date.parse(input.capturedAt) / 1000) : 0;
  const projectLines = input.projects.map((p) => {
    const tasks = input.tasks.filter((task) => task.projectId === p.id);
    const counts = [...new Set(tasks.map((task) => task.status))]
      .map((status) => `${status}:${tasks.filter((task) => task.status === status).length}`)
      .join(', ');
    const notable = tasks.filter((task) => ['running', 'review', 'failed'].includes(task.status)).map((task) => {
      const model = input.runs?.find((run) => run.taskId === task.id && !run.outcome)?.model || '-';
      return `${task.id} ${task.title} (${task.status}, ${model})`;
    });
    return `- ${p.name} · ${p.path} · nhánh ${p.defaultBranch} · task ${counts || '0'}${notable.length ? ` · ${notable.join('; ')}` : ''}`;
  });
  const profileLines = input.profiles.filter((profile) => profile.enabled !== false && profile.enabled !== 0).map((profile) => {
    const usage = input.quotaUsage.filter((row) => row.profileName === profile.name && row.window === '5h')
      .map((row) => `${row.grp}:${row.remainingPct}%`).join(', ');
    const marks = input.quotaMarks.filter((mark) => mark.profileName === profile.name && mark.until > snapshotEpoch)
      .map((mark) => `${mark.family} tới ${new Date(mark.until * 1000).toISOString()}`).join(', ');
    return `- ${profile.name} · ${profile.engine} · ${maskEmail(profile.email)} · ${profile.authState || 'unknown'} · quota ${usage || 'chưa có'}${marks ? ` · mark ${marks}` : ''}`;
  });
  const sections = [
    'ẢNH CHỤP HUB',
    `Chụp lúc: ${input.capturedAt || new Date().toISOString()}`,
    input.eventUpdate ? `Cập nhật hub: ${input.eventUpdate}` : '',
    'Projects:\n' + (projectLines.join('\n') || '- không có'),
    'Profiles:\n' + (profileLines.join('\n') || '- không có'),
  ];
  if (input.currentProject) {
    sections.push(`Project đang chat: ${input.currentProject.path}`);
    sections.push(`5 commit gần nhất:\n${(input.gitLog || []).join('\n') || '- không đọc được'}`);
    sections.push(`Heading ## trong PLAN.md:\n${(input.planHeadings || []).join('\n') || '- không có'}`);
    sections.push(`MEMORY.md:\n${(input.memory || 'không có').slice(0, 3000)}`);
  }
  return sections.filter(Boolean).join('\n').slice(0, 9000);
}

export interface HubSnapshotFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
}

export function readHubSnapshotFiles(projectPath: string, home = os.homedir(), fsApi: HubSnapshotFs = fs): Pick<HubSnapshotInput, 'memory' | 'planHeadings' | 'gitLog'> {
  const memoryPath = path.join(home, '.claude', 'projects', projectPath.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md');
  const planPath = path.join(projectPath, 'docs', 'PLAN.md');
  let memory = '';
  let planHeadings: string[] = [];
  try { if (fsApi.existsSync(memoryPath)) memory = fsApi.readFileSync(memoryPath, 'utf8').slice(0, 3000); } catch { /* optional */ }
  try {
    if (fsApi.existsSync(planPath)) planHeadings = fsApi.readFileSync(planPath, 'utf8').split('\n').filter((line) => /^##\s+/.test(line)).slice(0, 30);
  } catch { /* optional */ }
  let gitLog: string[] = [];
  try {
    gitLog = execFileSync('git', ['log', '--oneline', '-5'], { cwd: projectPath, encoding: 'utf8', timeout: 5000 }).trim().split('\n').filter(Boolean);
  } catch { /* optional */ }
  return { memory, planHeadings, gitLog };
}

const partialSupportCache = new Map<string, boolean>();
const streamJsonSupportCache = new Map<string, boolean>();

export function clearPartialSupportCache(): void {
  partialSupportCache.clear();
  streamJsonSupportCache.clear();
}

export function findClaudeBin(configuredBin?: string): string | null {
  // 1. Config chat.claudeBin
  if (configuredBin) {
    const resolved = path.resolve(configuredBin);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    if (fs.existsSync(configuredBin)) {
      return configuredBin;
    }
  }

  // Explicit override (also lets tests point at a fake CLI independent of what this machine has).
  const envBin = process.env.AGENTHUB_CLAUDE_BIN;
  if (envBin && fs.existsSync(envBin)) return envBin;

  const managedBin = path.join(process.env.AGENTHUB_TOOLS_DIR || '', 'node_modules', '.bin', 'claude');
  if (process.env.AGENTHUB_TOOLS_DIR && fs.existsSync(managedBin)) return managedBin;

  // 2. Latest VS Code Claude Code native binary.
  const extensionsDir = path.join(os.homedir(), '.vscode', 'extensions');
  try {
    const versions = fs.readdirSync(extensionsDir).filter((entry) => entry.startsWith('anthropic.claude-code-'))
      .map((entry) => ({ entry, bin: path.join(extensionsDir, entry, 'resources', 'native-binary', 'claude') }))
      .filter(({ bin }) => fs.existsSync(bin));
    versions.sort((a, b) => b.entry.slice('anthropic.claude-code-'.length).localeCompare(a.entry.slice('anthropic.claude-code-'.length), undefined, { numeric: true }));
    if (versions[0]) return versions[0].bin;
  } catch { /* ignore */ }

  // 3. claude in PATH
  try {
    const stdout = execSync('which claude', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (stdout && fs.existsSync(stdout)) {
      return stdout;
    }
  } catch {
    // not in PATH
  }

  // 4. ~/.local/bin/claude
  const localBin = path.join(os.homedir(), '.local', 'bin', 'claude');
  if (fs.existsSync(localBin)) {
    return localBin;
  }

  // 5. ~/.nvm/versions/node/*/bin/claude (latest version)
  const nvmNodeDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmNodeDir)) {
    try {
      const versions = fs.readdirSync(nvmNodeDir).filter((v) => {
        const binPath = path.join(nvmNodeDir, v, 'bin', 'claude');
        return fs.existsSync(binPath);
      });

      if (versions.length > 0) {
        // Sort descending (e.g. v22.21.1 > v20.10.0 > v18.20.8)
        versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
        return path.join(nvmNodeDir, versions[0], 'bin', 'claude');
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export function getClaudeVersion(claudeBin?: string): string | null {
  const resolved = findClaudeBin(claudeBin);
  if (!resolved) return null;
  try {
    return execFileSync(resolved, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

export function checkClaudePartialSupport(claudeBin: string): boolean {
  if (partialSupportCache.has(claudeBin)) {
    return partialSupportCache.get(claudeBin)!;
  }

  try {
    const stdout = execFileSync(claudeBin, ['--help'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const supported = stdout.includes('--include-partial-messages');
    partialSupportCache.set(claudeBin, supported);
    return supported;
  } catch {
    partialSupportCache.set(claudeBin, false);
    return false;
  }
}

export function checkClaudeStreamJsonSupport(claudeBin: string): boolean {
  if (streamJsonSupportCache.has(claudeBin)) return streamJsonSupportCache.get(claudeBin)!;
  try {
    const stdout = execFileSync(claudeBin, ['--help'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const supported = stdout.includes('--input-format') && stdout.includes('stream-json');
    streamJsonSupportCache.set(claudeBin, supported);
    return supported;
  } catch {
    streamJsonSupportCache.set(claudeBin, false);
    return false;
  }
}

export function chatMcpConfigPath(hubHome?: string, sessionId?: string): string {
  const targetHome = hubHome || path.join(os.homedir(), '.agenthub');
  const suffix = sessionId ? `-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : '';
  return path.join(targetHome, `chat-mcp${suffix}.json`);
}

export function ensureChatMcpConfig(hubHome?: string, sessionId?: string, port?: number, permissionTimeoutSec?: number, projectId?: string | null, kind?: string): string {
  const targetHome = hubHome || path.join(os.homedir(), '.agenthub');
  const mcpConfigFile = chatMcpConfigPath(targetHome, sessionId);

  if (!fs.existsSync(targetHome)) {
    fs.mkdirSync(targetHome, { recursive: true, mode: 0o700 });
  }

  const projectRoot = findProjectRoot();
  const cliPath = path.resolve(projectRoot, 'dist', 'cli.js');
  const nodePath = process.execPath;

  const content = {
    mcpServers: {
      agenthub: {
        command: nodePath,
        args: [cliPath, 'mcp'],
        env: {
          ...(sessionId ? { AGENTHUB_CHAT_SESSION_ID: sessionId } : {}),
          ...(projectId ? { AGENTHUB_MCP_PROJECT: projectId } : {}),
          ...(kind ? { AGENTHUB_CHAT_KIND: kind } : {}),
          AGENTHUB_PORT: String(port || process.env.AGENTHUB_PORT || 7700),
          AGENTHUB_PERMISSION_TIMEOUT_SEC: String(permissionTimeoutSec || process.env.AGENTHUB_PERMISSION_TIMEOUT_SEC || 600),
        },
      },
    },
  };

  fs.writeFileSync(mcpConfigFile, JSON.stringify(content, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(mcpConfigFile, 0o600);
  return mcpConfigFile;
}

export interface BuildClaudeArgsOptions {
  text?: string;
  claudeSessionId?: string | null;
  mode?: 'safe' | 'full';
  mcpConfigPath: string;
  supportsPartial?: boolean;
  persistent?: boolean;
  model?: string | null;
  hubSnapshot?: string;
  planning?: { requireApproval?: boolean; approvalMinTasks?: number };
  systemPrompt?: string;
}

export function buildClaudeArgs(opts: BuildClaudeArgsOptions): string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
  ];

  if (opts.persistent) args.splice(1, 0, '--input-format', 'stream-json');

  if (opts.claudeSessionId) {
    args.push('--resume', opts.claudeSessionId);
  }

  if (opts.supportsPartial) {
    args.push('--include-partial-messages');
  }

  if (opts.model) args.push('--model', opts.model);

  args.push('--append-system-prompt', opts.systemPrompt || buildBrainPrompt(opts.planning));
  if (opts.hubSnapshot) args.push('--append-system-prompt', opts.hubSnapshot);
  args.push('--mcp-config', opts.mcpConfigPath);

  if (opts.mode === 'full') {
    args.push('--permission-mode', 'bypassPermissions');
  } else {
    args.push(
      '--permission-mode',
      'default',
      '--permission-prompt-tool',
      'mcp__agenthub__permission_prompt',
      '--allowedTools',
      'Read,Grep,Glob,LS,mcp__agenthub,Bash(git status:*),Bash(git log:*),Bash(npm test:*),Bash(npm run lint:*),Bash(npm run typecheck:*)',
    );
  }

  return args;
}

export function spawnClaude(
  claudeBin: string,
  args: string[],
  cwd: string,
  stdinText?: string,
  options: { disableToolSearch?: boolean; chatSessionId?: string; port?: number; claudeConfigDir?: string; chatKind?: string; env?: Record<string, string> } = {},
): ChildProcess {
  const child = spawn(claudeBin, args, {
    cwd,
    detached: true,
    env: {
      ...process.env,
      ...(options.claudeConfigDir ? { CLAUDE_CONFIG_DIR: options.claudeConfigDir } : {}),
      ...(options.disableToolSearch !== false ? { ENABLE_TOOL_SEARCH: 'false' } : {}),
      ...(options.chatSessionId ? { AGENTHUB_CHAT_SESSION_ID: options.chatSessionId } : {}),
      ...(options.chatKind ? { AGENTHUB_CHAT_KIND: options.chatKind } : {}),
      ...(options.port ? { AGENTHUB_PORT: String(options.port) } : {}),
      ...(options.env || {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (child.stdin) {
    child.stdin.on('error', () => {
      // ignore broken pipe if child exits early
    });
    if (stdinText !== undefined) {
      child.stdin.write(stdinText);
      child.stdin.end();
    }
  }

  return child;
}

export function streamJsonMessage(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n';
}

export function interruptProcess(pid: number): void {
  try {
    process.kill(-pid, 'SIGINT');
  } catch {
    try { process.kill(pid, 'SIGINT'); } catch { /* already dead */ }
  }
}

export function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // process already dead
    }
  }
}
