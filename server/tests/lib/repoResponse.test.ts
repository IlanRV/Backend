import { describe, expect, it } from 'vitest';
import { toApiRepo } from '../../src/lib/repoResponse';
import type { Repo } from '../../src/types';

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo-1',
    workspaceId: 'workspace-1',
    name: 'demo',
    githubUrl: 'https://github.com/example/demo',
    status: 'ready',
    runnability: null,
    analysis: null,
    aiReadme: null,
    aiReadmeStatus: null,
    portalUrl: null,
    createdAt: '2026-05-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('toApiRepo', () => {
  it('adds frontend-friendly repo fields', () => {
    const apiRepo = toApiRepo(repo({
      runnability: { canRun: true, entryPoint: 'dev', blockers: [] },
      aiReadme: '# Demo',
    }));

    expect(apiRepo.id).toBe('repo-1');
    expect(apiRepo.runnable).toBe(true);
    expect(apiRepo.runScript).toBe('dev');
    expect(apiRepo.aiReadmeStatus).toBe('ready');
  });

  it('reports pending status while analysis is not done', () => {
    expect(toApiRepo(repo({ status: 'analyzing' })).aiReadmeStatus).toBe('pending');
    expect(toApiRepo(repo({ status: 'cloning' })).aiReadmeStatus).toBe('pending');
  });

  it('preserves explicit aiReadmeStatus values', () => {
    const apiRepo = toApiRepo(repo({ status: 'ready', aiReadmeStatus: 'error' }));

    expect(apiRepo.aiReadmeStatus).toBe('error');
    expect(apiRepo.runnable).toBe(false);
    expect(apiRepo.runScript).toBeNull();
  });
});
