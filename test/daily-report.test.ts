import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { loadConfig, OpenProjectSourceSchema, type AgentHubConfig } from '../src/config.js';
import { saveOpenProjectKey } from '../src/integrations/openproject/secrets.js';
import {
  DailyReportService,
  extractTodaySection,
  findLatestPreviousReportFile,
  formatDDMMYYYY,
  formatSlashDate,
  formatYYYYMMDD,
  getPreviousWorkingDay,
  parseDateNoon,
} from '../src/integrations/openproject/daily-report.js';
import { registerOpenProjectRoutes } from '../src/integrations/openproject/routes.js';
import { TelegramBotService } from '../src/telegram.js';

describe('DailyReportService & Daily Report Integration', () => {
  let home: string;
  let config: AgentHubConfig;
  let eventBus: { emit: ReturnType<typeof vi.fn> };
  let events: Array<{ type: string; taskId?: string; payload?: unknown }>;
  let fakeFetch: ReturnType<typeof vi.fn>;
  let source: ReturnType<typeof OpenProjectSourceSchema.parse>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-daily-report-'));
    config = loadConfig(home);
    source = OpenProjectSourceSchema.parse({
      id: 'demo',
      url: 'https://op.example.test',
      project: 'demo',
      openStatusIds: [1, 2],
      dailyReport: {
        enabled: true,
        time: '08:00',
        weekdaysOnly: true,
        maxItems: 3,
        telegram: false,
      },
    });
    config.integrations.openproject.sources = [source];
    saveOpenProjectKey(home, 'demo', 'test-key');

    events = [];
    eventBus = {
      emit: vi.fn((type: string, taskId?: string, payload?: unknown) => {
        events.push({ type, taskId, payload });
        return true;
      }),
    };

    fakeFetch = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('/users/me')) {
        return new Response(JSON.stringify({ id: 1, name: 'Alice' }));
      }
      if (urlStr.includes('/work_packages?')) {
        return new Response(JSON.stringify({ total: 0, _embedded: { elements: [] } }));
      }
      if (urlStr.includes('/activities')) {
        return new Response(JSON.stringify({ _embedded: { elements: [] } }));
      }
      throw new Error(`Unexpected url: ${urlStr}`);
    });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('Date and Formatting Helpers', () => {
    it('formats dates consistently', () => {
      const d = parseDateNoon('2026-11-03');
      expect(formatDDMMYYYY(d)).toBe('03-11-2026');
      expect(formatSlashDate(d)).toBe('03/11/2026');
      expect(formatYYYYMMDD(d)).toBe('2026-11-03');
    });

    it('calculates previous working day correctly (thứ 2 lấy thứ 6)', () => {
      // 2026-11-02 is Monday -> previous working day is Friday 2026-10-30
      const monday = parseDateNoon('2026-11-02');
      expect(monday.getDay()).toBe(1);
      const friday = getPreviousWorkingDay(monday);
      expect(formatYYYYMMDD(friday)).toBe('2026-10-30');
      expect(friday.getDay()).toBe(5);

      // Tuesday 2026-11-03 -> Monday 2026-11-02
      const tuesday = parseDateNoon('2026-11-03');
      expect(formatYYYYMMDD(getPreviousWorkingDay(tuesday))).toBe('2026-11-02');

      // Wednesday 2026-11-04 -> Tuesday 2026-11-03
      const wednesday = parseDateNoon('2026-11-04');
      expect(formatYYYYMMDD(getPreviousWorkingDay(wednesday))).toBe('2026-11-03');

      // Sunday 2026-11-08 -> Friday 2026-11-06
      const sunday = parseDateNoon('2026-11-08');
      expect(formatYYYYMMDD(getPreviousWorkingDay(sunday))).toBe('2026-11-06');

      // Saturday 2026-11-07 -> Friday 2026-11-06
      const saturday = parseDateNoon('2026-11-07');
      expect(formatYYYYMMDD(getPreviousWorkingDay(saturday))).toBe('2026-11-06');
    });

    it('extracts "Hôm nay làm gì ?" section correctly from previous report', () => {
      const content = `Ngày: 02/11/2026\n1. Hôm qua đã làm gì?\n- [OP-1] - Old task\n2. Hôm nay làm gì ?\n- [OP-10] - Task A\n- [OP-20] - Task B\n`;
      const extracted = extractTodaySection(content);
      expect(extracted).toEqual(['- [OP-10] - Task A', '- [OP-20] - Task B']);

      const emptyContent = `Ngày: 02/11/2026\n1. Hôm qua đã làm gì?\n- (không có)\n2. Hôm nay làm gì ?\n- (không có)\n`;
      expect(extractTodaySection(emptyContent)).toEqual([]);
    });

    it('finds latest previous report file before given date', () => {
      const reportsDir = path.join(home, 'reports', 'demo');
      fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(path.join(reportsDir, 'bao-cao-28-10-2026.txt'), 'old');
      fs.writeFileSync(path.join(reportsDir, 'bao-cao-30-10-2026.txt'), 'recent');
      fs.writeFileSync(path.join(reportsDir, 'bao-cao-03-11-2026.txt'), 'today');

      const found = findLatestPreviousReportFile(reportsDir, parseDateNoon('2026-11-02'));
      expect(found).not.toBeNull();
      expect(found?.file).toBe('bao-cao-30-10-2026.txt');

      const none = findLatestPreviousReportFile(reportsDir, parseDateNoon('2026-10-20'));
      expect(none).toBeNull();
    });
  });

  describe('Report Content & Generation', () => {
    it('generates report with exact format matching section 8', async () => {
      fakeFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/users/me')) {
          return new Response(JSON.stringify({ id: 1, name: 'Alice' }));
        }
        if (urlStr.includes('/work_packages?')) {
          return new Response(
            JSON.stringify({
              total: 2,
              _embedded: {
                elements: [
                  { id: 101, displayId: 'SOAR-101', subject: 'Login bug', updatedAt: '2026-11-03T09:00:00Z' },
                  { id: 102, displayId: 'SOAR-102', subject: 'Export feature', updatedAt: '2026-11-03T08:00:00Z' },
                ],
              },
            }),
          );
        }
        return new Response(JSON.stringify({ _embedded: { elements: [] } }));
      });

      // Place previous report with today items
      const reportsDir = path.join(home, 'reports', 'demo');
      fs.mkdirSync(reportsDir, { recursive: true });
      fs.writeFileSync(
        path.join(reportsDir, 'bao-cao-02-11-2026.txt'),
        `Ngày: 02/11/2026\n1. Hôm qua đã làm gì?\n- (không có)\n2. Hôm nay làm gì ?\n- [SOAR-99] - Initial setup\n`,
      );

      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => parseDateNoon('2026-11-03').getTime(),
      });

      const result = await service.generateReport('demo', parseDateNoon('2026-11-03'), { overwrite: true });
      const expected = `Ngày: 03/11/2026\n1. Hôm qua đã làm gì?\n- [SOAR-99] - Initial setup\n2. Hôm nay làm gì ?\n- [SOAR-101] - Login bug\n- [SOAR-102] - Export feature\n`;
      expect(result.content).toBe(expected);

      const saved = fs.readFileSync(path.join(reportsDir, 'bao-cao-03-11-2026.txt'), 'utf8');
      expect(saved).toBe(expected);

      // Verify event
      const createdEvent = events.find((e) => e.type === 'daily_report.created');
      expect(createdEvent).toBeDefined();
      expect(createdEvent?.payload).toMatchObject({
        sourceId: 'demo',
        date: '2026-11-03',
        telegram: false,
      });
    });

    it('falls back to OpenProject updatedAt query and me activity when no previous report exists', async () => {
      const capturedFilters: string[] = [];
      fakeFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/users/me')) {
          return new Response(JSON.stringify({ id: 1, name: 'Alice' }));
        }
        if (urlStr.includes('/work_packages?')) {
          const decoded = decodeURIComponent(urlStr);
          capturedFilters.push(decoded);
          if (decoded.includes('<>d')) {
            // Updated in previous working day
            return new Response(
              JSON.stringify({
                total: 2,
                _embedded: {
                  elements: [
                    { id: 201, displayId: 'OP-201', subject: 'Handled yesterday', updatedAt: '2026-11-02T10:00:00Z' },
                    { id: 202, displayId: 'OP-202', subject: 'Touched by someone else', updatedAt: '2026-11-02T11:00:00Z' },
                  ],
                },
              }),
            );
          }
          // Assigned open tickets for today
          return new Response(
            JSON.stringify({
              total: 1,
              _embedded: {
                elements: [
                  { id: 301, displayId: 'OP-301', subject: 'Plan today', updatedAt: '2026-11-03T07:00:00Z' },
                ],
              },
            }),
          );
        }
        if (urlStr.includes('/work_packages/201/activities')) {
          // Has activity by me
          return new Response(
            JSON.stringify({
              _embedded: {
                elements: [
                  { id: 1, _links: { user: { href: '/api/v3/users/1' } }, createdAt: '2026-11-02T10:00:00Z' },
                ],
              },
            }),
          );
        }
        if (urlStr.includes('/work_packages/202/activities')) {
          // Has activity by Bob, not me
          return new Response(
            JSON.stringify({
              _embedded: {
                elements: [
                  { id: 2, _links: { user: { href: '/api/v3/users/2' } }, createdAt: '2026-11-02T11:00:00Z' },
                ],
              },
            }),
          );
        }
        return new Response(JSON.stringify({ _embedded: { elements: [] } }));
      });

      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => parseDateNoon('2026-11-03').getTime(),
      });

      // No previous report files
      const result = await service.generateReport('demo', parseDateNoon('2026-11-03'));
      expect(capturedFilters.some((f) => f.includes('{"updatedAt":{"operator":"<>d","values":["2026-11-02","2026-11-02"]}}'))).toBe(true);

      expect(result.content).toBe(
        `Ngày: 03/11/2026\n1. Hôm qua đã làm gì?\n- [OP-201] - Handled yesterday\n2. Hôm nay làm gì ?\n- [OP-301] - Plan today\n`,
      );
    });

    it('replaces empty sections with - (không có)', async () => {
      fakeFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/users/me')) {
          return new Response(JSON.stringify({ id: 1, name: 'Alice' }));
        }
        return new Response(JSON.stringify({ total: 0, _embedded: { elements: [] } }));
      });

      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => parseDateNoon('2026-11-03').getTime(),
      });

      const result = await service.generateReport('demo', parseDateNoon('2026-11-03'));
      expect(result.content).toBe(
        `Ngày: 03/11/2026\n1. Hôm qua đã làm gì?\n- (không có)\n2. Hôm nay làm gì ?\n- (không có)\n`,
      );
    });

    it('enforces maxItems and sorts by updatedAt descending for "Hôm nay"', async () => {
      fakeFetch.mockImplementation(async (url: string | URL) => {
        const urlStr = url.toString();
        if (urlStr.includes('/users/me')) {
          return new Response(JSON.stringify({ id: 1, name: 'Alice' }));
        }
        if (urlStr.includes('/work_packages?')) {
          return new Response(
            JSON.stringify({
              total: 4,
              _embedded: {
                elements: [
                  { id: 1, displayId: 'OP-1', subject: 'Oldest', updatedAt: '2026-11-01T00:00:00Z' },
                  { id: 2, displayId: 'OP-2', subject: 'Latest', updatedAt: '2026-11-03T12:00:00Z' },
                  { id: 3, displayId: 'OP-3', subject: 'Middle', updatedAt: '2026-11-02T12:00:00Z' },
                  { id: 4, displayId: 'OP-4', subject: 'Older', updatedAt: '2026-11-01T10:00:00Z' },
                ],
              },
            }),
          );
        }
        return new Response(JSON.stringify({ _embedded: { elements: [] } }));
      });

      source.dailyReport!.maxItems = 2;

      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => parseDateNoon('2026-11-03').getTime(),
      });

      const result = await service.generateReport('demo', parseDateNoon('2026-11-03'));
      // Top 2 by updatedAt desc should be OP-2 (Latest) then OP-3 (Middle)
      expect(result.content).toContain('2. Hôm nay làm gì ?\n- [OP-2] - Latest\n- [OP-3] - Middle\n');
      expect(result.content).not.toContain('OP-1');
      expect(result.content).not.toContain('OP-4');
    });

    it('sends via telegram when telegram option is enabled', async () => {
      source.dailyReport!.telegram = true;
      const telegramSender = vi.fn();

      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        telegramSender,
        now: () => parseDateNoon('2026-11-03').getTime(),
      });

      const result = await service.generateReport('demo', parseDateNoon('2026-11-03'));
      expect(telegramSender).toHaveBeenCalledWith(result.content, expect.anything());

      const createdEvent = events.find((e) => e.type === 'daily_report.created');
      expect(createdEvent?.payload).toMatchObject({
        sourceId: 'demo',
        telegram: true,
      });
    });
  });

  describe('Scheduling and Guard Logic', () => {
    it('skips weekends when weekdaysOnly is true', async () => {
      let generateCalled = false;
      const saturday = new Date(2026, 10, 7, 8, 15, 0); // Saturday 2026-11-07
      expect(saturday.getDay()).toBe(6);

      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => saturday.getTime(),
      });
      vi.spyOn(service, 'generateReport').mockImplementation(async () => {
        generateCalled = true;
        return { path: '', content: '' };
      });

      await service.checkScheduledReports();
      expect(generateCalled).toBe(false);

      // Sunday
      const sunday = new Date(2026, 10, 8, 8, 15, 0);
      expect(sunday.getDay()).toBe(0);
      const sundayService = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => sunday.getTime(),
      });
      vi.spyOn(sundayService, 'generateReport').mockImplementation(async () => {
        generateCalled = true;
        return { path: '', content: '' };
      });
      await sundayService.checkScheduledReports();
      expect(generateCalled).toBe(false);
    });

    it('runs on weekends when weekdaysOnly is false', async () => {
      source.dailyReport!.weekdaysOnly = false;
      let generateCalled = false;
      const saturday = new Date(2026, 10, 7, 8, 15, 0);

      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => saturday.getTime(),
      });
      vi.spyOn(service, 'generateReport').mockImplementation(async () => {
        generateCalled = true;
        return { path: '', content: '' };
      });

      await service.checkScheduledReports();
      expect(generateCalled).toBe(true);
    });

    it('runs only once per day after scheduled time window', async () => {
      let callCount = 0;
      let currentTime = new Date(2026, 10, 3, 8, 10, 0); // Tuesday 08:10

      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => currentTime.getTime(),
      });
      vi.spyOn(service, 'generateReport').mockImplementation(async () => {
        callCount++;
        return { path: '', content: '' };
      });

      // First run at 08:10 -> should run
      await service.checkScheduledReports();
      expect(callCount).toBe(1);

      // Second check at 08:20 on same day -> should skip
      currentTime = new Date(2026, 10, 3, 8, 20, 0);
      await service.checkScheduledReports();
      expect(callCount).toBe(1);

      // Next day at 08:10 -> should run
      currentTime = new Date(2026, 10, 4, 8, 10, 0);
      await service.checkScheduledReports();
      expect(callCount).toBe(2);
    });

    it('respects time window and does not run before scheduled time or way after', async () => {
      let callCount = 0;
      // Before 08:00 (e.g. 07:45)
      let currentTime = new Date(2026, 10, 3, 7, 45, 0);

      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => currentTime.getTime(),
      });
      vi.spyOn(service, 'generateReport').mockImplementation(async () => {
        callCount++;
        return { path: '', content: '' };
      });

      await service.checkScheduledReports();
      expect(callCount).toBe(0);

      // Far after (>60 minutes, e.g. 10:30)
      currentTime = new Date(2026, 10, 3, 10, 30, 0);
      await service.checkScheduledReports();
      expect(callCount).toBe(0);
    });
  });

  describe('HTTP Route & Overwrite', () => {
    it('POST /api/integrations/openproject/sources/:id/daily-report generates and overwrites report', async () => {
      const service = new DailyReportService({
        config,
        eventBus,
        fetchFn: fakeFetch,
        now: () => parseDateNoon('2026-11-03').getTime(),
      });

      const fastify = Fastify({ logger: false });
      registerOpenProjectRoutes(fastify, config, {
        dailyReport: (id, date) =>
          service.generateReport(id, date ? parseDateNoon(date) : undefined, { overwrite: true }),
      });

      // Manual call for today
      const res1 = await fastify.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/demo/daily-report',
      });
      expect(res1.statusCode).toBe(200);
      const json1 = res1.json();
      expect(json1.ok).toBe(true);
      expect(json1.path).toContain('bao-cao-03-11-2026.txt');

      // Manual call with custom date parameter ?date=2026-11-04
      const res2 = await fastify.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/demo/daily-report?date=2026-11-04',
      });
      expect(res2.statusCode).toBe(200);
      const json2 = res2.json();
      expect(json2.ok).toBe(true);
      expect(json2.path).toContain('bao-cao-04-11-2026.txt');
      expect(json2.content).toContain('Ngày: 04/11/2026');

      // Invalid date parameter format
      const resBad = await fastify.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/demo/daily-report?date=not-a-date',
      });
      expect(resBad.statusCode).toBe(400);

      // Unknown source returns 404
      const res404 = await fastify.inject({
        method: 'POST',
        url: '/api/integrations/openproject/sources/unknown/daily-report',
      });
      expect(res404.statusCode).toBe(404);
    });

    it('handles daily_report events in TelegramBotService', () => {
      const sentMessages: string[] = [];
      const tgConfig = {
        ...config,
        telegram: {
          ...config.telegram,
          enabled: true,
          allowedChatIds: [12345],
        },
      };
      const bot = new TelegramBotService({
        config: tgConfig,
        projectRepo: { get: () => null } as unknown as import('../src/db/index.js').ProjectRepo,
        taskRepo: { get: () => null } as unknown as import('../src/db/index.js').TaskRepo,
        profileRepo: { getAll: () => [] } as unknown as import('../src/db/index.js').ProfileRepo,
        quotaMarkRepo: { getAll: () => [] } as unknown as import('../src/db/index.js').QuotaMarkRepo,
        eventBus: { emit: () => true, on: () => {}, off: () => {} } as unknown as import('../src/scheduler/index.js').EventBus,
      });
      vi.spyOn(bot, 'broadcastMessage').mockImplementation((text) => {
        sentMessages.push(text);
      });

      bot.handleEvent('daily_report.created', undefined, {
        sourceId: 'demo',
        date: '2026-11-03',
        telegram: true,
        content: 'Ngày: 03/11/2026\n1. Hôm qua đã làm gì?\n- [OP-1] - Done\n2. Hôm nay làm gì ?\n- [OP-2] - Plan\n',
      });

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Ngày: 03/11/2026');

      bot.handleEvent('daily_report.failed', undefined, {
        sourceId: 'demo',
        error: 'Connection timeout',
      });

      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]).toContain('Tạo báo cáo ngày thất bại: demo');
    });
  });
});
