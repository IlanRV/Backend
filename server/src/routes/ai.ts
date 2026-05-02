import { Router } from 'express';
import { getDoc } from '../lib/firebase';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { Repo } from '../types';

const router = Router();

router.post(
  '/extract/:repoId',
  asyncHandler(async () => {
    throw createHttpError(501, 'AI extraction is reserved for Engineer B and is not implemented yet.');
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
    if (!repo.analysis) {
      throw createHttpError(404, 'No cached extraction found for this repo');
    }

    res.json({ ...repo.analysis, aiReadme: repo.aiReadme });
  })
);

export default router;