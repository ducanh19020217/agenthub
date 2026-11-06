import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDatabase, ProjectRepo, TaskRepo, ReviewRepo } from '../src/db/index.js';

describe('Review engine and profileName columns (Migration 65)', () => {
  it('stores and retrieves engine and profileName, keeping null for legacy reviews', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-review-db-'));
    try {
      const dbPath = path.join(tmpDir, 'hub.db');
      const db = openDatabase(dbPath);

      const projectRepo = new ProjectRepo(db);
      projectRepo.insert({ id: 'proj', name: 'Proj', path: tmpDir, defaultBranch: 'main', maxParallel: 3 });

      const taskRepo = new TaskRepo(db);
      taskRepo.insert({ id: 'proj/t1', projectId: 'proj', slug: 't1', title: 'Task 1' });

      const reviewRepo = new ReviewRepo(db);

      // Legacy review without engine or profileName
      reviewRepo.insert({
        id: 'rev-legacy',
        taskId: 'proj/t1',
        verdict: 'approved',
        feedback: 'Looks good',
        actor: 'claude',
      });

      // New review with engine and profileName
      reviewRepo.insert({
        id: 'rev-agent',
        taskId: 'proj/t1',
        verdict: 'changes_requested',
        feedback: 'Fix typo',
        actor: 'codex-reviewer',
        engine: 'codex',
        profileName: 'codex-main',
      });

      const reviews = reviewRepo.getByTask('proj/t1');
      expect(reviews).toHaveLength(2);

      expect(reviews[0].id).toBe('rev-legacy');
      expect(reviews[0].actor).toBe('claude');
      expect(reviews[0].engine).toBeNull();
      expect(reviews[0].profileName).toBeNull();

      expect(reviews[1].id).toBe('rev-agent');
      expect(reviews[1].actor).toBe('codex-reviewer');
      expect(reviews[1].engine).toBe('codex');
      expect(reviews[1].profileName).toBe('codex-main');

      db.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
