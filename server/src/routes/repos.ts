import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { deleteDoc, deleteDocsByQuery, getCollection, getDoc, setDoc } from '../lib/firebase';
import { createLogger } from '../lib/logger';
import { getRepoFile } from '../lib/repoFiles';
import { toApiRepo } from '../lib/repoResponse';
import { ChatMessage, Repo, Workspace } from '../types';

const router = Router();
const logger = createLogger('routes-repos');

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getGithubRepoName(githubUrl: string): string | null {
  if (!githubUrl.startsWith('https://github.com/')) {
    return null;
  }

  try {
    const parsedUrl = new URL(githubUrl);

    if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'github.com') {
      return null;
    }

    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);

    if (pathSegments.length < 2) {
      return null;
    }

    const repoName = pathSegments[pathSegments.length - 1].replace(/\.git$/, '');
    return repoName || null;
  } catch {
    return null;
  }
}

router.post(
  '/workspaces/:id/repos',
  asyncHandler(async (req, res) => {
    const workspaceId = getRouteParam(req, 'id');
    const workspace = await getDoc<Workspace>('workspaces', workspaceId);

    if (!workspace) {
      throw createHttpError(404, 'Workspace not found');
    }

    const { githubUrl } = req.body as { githubUrl?: unknown };

    if (!isNonEmptyString(githubUrl)) {
      throw createHttpError(400, 'githubUrl is required');
    }

    const repoName = getGithubRepoName(githubUrl.trim());

    if (!repoName) {
      throw createHttpError(400, 'githubUrl must be a valid https://github.com/{owner}/{repo} URL');
    }

    const repo: Repo = {
      repoId: uuidv4(),
      workspaceId: workspace.workspaceId,
      name: repoName,
      githubUrl: githubUrl.trim(),
      status: 'cloning',
      runnability: null,
      fileTree: null,
      analysis: null,
      aiReadme: null,
      aiReadmeStatus: null,
      runnable: false,
      runScript: null,
      portalUrl: null,
      createdAt: new Date().toISOString(),
    };

    await setDoc('repos', repo.repoId, repo);

    logger.info('repo_created', {
      repoId: repo.repoId,
      workspaceId: workspace.workspaceId,
      repoName: repo.name,
      githubOwner: new URL(repo.githubUrl).pathname.split('/').filter(Boolean)[0],
    });
    res.status(201).json(toApiRepo(repo));
  })
);

router.get(
  '/repos/:id',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'id');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    logger.debug('repo_returned', {
      repoId: repo.repoId,
      workspaceId: repo.workspaceId,
      status: repo.status,
    });
    res.json(toApiRepo(repo));
  })
);

router.delete(
  '/repos/:id',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'id');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    await deleteDocsByQuery(
      getCollection('chat_messages')
        .where('scopeType', '==', 'repo' satisfies ChatMessage['scopeType'])
        .where('scopeId', '==', repo.repoId)
    );
    await deleteDocsByQuery(getCollection('repo_files').where('repoId', '==', repo.repoId));
    await deleteDoc('repos', repo.repoId);

    logger.info('repo_deleted', {
      repoId: repo.repoId,
      workspaceId: repo.workspaceId,
    });
    res.json({ success: true });
  })
);

router.post(
  '/repos/:id/run',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'id');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const { portalUrl } = req.body as { portalUrl?: unknown };

    if (!isNonEmptyString(portalUrl)) {
      throw createHttpError(400, 'portalUrl is required');
    }

    const nextRepo: Repo = {
      ...repo,
      status: 'running',
      portalUrl: portalUrl.trim(),
      updatedAt: new Date().toISOString(),
    };

    await setDoc(
      'repos',
      repo.repoId,
      {
        status: nextRepo.status,
        portalUrl: nextRepo.portalUrl,
        updatedAt: nextRepo.updatedAt,
      },
      { merge: true }
    );

    logger.info('repo_marked_running', {
      repoId: repo.repoId,
      workspaceId: repo.workspaceId,
      hasPortalUrl: Boolean(nextRepo.portalUrl),
    });
    res.json(toApiRepo(nextRepo));
  })
);

router.post(
  '/repos/:id/stop',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'id');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const nextRepo: Repo = {
      ...repo,
      status: 'ready',
      portalUrl: null,
      updatedAt: new Date().toISOString(),
    };

    await setDoc(
      'repos',
      repo.repoId,
      {
        status: nextRepo.status,
        portalUrl: nextRepo.portalUrl,
        updatedAt: nextRepo.updatedAt,
      },
      { merge: true }
    );

    logger.info('repo_marked_stopped', {
      repoId: repo.repoId,
      workspaceId: repo.workspaceId,
    });
    res.json(toApiRepo(nextRepo));
  })
);

router.get(
  '/repos/:id/file',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'id');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const path = typeof req.query.path === 'string' ? req.query.path : '';

    if (!isNonEmptyString(path)) {
      throw createHttpError(400, 'path query parameter is required');
    }

    const repoFile = await getRepoFile(repo.repoId, path);

    if (!repoFile) {
      throw createHttpError(404, 'File content has not been cached for this repo yet');
    }

    res.json({
      path: repoFile.path,
      content: repoFile.content,
      size: repoFile.size,
      updatedAt: repoFile.updatedAt,
    });
  })
);

export default router;
