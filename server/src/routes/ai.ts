import { Router } from 'express';
import { createHash } from 'crypto';
import { config } from '../config';
import { extractAll, type ExtractionFile } from '../ai/extraction';
import { getDoc, setDoc } from '../lib/firebase';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { createLogger } from '../lib/logger';
import { listRepoFiles, saveRepoFiles } from '../lib/repoFiles';
import type { AnalysisProgress, FileTreeNode, Repo } from '../types';

const router = Router();
const logger = createLogger('routes-ai');
const activeExtractions = new Map<string, string>();
const analysisTimeoutMs = 15 * 60 * 1000;

function createAnalysisProgress(
  phase: AnalysisProgress['phase'],
  percent: number,
  message: string
): AnalysisProgress {
  return {
    phase,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    message,
    updatedAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExtractionFile(value: unknown): value is ExtractionFile {
  return isRecord(value) && typeof value.path === 'string' && typeof value.content === 'string';
}

function getOptionalRequestFiles(body: unknown): ExtractionFile[] | null {
  if (!isRecord(body) || !Array.isArray(body.files)) {
    return null;
  }

  const files = body.files.filter(isExtractionFile).filter((file) => file.path.trim().length > 0);

  return files.length > 0 ? files : null;
}

function shouldUseStoredFiles(body: unknown): boolean {
  return isRecord(body) && body.useStoredFiles === true;
}

async function getExtractionFiles(body: unknown, repo: Repo): Promise<ExtractionFile[]> {
  const requestFiles = getOptionalRequestFiles(body);

  if (requestFiles) {
    return requestFiles;
  }

  if (!shouldUseStoredFiles(body)) {
    throw createHttpError(400, 'files must be an array of { path, content } objects');
  }

  const storedFiles = await listRepoFiles(repo.repoId);

  if (storedFiles.length === 0) {
    throw createHttpError(409, 'No cached source files are available for this repo yet');
  }

  return storedFiles;
}

function collectTreePaths(node: unknown, output: string[]): void {
  if (!isRecord(node)) {
    return;
  }

  if (node.type === 'file' && typeof node.path === 'string' && node.path.trim().length > 0) {
    output.push(node.path.trim());
  }

  if (Array.isArray(node.children)) {
    node.children.forEach((child) => collectTreePaths(child, output));
  }
}

function normalizeFileTreeNode(value: unknown): FileTreeNode | null {
  if (!isRecord(value)) {
    return null;
  }

  const name = typeof value.name === 'string' ? value.name : null;
  const path = typeof value.path === 'string' ? value.path : null;
  const type = value.type === 'file' || value.type === 'directory' ? value.type : null;

  if (!name || path === null || !type) {
    return null;
  }

  const children = Array.isArray(value.children)
    ? value.children
        .map((child) => normalizeFileTreeNode(child))
        .filter((child): child is FileTreeNode => Boolean(child))
    : undefined;

  const node: FileTreeNode = {
    name,
    path,
    type,
  };

  if (children && children.length > 0) {
    node.children = children;
  }
  if (typeof value.extension === 'string') {
    node.extension = value.extension;
  }
  if (typeof value.size === 'number') {
    node.size = value.size;
  }
  if (typeof value.supported === 'boolean') {
    node.supported = value.supported;
  }

  return node;
}

function getStructuredFileTree(body: unknown): FileTreeNode | null {
  if (!isRecord(body) || !isRecord(body.fileTree)) {
    return null;
  }

  return normalizeFileTreeNode(body.fileTree);
}

function getRequestFileTree(body: unknown, files: ExtractionFile[]): string {
  if (!isRecord(body)) {
    return files.map((file) => file.path).join('\n');
  }

  if (typeof body.fileTree === 'string' && body.fileTree.trim().length > 0) {
    return body.fileTree.trim();
  }

  if (isRecord(body.fileTree)) {
    const paths: string[] = [];
    collectTreePaths(body.fileTree, paths);

    if (paths.length > 0) {
      return paths.sort((left, right) => left.localeCompare(right)).join('\n');
    }
  }

  return files.map((file) => file.path).sort((left, right) => left.localeCompare(right)).join('\n');
}

function createExtractionSourceHash(fileTree: string, files: ExtractionFile[]): string {
  const hash = createHash('sha256');
  hash.update(fileTree);

  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update('\0');
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.content);
  }

  return hash.digest('hex');
}

function isFreshAnalyzing(repo: Repo): boolean {
  if (repo.status !== 'analyzing') {
    return false;
  }

  if (!repo.analysisStartedAt) {
    return true;
  }

  const startedAt = Date.parse(repo.analysisStartedAt);
  return Number.isFinite(startedAt) && Date.now() - startedAt < analysisTimeoutMs;
}

function isTimedOutAnalyzing(repo: Repo): boolean {
  if (repo.status !== 'analyzing' || !repo.analysisStartedAt) {
    return false;
  }

  const startedAt = Date.parse(repo.analysisStartedAt);
  return Number.isFinite(startedAt) && Date.now() - startedAt >= analysisTimeoutMs;
}

async function resolveTimedOutAnalysis<TRepo extends Repo>(repo: TRepo): Promise<TRepo> {
  if (!isTimedOutAnalyzing(repo)) {
    return repo;
  }

  const updatedAt = new Date().toISOString();
  const analysisProgress = createAnalysisProgress(
    'error',
    100,
    'Extraction timed out. Retry to start a fresh analysis.'
  );
  const nextRepo = {
    ...repo,
    status: 'error',
    aiReadmeStatus: 'error',
    analysisError: 'Extraction timed out before the background job completed.',
    analysisProgress,
    updatedAt,
  } satisfies TRepo;

  activeExtractions.delete(repo.repoId);
  await setDoc(
    'repos',
    repo.repoId,
    {
      status: nextRepo.status,
      aiReadmeStatus: nextRepo.aiReadmeStatus,
      analysisError: nextRepo.analysisError,
      analysisProgress,
      updatedAt,
    },
    { merge: true }
  );

  logger.warn('ai_extraction_marked_timed_out', { repoId: repo.repoId });
  return nextRepo;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown extraction error';
}

router.post(
  '/extract/:repoId',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'repoId');
    let repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    repo = await resolveTimedOutAnalysis(repo);

    const files = await getExtractionFiles(req.body, repo);
    const fileTree = getRequestFileTree(req.body, files);
    const structuredFileTree = getStructuredFileTree(req.body);
    const sourceHash = createExtractionSourceHash(fileTree, files);

    await Promise.all([
      saveRepoFiles(repo.repoId, files, sourceHash),
      structuredFileTree
        ? setDoc(
            'repos',
            repo.repoId,
            {
              fileTree: structuredFileTree,
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          )
        : Promise.resolve(),
    ]);

    if (activeExtractions.has(repo.repoId) || isFreshAnalyzing(repo)) {
      res.status(202).json({
        success: true,
        extractionId: repo.repoId,
        status: 'analyzing',
        deduped: true,
        analysisProgress: repo.analysisProgress ?? createAnalysisProgress('queued', 10, 'Extraction already running'),
      });
      return;
    }

    if (repo.analysis?.security && repo.aiReadme && repo.analysisSourceHash === sourceHash) {
      res.json({
        success: true,
        extractionId: repo.repoId,
        status: repo.status,
        cached: true,
        analysisProgress: repo.analysisProgress ?? null,
      });
      return;
    }

    const analysisProgress = createAnalysisProgress('queued', 10, 'Queued extraction job');
    const repoUpdate: Partial<Repo> = {
      status: 'analyzing',
      analysisSourceHash: sourceHash,
      analysisStartedAt: new Date().toISOString(),
      analysisError: null,
      analysisProgress,
      analysisModel: config.openrouter.apiKey ? config.openrouter.model : null,
      aiReadmeStatus: 'pending',
      updatedAt: new Date().toISOString(),
    };

    if (structuredFileTree) {
      repoUpdate.fileTree = structuredFileTree;
    }

    await setDoc('repos', repo.repoId, repoUpdate, { merge: true });
    activeExtractions.set(repo.repoId, sourceHash);

    void extractAll(repo.repoId, repo.name, fileTree, files, { sourceHash })
      .catch((error: unknown) => {
        logger.error('ai_extraction_background_failed', { repoId: repo.repoId, error });
        void setDoc(
          'repos',
          repo.repoId,
          {
            status: 'error' satisfies Repo['status'],
            aiReadmeStatus: 'error' satisfies NonNullable<Repo['aiReadmeStatus']>,
            analysisError: errorMessage(error),
            analysisProgress: createAnalysisProgress('error', 100, 'Extraction failed'),
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      })
      .finally(() => {
        activeExtractions.delete(repo.repoId);
      });

    res.status(202).json({ success: true, extractionId: repo.repoId, status: 'analyzing', analysisProgress });
  })
);

router.get(
  '/extract/:repoId',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'repoId');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const currentRepo = await resolveTimedOutAnalysis(repo);
    res.json({
      success: true,
      extractionId: currentRepo.repoId,
      status: currentRepo.status,
      aiReadmeStatus:
        currentRepo.aiReadmeStatus ??
        (currentRepo.aiReadme
          ? 'ready'
          : currentRepo.status === 'analyzing' || currentRepo.status === 'cloning'
            ? 'pending'
            : currentRepo.status === 'error'
              ? 'error'
              : null),
      techStack: currentRepo.analysis?.techStack || null,
      overview: currentRepo.analysis?.overview || null,
      functions: currentRepo.analysis?.functions || [],
      dependencies: currentRepo.analysis?.dependencies || {},
      security: currentRepo.analysis?.security || null,
      aiReadme: currentRepo.aiReadme || null,
      runnability: currentRepo.runnability || null,
      analysisUpdatedAt: currentRepo.analysisUpdatedAt || null,
      analysisModel: currentRepo.analysisModel || null,
      analysisError: currentRepo.analysisError || null,
      analysisProgress: currentRepo.analysisProgress || null,
    });
  })
);

export default router;
