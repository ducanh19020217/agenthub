import { describe, expect, it } from 'vitest';
import { commitConventionExample, renderCommitTemplate, renderTaskBranch, taskCommitRef } from '../src/commit-convention.js';
import { buildCommitConventionPrompt, buildTicketWorkflowPrompt } from '../src/scheduler/index.js';
import { projectSettings } from '../src/projects/settings.js';

describe('project commit conventions', () => {
  it('renders templates and preserves legacy defaults', () => {
    const project = { settings: null };
    expect(renderTaskBranch(project, { slug: 'login', externalRef: null })).toBe('agenthub/login');
    expect(projectSettings(project).commitConvention.mergeMessageTemplate).toBe("Merge branch '{branch}' into {target}");
    expect(renderCommitTemplate('{type}({scope}): {ref} {summary}', {
      type: 'feat', scope: 'auth', ref: 'OP#123', summary: 'add login',
    })).toBe('feat(auth): OP#123 add login');
  });

  it('renders a concrete example for a configured project', () => {
    const project = {
      settings: JSON.stringify({
        commitConvention: {
          branchTemplate: 'feature/{ref}-{slug}',
          commitTemplate: '{type}({scope}): {ref} {summary}',
          mergeMessageTemplate: 'merge {branch} -> {target}',
        },
      }),
    };
    expect(commitConventionExample(project, 'PROJ-45')).toEqual({
      branch: 'feature/PROJ-45-add-login',
      message: 'feat(auth): PROJ-45 add login',
    });
  });

  it('uses the task ref before the project default ref, and keeps empty refs empty', () => {
    const project = { settings: JSON.stringify({ commitConvention: { defaultRef: 'SIE-19', branchTemplate: 'feature/{ref}-{slug}' } }) };
    expect(taskCommitRef(project, { externalRef: 'SIE-20' })).toBe('SIE-20');
    expect(taskCommitRef(project, { externalRef: null })).toBe('SIE-19');
    expect(renderTaskBranch(project, { slug: 'login', externalRef: null })).toBe('feature/SIE-19-login');
    expect(taskCommitRef({ settings: null }, { externalRef: null })).toBe('');
  });

  it('prints the resolved ref and detailed commit-body instruction for workers', () => {
    const convention = {
      branchTemplate: 'agenthub/{slug}',
      commitTemplate: '[{ref}] {summary}',
      defaultRef: 'SIE-19',
      mergeMessageTemplate: 'merge {branch} -> {target}',
    };
    const prompt = buildCommitConventionPrompt(convention, 'agenthub/login', 'SIE-19', 'main');
    expect(prompt).toContain('[SIE-19] summary');
    expect(prompt).toContain('Thân commit phải có mô tả chi tiết');
    expect(prompt).not.toContain('REF-123');
  });

  it('prints shared ticket lifecycle rules only for linked tasks', () => {
    expect(buildTicketWorkflowPrompt({ externalRef: null })).toBe('');
    const prompt = buildTicketWorkflowPrompt({ externalRef: 'SIE-25', sourceId: 'sie', source: { inProgressStatusId: 94, resolvedStatusId: 95, autoResolve: true } });
    expect(prompt).toContain('SIE-25');
    expect(prompt).toContain('In progress (status 94)');
    expect(prompt).toContain('Resolved (status 95)');
    expect(prompt).toContain('## Đã làm');
  });
});
