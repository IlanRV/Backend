import { beforeEach, describe, expect, it, vi } from 'vitest';

const firebaseMocks = vi.hoisted(() => ({
  getDoc: vi.fn(),
  setDoc: vi.fn(),
}));

vi.mock('../../src/lib/firebase', () => firebaseMocks);

import { getRepoFile, repoFileDocId, saveRepoFiles } from '../../src/lib/repoFiles';

describe('repo file helpers', () => {
  beforeEach(() => {
    firebaseMocks.getDoc.mockReset();
    firebaseMocks.setDoc.mockReset();
  });

  it('creates stable IDs from normalized paths', () => {
    expect(repoFileDocId('repo-1', '/src/index.ts')).toBe(repoFileDocId('repo-1', 'src/index.ts'));
    expect(repoFileDocId('repo-1', 'src/index.ts')).toMatch(/^repo-1_[a-f0-9]{40}$/);
  });

  it('saves normalized file docs with byte sizes', async () => {
    await saveRepoFiles('repo-1', [{ path: '/src/index.ts', content: 'hello' }], 'hash-1');

    expect(firebaseMocks.setDoc).toHaveBeenCalledWith(
      'repo_files',
      repoFileDocId('repo-1', 'src/index.ts'),
      expect.objectContaining({
        repoFileId: repoFileDocId('repo-1', 'src/index.ts'),
        repoId: 'repo-1',
        path: 'src/index.ts',
        content: 'hello',
        size: 5,
        sourceHash: 'hash-1',
      }),
      { merge: true }
    );
  });

  it('loads cached repo files by normalized document ID', async () => {
    firebaseMocks.getDoc.mockResolvedValue({ path: 'src/index.ts', content: 'hello' });

    const file = await getRepoFile('repo-1', '/src/index.ts');

    expect(firebaseMocks.getDoc).toHaveBeenCalledWith('repo_files', repoFileDocId('repo-1', '/src/index.ts'));
    expect(file).toEqual({ path: 'src/index.ts', content: 'hello' });
  });
});
