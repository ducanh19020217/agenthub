import { Task, TaskStatus } from '../types/api';

export const KANBAN_STATUSES: TaskStatus[] = [
  'draft',
  'queued',
  'running',
  'checking',
  'waiting_quota',
  'review',
  'blocked',
  'failed',
  'done',
  'pushed',
];

export function groupTasksByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const groups: Record<TaskStatus, Task[]> = {
    draft: [],
    queued: [],
    running: [],
    checking: [],
    waiting_quota: [],
    review: [],
    blocked: [],
    failed: [],
    done: [],
    pushed: [],
    cancelled: [],
  };

  for (const task of tasks) {
    if (groups[task.status]) {
      groups[task.status].push(task);
    } else {
      groups.draft.push(task);
    }
  }

  return groups;
}
