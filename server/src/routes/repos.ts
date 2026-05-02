import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { deleteDoc, deleteDocsByQuery, getCollection, getDoc, setDoc } from '../lib/firebase';
import { ChatMessage, Repo, Workspace } from '../types';

const router = Router();

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
      analysis: null,
      aiReadme: null,
      portalUrl: null,
      createdAt: new Date().toISOString(),
    };

    await setDoc('repos', repo.repoId, repo);

    res.status(201).json(repo);
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

    res.json(repo);
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
    await deleteDoc('repos', repo.repoId);

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

    await setDoc(
      'repos',
      repo.repoId,
      {
        status: 'running' satisfies Repo['status'],
        portalUrl: portalUrl.trim(),
      },
      { merge: true }
    );

    res.json({ success: true });
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

    await setDoc(
      'repos',
      repo.repoId,
      {
        status: 'ready' satisfies Repo['status'],
        portalUrl: null,
      },
      { merge: true }
    );

    res.json({ success: true });
  })
);

export default router;