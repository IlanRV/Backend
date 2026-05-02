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

const router = Router();

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function repoFromDoc(document: FirebaseFirestore.QueryDocumentSnapshot): Repo {
  return {
    ...(document.data() as Repo),
    repoId: document.id,
  };
}

router.get(
  '/workspaces',
  asyncHandler(async (_req, res) => {
    const workspaceSnapshot = await getCollection('workspaces').orderBy('createdAt', 'asc').get();

    const workspaces = await Promise.all(
      workspaceSnapshot.docs.map(async (document) => {
        const workspace = {
          ...(document.data() as Workspace),
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

    const workspace: Workspace = {
      workspaceId: uuidv4(),
      name: name.trim(),
      description: description.trim(),
      createdAt: new Date().toISOString(),
    };

    await setDoc('workspaces', workspace.workspaceId, workspace);

    res.status(201).json({ ...workspace, repoCount: 0 });
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
      .orderBy('createdAt', 'asc')
      .get();
    const repos = repoSnapshot.docs.map(repoFromDoc);

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
        deleteDocsByQuery(
          getCollection('chat_messages')
            .where('scopeType', '==', 'repo' satisfies ChatMessage['scopeType'])
            .where('scopeId', '==', document.id)
        )
      )
    );
    await deleteDocsByQuery(
      getCollection('chat_messages')
        .where('scopeType', '==', 'workspace' satisfies ChatMessage['scopeType'])
        .where('scopeId', '==', workspace.workspaceId)
    );
    await deleteQuerySnapshot(repoSnapshot);
    await deleteDoc('workspaces', workspace.workspaceId);

    res.json({ success: true });
  })
);

export default router;