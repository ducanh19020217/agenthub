import fs from 'node:fs';
import path from 'node:path';
import type { AgentHubConfig, OpenProjectSource } from '../../config.js';
import { HttpError } from '../../errors.js';
import { getMinutesSinceTime } from '../../brain/digest.js';
import { OpenProjectClient } from './client.js';
import { readOpenProjectKey } from './secrets.js';

export function formatDDMMYYYY(d: Date): string {
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = String(d.getFullYear());
  return `${day}-${month}-${year}`;
}

import { formatSlashDate, formatYYYYMMDD, parseDateNoon, getPreviousWorkingDay } from './time.js';
export { formatSlashDate, formatYYYYMMDD, parseDateNoon, getPreviousWorkingDay };

export interface PreviousReportFileInfo {
  file: string;
  date: Date;
  path: string;
}

export function findLatestPreviousReportFile(dir: string, beforeDate: Date): PreviousReportFileInfo | null {
  if (!fs.existsSync(dir)) return null;
  const beforeTimestamp = new Date(beforeDate.getFullYear(), beforeDate.getMonth(), beforeDate.getDate(), 12, 0, 0).getTime();
  const entries = fs.readdirSync(dir);
  const candidates: PreviousReportFileInfo[] = [];

  for (const entry of entries) {
    const match = entry.match(/^bao-cao-(\d{2})-(\d{2})-(\d{4})\.txt$/);
    if (!match) continue;
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const fileDate = new Date(year, month - 1, day, 12, 0, 0);
    if (fileDate.getTime() < beforeTimestamp) {
      candidates.push({ file: entry, date: fileDate, path: path.join(dir, entry) });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.date.getTime() - a.date.getTime());
  return candidates[0];
}

export function extractTodaySection(content: string): string[] {
  const lines = content.split('\n');
  const todayIndex = lines.findIndex((line) => /^\s*2\.\s*Hôm nay làm gì\s*\?/i.test(line));
  if (todayIndex === -1) return [];

  const items: string[] = [];
  for (let i = todayIndex + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (/^\s*\d+\./.test(trimmed)) break;
    if (trimmed.startsWith('-')) {
      if (trimmed.includes('(không có)')) continue;
      items.push(trimmed);
    }
  }
  return items;
}

export function formatDailyReport(targetDate: Date, yesterdayLines: string[], todayLines: string[]): string {
  const dateStr = formatSlashDate(targetDate);
  const yPart = yesterdayLines.length > 0 ? yesterdayLines.join('\n') : '- (không có)';
  const tPart = todayLines.length > 0 ? todayLines.join('\n') : '- (không có)';
  return `Ngày: ${dateStr}\n1. Hôm qua đã làm gì?\n${yPart}\n2. Hôm nay làm gì ?\n${tPart}\n`;
}

export interface DailyReportServiceOptions {
  config: AgentHubConfig;
  eventBus: { emit(type: string, taskId?: string, payload?: unknown): boolean };
  fetchFn?: typeof fetch;
  now?: () => number;
  timerMs?: number;
  telegramSender?: (content: string, source: OpenProjectSource) => Promise<void> | void;
}

export class DailyReportService {
  private readonly config: AgentHubConfig;
  private readonly eventBus: DailyReportServiceOptions['eventBus'];
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timerMs: number;
  private readonly telegramSender?: DailyReportServiceOptions['telegramSender'];
  private timer?: NodeJS.Timeout;
  private started = false;
  private lastRunDate = new Map<string, string>();

  constructor(options: DailyReportServiceOptions) {
    this.config = options.config;
    this.eventBus = options.eventBus;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.timerMs = options.timerMs || 60_000;
    this.telegramSender = options.telegramSender;
  }

  start(): void {
    if (this.started) return;
    const hasEnabled = this.config.integrations.openproject.sources.some((s) => s.dailyReport?.enabled);
    if (!hasEnabled) return;
    this.started = true;
    this.checkScheduledReports().catch(() => undefined);
    this.timer = setInterval(() => this.checkScheduledReports().catch(() => undefined), this.timerMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async checkScheduledReports(): Promise<void> {
    const nowMs = this.now();
    const d = new Date(nowMs);
    const dateKey = formatYYYYMMDD(d);

    for (const source of this.config.integrations.openproject.sources) {
      if (!source.dailyReport?.enabled) continue;
      if (source.dailyReport?.weekdaysOnly !== false && (d.getDay() === 0 || d.getDay() === 6)) {
        continue;
      }
      if (this.lastRunDate.get(source.id) === dateKey) continue;

      const reportTime = source.dailyReport?.time || '08:00';
      const minsSince = getMinutesSinceTime(reportTime, d);
      if (minsSince < 0 || minsSince > 60) continue;

      const dir = source.dailyReport?.dir
        ? (path.isAbsolute(source.dailyReport.dir) ? source.dailyReport.dir : path.resolve(this.config.hubHome, source.dailyReport.dir))
        : path.join(this.config.hubHome, 'reports', source.id);
      const filename = `bao-cao-${formatDDMMYYYY(d)}.txt`;
      if (fs.existsSync(path.join(dir, filename))) {
        this.lastRunDate.set(source.id, dateKey);
        continue;
      }

      this.lastRunDate.set(source.id, dateKey);
      try {
        await this.generateReport(source.id, d, { overwrite: false });
      } catch {
        // Handled in generateReport
      }
    }
  }

  async generateReport(
    sourceId: string,
    targetDate = new Date(this.now()),
    options: { overwrite?: boolean } = {},
  ): Promise<{ path: string; content: string }> {
    const source = this.config.integrations.openproject.sources.find((item) => item.id === sourceId);
    if (!source) {
      throw new HttpError(404, 'not_found', 'Nguồn OpenProject không tồn tại');
    }

    const dateKey = formatYYYYMMDD(targetDate);
    const dir = source.dailyReport?.dir
      ? (path.isAbsolute(source.dailyReport.dir) ? source.dailyReport.dir : path.resolve(this.config.hubHome, source.dailyReport.dir))
      : path.join(this.config.hubHome, 'reports', source.id);
    const filename = `bao-cao-${formatDDMMYYYY(targetDate)}.txt`;
    const filePath = path.join(dir, filename);

    if (!options.overwrite && fs.existsSync(filePath)) {
      return { path: filePath, content: fs.readFileSync(filePath, 'utf8') };
    }

    const key = readOpenProjectKey(this.config.hubHome, source.id);
    if (!key) {
      this.eventBus.emit('daily_report.failed', undefined, {
        sourceId: source.id,
        date: dateKey,
        error: 'Chưa có API key',
      });
      throw new HttpError(400, 'bad_request', 'Nguồn chưa có API key');
    }

    try {
      const client = new OpenProjectClient({
        baseUrl: source.url,
        project: source.project,
        apiKey: key,
        fetch: this.fetchFn,
      });

      // 1. "Hôm qua": lấy từ file báo cáo trước gần nhất trong dir; nếu chưa có thì fallback API
      let yesterdayLines: string[] = [];
      const prevReport = findLatestPreviousReportFile(dir, targetDate);
      if (prevReport) {
        const prevContent = fs.readFileSync(prevReport.path, 'utf8');
        yesterdayLines = extractTodaySection(prevContent);
      } else {
        const prevWorkingDay = getPreviousWorkingDay(targetDate);
        const prevDateStr = formatYYYYMMDD(prevWorkingDay);
        const updatedWps = await client.listUpdatedWorkPackages(prevDateStr, prevDateStr);
        const me = await client.me();

        const matchedWps: typeof updatedWps = [];
        for (const wp of updatedWps) {
          const activities = await client.listActivities(wp.id);
          const hasMeActivity = activities.some((act) => {
            const userHref = act._links?.user?.href || '';
            const isMe =
              userHref === `/api/v3/users/${me.id}` ||
              userHref.endsWith(`/${me.id}`) ||
              (act._links?.user?.title && act._links.user.title === me.name);
            if (!isMe) return false;
            if (act.createdAt) {
              return act.createdAt.slice(0, 10) === prevDateStr;
            }
            return true;
          });
          if (hasMeActivity) {
            matchedWps.push(wp);
          }
        }
        yesterdayLines = matchedWps.map((wp) => `- [${wp.displayId || wp.id}] - ${(wp.subject || '').trim()}`);
      }

      // 2. "Hôm nay": ticket giao cho "me" ở openStatusIds, sắp theo updatedAt giảm dần, tối đa maxItems
      let todayLines: string[] = [];
      const openStatusIds = source.openStatusIds || [];
      if (openStatusIds.length > 0) {
        const wps = await client.listAssignedWorkPackages(openStatusIds);
        wps.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
        const maxItems = source.dailyReport?.maxItems ?? 10;
        const selected = wps.slice(0, maxItems);
        todayLines = selected.map((wp) => `- [${wp.displayId || wp.id}] - ${(wp.subject || '').trim()}`);
      }

      const content = formatDailyReport(targetDate, yesterdayLines, todayLines);

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');

      if (source.dailyReport?.telegram && this.telegramSender) {
        try {
          await this.telegramSender(content, source);
        } catch {
          // Ignore telegram send failure
        }
      }

      this.eventBus.emit('daily_report.created', undefined, {
        sourceId: source.id,
        date: dateKey,
        path: filePath,
        content,
        telegram: Boolean(source.dailyReport?.telegram),
      });

      return { path: filePath, content };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.eventBus.emit('daily_report.failed', undefined, {
        sourceId: source.id,
        date: dateKey,
        error: errorMsg,
      });
      throw err;
    }
  }
}
