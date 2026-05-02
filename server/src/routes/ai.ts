import { Router } from 'express';
import { createHash } from 'crypto';
import { config } from '../config';
import { extractAll, type ExtractionFile } from '../ai/extraction';
import { getDoc, setDoc } from '../lib/firebase';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { createLogger } from '../lib/logger';
import type { FileTreeNode, Repo } from '../types';

const router = Router();
const logger = createLogger('routes-ai');
const activeExtractions = new Map<string, string>();
const staleAnalysisMs = 15 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExtractionFile(value: unknown): value is ExtractionFile {
  return isRecord(value) && typeof value.path === 'string' && typeof value.content === 'string';
}

function getRequestFiles(body: unknown): ExtractionFile[] {
  if (!isRecord(body) || !Array.isArray(body.files)) {
    throw createHttpError(400, 'files must be an array of { path, content } objects');
  }

  const files = body.files.filter(isExtractionFile).filter((file) => file.path.trim().length > 0);

  if (files.length === 0) {
    throw createHttpError(400, 'At least one source file is required for extraction');
  }

  return files;
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
  return Number.isFinite(startedAt) && Date.now() - startedAt < staleAnalysisMs;
}

router.post(
  '/extract/:repoId',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'repoId');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const files = getRequestFiles(req.body);
    const fileTree = getRequestFileTree(req.body, files);
    const structuredFileTree = getStructuredFileTree(req.body);
    const sourceHash = createExtractionSourceHash(fileTree, files);

    logger.info('ai_extraction_requested', {
      repoId: repo.repoId,
      repoName: repo.name,
      fileCount: files.length,
      fileTreeLineCount: fileTree.split('\n').filter(Boolean).length,
    });

    if (activeExtractions.has(repo.repoId) || isFreshAnalyzing(repo)) {
      res.status(202).json({ success: true, extractionId: repo.repoId, status: 'analyzing', deduped: true });
      return;
    }

    if (repo.analysis && repo.aiReadme && repo.analysisSourceHash === sourceHash) {
      res.json({ success: true, extractionId: repo.repoId, status: repo.status, cached: true });
      return;
    }

    const repoUpdate: Partial<Repo> = {
      status: 'analyzing',
      analysisSourceHash: sourceHash,
      analysisStartedAt: new Date().toISOString(),
      analysisModel: config.openrouter.apiKey ? config.openrouter.model : null,
    };

    if (structuredFileTree) {
      repoUpdate.fileTree = structuredFileTree;
    }

    await setDoc('repos', repo.repoId, repoUpdate, { merge: true });
    activeExtractions.set(repo.repoId, sourceHash);

    void extractAll(repo.repoId, repo.name, fileTree, files, { sourceHash })
      .then((result) => {
        logger.info('ai_extraction_background_completed', {
          repoId: repo.repoId,
          functionCount: result.analysis.functions.length,
        });
      })
      .catch((error: unknown) => {
        logger.error('ai_extraction_background_failed', { repoId: repo.repoId, error });
        void setDoc('repos', repo.repoId, { status: 'error' satisfies Repo['status'] }, { merge: true });
      })
      .finally(() => {
        activeExtractions.delete(repo.repoId);
      });

    res.status(202).json({ success: true, extractionId: repo.repoId, status: 'analyzing' });
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

    logger.debug('ai_extraction_result_requested', {
      repoId,
      status: repo.status,
      hasAnalysis: Boolean(repo.analysis),
      hasAiReadme: Boolean(repo.aiReadme),
    });

    res.json({
      status: repo.status,
      techStack: repo.analysis?.techStack || null,
      overview: repo.analysis?.overview || null,
      functions: repo.analysis?.functions || [],
      dependencies: repo.analysis?.dependencies || {},
      aiReadme: repo.aiReadme || null,
      runnability: repo.runnability || null,
    });
  })
);

export default router;
