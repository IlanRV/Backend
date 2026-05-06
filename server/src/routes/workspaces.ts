import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import {
  deleteDoc,
  deleteDocsByQuery,
  deleteQuerySnapshot,
  getCollection,
  getDoc,
  setDoc,
} from '../lib/firebase';
import { ChatMessage, Repo, Workspace } from '../types';
import { createLogger } from '../lib/logger';
import { toApiRepo } from '../lib/repoResponse';

const router = Router();
const logger = createLogger('routes-workspaces');
const MAX_WORKSPACES = 3;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function repoFromDoc(document: FirebaseFirestore.QueryDocumentSnapshot): Repo {
  const repo = {
    ...(document.data() as Repo),
    id: document.id,
    repoId: document.id,
  } as Repo;

  return toApiRepo(repo);
}

function byCreatedAt(left: { createdAt: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}

router.get(
  '/workspaces',
  asyncHandler(async (_req, res) => {
    const workspaceSnapshot = await getCollection('workspaces').orderBy('createdAt', 'asc').get();

    const workspaces = await Promise.all(
      workspaceSnapshot.docs.map(async (document) => {
        const workspace = {
          ...(document.data() as Workspace),
          id: document.id,
          workspaceId: document.id,
        };
        const repoSnapshot = await getCollection('repos')
          .where('workspaceId', '==', workspace.workspaceId)
          .get();

        return {
          ...workspace,
          repoCount: repoSnapshot.size,
        };
      })
    );

    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=300');
    res.json(workspaces);
  })
);

router.post(
  '/workspaces',
  asyncHandler(async (req, res) => {
    const { name, description } = req.body as { name?: unknown; description?: unknown };

    if (!isNonEmptyString(name) || typeof description !== 'string') {
      throw createHttpError(400, 'name and description are required');
    }

    const workspaceSnapshot = await getCollection('workspaces').get();

    if (workspaceSnapshot.size >= MAX_WORKSPACES) {
      logger.warn('workspace_limit_reached', {
        workspaceCount: workspaceSnapshot.size,
        workspaceLimit: MAX_WORKSPACES,
      });
      throw createHttpError(409, 'Workspace limit reached. Delete a workspace before creating another.');
    }

    const workspace: Workspace = {
      workspaceId: uuidv4(),
      name: name.trim(),
      description: description.trim(),
      createdAt: new Date().toISOString(),
    };

    await setDoc('workspaces', workspace.workspaceId, workspace);

    logger.info('workspace_created', {
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      hasDescription: workspace.description.length > 0,
    });
    res.status(201).json({ ...workspace, id: workspace.workspaceId, repoCount: 0 });
  })
);

router.get(
  '/workspaces/:id',
  asyncHandler(async (req, res) => {
    const workspaceId = getRouteParam(req, 'id');
    const workspace = await getDoc<Workspace>('workspaces', workspaceId);

    if (!workspace) {
      throw createHttpError(404, 'Workspace not found');
    }

    const repoSnapshot = await getCollection('repos')
      .where('workspaceId', '==', workspace.workspaceId)
      .get();
    const repos = repoSnapshot.docs.map(repoFromDoc).sort(byCreatedAt);

    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=300');
    res.json({
      ...workspace,
      repoCount: repos.length,
      repos,
    });
  })
);

router.delete(
  '/workspaces/:id',
  asyncHandler(async (req, res) => {
    const workspaceId = getRouteParam(req, 'id');
    const workspace = await getDoc<Workspace>('workspaces', workspaceId);

    if (!workspace) {
      throw createHttpError(404, 'Workspace not found');
    }

    const repoSnapshot = await getCollection('repos')
      .where('workspaceId', '==', workspace.workspaceId)
      .get();

    await Promise.all(
      repoSnapshot.docs.map((document) =>
        Promise.all([
          deleteDocsByQuery(
            getCollection('chat_messages')
              .where('scopeType', '==', 'repo' satisfies ChatMessage['scopeType'])
              .where('scopeId', '==', document.id)
          ),
          deleteDocsByQuery(getCollection('repo_files').where('repoId', '==', document.id)),
          deleteDocsByQuery(getCollection('repo_security_events').where('repoId', '==', document.id)),
        ])
      )
    );
    await deleteDocsByQuery(
      getCollection('chat_messages')
        .where('scopeType', '==', 'workspace' satisfies ChatMessage['scopeType'])
        .where('scopeId', '==', workspace.workspaceId)
    );
    await deleteQuerySnapshot(repoSnapshot);
    await deleteDoc('workspaces', workspace.workspaceId);

    logger.info('workspace_deleted', {
      workspaceId: workspace.workspaceId,
      repoCount: repoSnapshot.size,
    });
    res.json({ success: true });
  })
);

export default router;
