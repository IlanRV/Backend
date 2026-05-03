import { createHash } from 'crypto';
import { getCollection, getDoc, setDoc } from './firebase';
import type { RepoFile } from '../types';

interface SourceFile {
  path: string;
  content: string;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/^\/+/, '');
}

export function repoFileDocId(repoId: string, path: string): string {
  const pathHash = createHash('sha256').update(normalizeRepoPath(path)).digest('hex').slice(0, 40);
  return `${repoId}_${pathHash}`;
}

export async function saveRepoFiles(
  repoId: string,
  files: SourceFile[],
  sourceHash?: string
): Promise<void> {
  const now = new Date().toISOString();

  await Promise.all(
    files.map((file) => {
      const normalizedPath = normalizeRepoPath(file.path);
      const repoFile: RepoFile = {
        repoFileId: repoFileDocId(repoId, normalizedPath),
        repoId,
        path: normalizedPath,
        content: file.content,
        size: Buffer.byteLength(file.content, 'utf8'),
        sourceHash,
        createdAt: now,
        updatedAt: now,
      };

      return setDoc('repo_files', repoFile.repoFileId, repoFile, { merge: true });
    })
  );
}

export async function getRepoFile(repoId: string, path: string): Promise<RepoFile | null> {
  return getDoc<RepoFile>('repo_files', repoFileDocId(repoId, path));
}

export async function listRepoFiles(repoId: string): Promise<SourceFile[]> {
  const snapshot = await getCollection('repo_files').where('repoId', '==', repoId).get();

  return snapshot.docs
    .map((document) => document.data() as RepoFile)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({ path: file.path, content: file.content }));
}
