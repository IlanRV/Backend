import type { Repo } from '../types';

export type ApiRepo = Repo & {
  id: string;
  runnable: boolean;
  runScript: string | null;
  aiReadmeStatus: NonNullable<Repo['aiReadmeStatus']> | null;
};

export function toApiRepo(repo: Repo): ApiRepo {
  return {
    ...repo,
    id: repo.repoId,
    runnable: repo.runnability?.canRun ?? false,
    runScript: repo.runnability?.entryPoint ?? null,
    aiReadmeStatus:
      repo.aiReadmeStatus ??
      (repo.aiReadme
        ? 'ready'
        : repo.status === 'analyzing' || repo.status === 'cloning'
          ? 'pending'
          : repo.status === 'error'
            ? 'error'
            : null),
  };
}
