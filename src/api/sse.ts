import fs from 'node:fs';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { EventBus } from '../scheduler/index.js';
import { AppService } from '../services/index.js';

function formatTimestamp(ts?: string | null): string {
  if (!ts) return new Date().toISOString();
  if (ts.includes('T')) return ts;
  return new Date(ts.replace(' ', 'T') + 'Z').toISOString();
}

export function registerSseRoute(fastify: FastifyInstance, service: AppService): void {
  fastify.get('/api/events', async (req: FastifyRequest, reply: FastifyReply) => {
    // Set standard SSE headers
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.flushHeaders();

    const eventBus: EventBus = service.scheduler.getEventBus();

    // Determine initial lastSentId and replay missed events if Last-Event-ID is provided
    const lastEventIdHeader = req.headers['last-event-id'];
    const queryLastId =
      (req.query as Record<string, string | undefined>)?.lastEventId ||
      (req.query as Record<string, string | undefined>)?.['last-event-id'];
    const rawLastId = Array.isArray(lastEventIdHeader)
      ? lastEventIdHeader[0]
      : (lastEventIdHeader ?? queryLastId);

    let lastSentId = 0;

    if (rawLastId !== undefined && rawLastId !== '') {
      const parsedLastId = parseInt(String(rawLastId).trim(), 10);
      if (!isNaN(parsedLastId) && parsedLastId >= 0) {
        lastSentId = parsedLastId;
        const missedEvents = service.eventRepo.getSince(parsedLastId).slice(0, 200);
        for (const ev of missedEvents) {
          try {
            let parsedPayload: unknown = null;
            if (ev.payload) {
              try {
                parsedPayload = JSON.parse(ev.payload);
              } catch {
                parsedPayload = ev.payload;
              }
            }
            const envelope: Record<string, unknown> = {
              type: ev.type,
              ts: formatTimestamp(ev.ts),
              ...(ev.taskId ? { taskId: ev.taskId } : {}),
              payload: parsedPayload,
            };
            reply.raw.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
            if (ev.id > lastSentId) {
              lastSentId = ev.id;
            }
          } catch {
            // stream closed
            break;
          }
        }
      }
    } else {
      const recent = service.eventRepo.getRecent(1);
      lastSentId = recent.length > 0 ? recent[0].id : 0;
    }

    // 1. Forward events from EventBus
    const onBusEvent = (type: string, taskId?: string, payload?: unknown) => {
      try {
        const recent = service.eventRepo.getRecent(1);
        let eventId: number;
        let ts = new Date().toISOString();
        if (recent.length > 0 && recent[0].id > lastSentId) {
          eventId = recent[0].id;
          lastSentId = eventId;
          ts = formatTimestamp(recent[0].ts);
        } else {
          lastSentId++;
          eventId = lastSentId;
        }

        const envelope: Record<string, unknown> = {
          type,
          ts,
          ...(taskId ? { taskId } : {}),
          payload: payload ?? null,
        };
        const payloadStr = JSON.stringify(envelope);
        reply.raw.write(`id: ${eventId}\nevent: ${type}\ndata: ${payloadStr}\n\n`);
      } catch {
        // stream may be closed
      }
    };

    eventBus.on('*', onBusEvent);

    // 2. Stream run.output for active runs
    // Check log file every ~1s, read new bytes up to 4KB per event, max 1 event/sec per run
    const fileOffsets = new Map<string, number>();

    const outputInterval = setInterval(() => {
      try {
        const runningMap = service.scheduler.getRunning();
        const reviewerMap = service.scheduler.getReviewerRuns();
        const activeRuns: Array<{ taskId: string; runId: string }> = [];
        for (const runningTask of runningMap.values()) {
          activeRuns.push({ taskId: runningTask.taskId, runId: runningTask.runId });
        }
        for (const reviewerRun of reviewerMap.values()) {
          activeRuns.push({ taskId: reviewerRun.taskId, runId: reviewerRun.runId });
        }

        const activeRunIds = new Set<string>();

        for (const activeItem of activeRuns) {
          const runId = activeItem.runId;
          activeRunIds.add(runId);

          const run = service.runRepo.get(runId);
          if (!run?.logPath || !fs.existsSync(run.logPath)) continue;

          let offset = fileOffsets.get(runId);
          let stat: fs.Stats;
          try {
            stat = fs.statSync(run.logPath);
          } catch {
            continue;
          }

          if (offset === undefined) {
            // First time seeing this run: start from current size or read last 4KB
            offset = Math.max(0, stat.size - 4096);
          }

          if (stat.size > offset) {
            const bytesToRead = Math.min(stat.size - offset, 4096);
            const buffer = Buffer.alloc(bytesToRead);
            try {
              const fd = fs.openSync(run.logPath, 'r');
              try {
                fs.readSync(fd, buffer, 0, bytesToRead, offset);
              } finally {
                fs.closeSync(fd);
              }

              fileOffsets.set(runId, offset + bytesToRead);
              const chunk = buffer.toString('utf-8');
              const envelope = {
                type: 'run.output',
                ts: new Date().toISOString(),
                taskId: activeItem.taskId,
                payload: {
                  runId,
                  chunk,
                },
              };
              reply.raw.write(`event: run.output\ndata: ${JSON.stringify(envelope)}\n\n`);
            } catch {
              // ignore transient read error
            }
          }
        }

        // Clean up finished runs
        for (const id of fileOffsets.keys()) {
          if (!activeRunIds.has(id)) {
            fileOffsets.delete(id);
          }
        }
      } catch {
        // stream or scheduler error
      }
    }, 1000);

    // 3. Ping every 20 seconds
    const pingInterval = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        // stream closed
      }
    }, 20000);

    // 4. Cleanup on disconnect
    req.raw.on('close', () => {
      clearInterval(outputInterval);
      clearInterval(pingInterval);
      eventBus.off('*', onBusEvent);
      fileOffsets.clear();
    });
  });
}
