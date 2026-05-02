import { Router } from 'express';
import { extractAll, type ExtractionFile } from '../ai/extraction';
import { getDoc, setDoc } from '../lib/firebase';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { createLogger } from '../lib/logger';
import type { Repo } from '../types';

const router = Router();
const logger = createLogger('routes-ai');

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

    logger.info('ai_extraction_requested', {
      repoId: repo.repoId,
      repoName: repo.name,
      fileCount: files.length,
      fileTreeLineCount: fileTree.split('\n').filter(Boolean).length,
    });

    await setDoc('repos', repo.repoId, { status: 'analyzing' satisfies Repo['status'] }, { merge: true });

    void extractAll(repo.repoId, repo.name, fileTree, files)
      .then((result) => {
        logger.info('ai_extraction_background_completed', {
          repoId: repo.repoId,
          functionCount: result.analysis.functions.length,
        });
      })
      .catch((error: unknown) => {
        logger.error('ai_extraction_background_failed', { repoId: repo.repoId, error });
        void setDoc('repos', repo.repoId, { status: 'error' satisfies Repo['status'] }, { merge: true });
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
