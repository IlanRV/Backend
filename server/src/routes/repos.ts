import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { deleteDoc, deleteDocsByQuery, getCollection, getDoc, setDoc } from '../lib/firebase';
import { createLogger } from '../lib/logger';
import { getRepoFile } from '../lib/repoFiles';
import { toApiRepo } from '../lib/repoResponse';
import {
  ChatMessage,
  Repo,
  RuntimeSecurityCategory,
  RuntimeSecurityEvent,
  RuntimeSecurityEventSource,
  RuntimeSecurityPhase,
  RuntimeSecuritySummary,
  SecuritySeverity,
  Workspace,
} from '../types';

const router = Router();
const logger = createLogger('routes-repos');
const securitySeverities = ['info', 'low', 'medium', 'high', 'critical'] as const satisfies readonly SecuritySeverity[];
const runtimeSecuritySources = ['browserpod', 'frontend'] as const satisfies readonly RuntimeSecurityEventSource[];
const runtimeSecurityPhases = ['clone', 'install', 'start', 'preview', 'stop', 'runtime'] as const satisfies readonly RuntimeSecurityPhase[];
const runtimeSecurityCategories = [
  'filesystem',
  'network',
  'process',
  'resource',
  'install',
  'sandbox',
  'runtime',
  'other',
] as const satisfies readonly RuntimeSecurityCategory[];
const severityRank: Record<SecuritySeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function readEnum<T extends string>(value: unknown, values: readonly T[], field: string, fallback: T): T {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  if (!isOneOf(value, values)) {
    throw createHttpError(400, `${field} must be one of ${values.join(', ')}`);
  }

  return value;
}

function readRequiredString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw createHttpError(400, `${field} is required`);
  }

  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

function requiresSandboxConfirmation(repo: Repo): boolean {
  const riskLevel = repo.analysis?.security.riskLevel;
  return riskLevel === 'high' || riskLevel === 'critical';
}

function parseRuntimeSecurityEvent(repoId: string, body: unknown): RuntimeSecurityEvent {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const severity = readEnum(payload.severity, securitySeverities, 'severity', 'info');

  return {
    eventId: uuidv4(),
    repoId,
    source: readEnum(payload.source, runtimeSecuritySources, 'source', 'frontend'),
    phase: readEnum(payload.phase, runtimeSecurityPhases, 'phase', 'runtime'),
    category: readEnum(payload.category, runtimeSecurityCategories, 'category', 'runtime'),
    severity,
    title: readRequiredString(payload.title, 'title'),
    description: readRequiredString(payload.description, 'description'),
    evidence: readOptionalString(payload.evidence),
    command: readOptionalString(payload.command),
    createdAt: new Date().toISOString(),
  };
}

async function listRuntimeSecurityEvents(repoId: string): Promise<RuntimeSecurityEvent[]> {
  const snapshot = await getCollection('repo_security_events').where('repoId', '==', repoId).get();

  return snapshot.docs
    .map((document) => document.data() as RuntimeSecurityEvent)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function summarizeRuntimeSecurity(events: RuntimeSecurityEvent[]): RuntimeSecuritySummary {
  if (!events.length) {
    return { riskLevel: 'unknown', eventCount: 0, latestEventAt: null };
  }

  const riskLevel = events.reduce<SecuritySeverity>((highest, event) => {
    return severityRank[event.severity] > severityRank[highest] ? event.severity : highest;
  }, 'info');

  return {
    riskLevel,
    eventCount: events.length,
    latestEventAt: events[events.length - 1].createdAt,
  };
}

async function deleteRepoCascade(repo: Repo): Promise<void> {
  await deleteDocsByQuery(
    getCollection('chat_messages')
      .where('scopeType', '==', 'repo' satisfies ChatMessage['scopeType'])
      .where('scopeId', '==', repo.repoId)
  );
  await deleteDocsByQuery(getCollection('repo_files').where('repoId', '==', repo.repoId));
  await deleteDocsByQuery(getCollection('repo_security_events').where('repoId', '==', repo.repoId));
  await deleteDoc('repos', repo.repoId);
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
      runtimeSecurity: null,
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

    await deleteRepoCascade(repo);

    logger.info('repo_deleted', {
      repoId: repo.repoId,
      workspaceId: repo.workspaceId,
    });
    res.json({ success: true });
  })
);

router.delete(
  '/workspaces/:workspaceId/repos/:repoId',
  asyncHandler(async (req, res) => {
    const workspaceId = getRouteParam(req, 'workspaceId');
    const repoId = getRouteParam(req, 'repoId');
    const workspace = await getDoc<Workspace>('workspaces', workspaceId);

    if (!workspace) {
      throw createHttpError(404, 'Workspace not found');
    }

    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo || repo.workspaceId !== workspace.workspaceId) {
      throw createHttpError(404, 'Repo not found');
    }

    await deleteRepoCascade(repo);

    logger.info('repo_deleted', {
      repoId: repo.repoId,
      workspaceId: workspace.workspaceId,
    });
    res.json({ success: true, repoId: repo.repoId, workspaceId: workspace.workspaceId });
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

    const { portalUrl, sandboxConfirmed, manualOverride } = req.body as {
      portalUrl?: unknown;
      sandboxConfirmed?: unknown;
      manualOverride?: unknown;
    };

    if (!isNonEmptyString(portalUrl)) {
      throw createHttpError(400, 'portalUrl is required');
    }

    if (repo.runnability && !repo.runnability.canRun && manualOverride !== true) {
      throw createHttpError(409, 'Repo is not runnable automatically. Review blockers before using a manual sandbox override.');
    }

    if (requiresSandboxConfirmation(repo) && sandboxConfirmed !== true) {
      throw createHttpError(409, 'High-risk security findings require sandbox confirmation before running.');
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

router.post(
  '/repos/:id/security-events',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'id');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const event = parseRuntimeSecurityEvent(repo.repoId, req.body);
    await setDoc('repo_security_events', event.eventId, event);

    const events = await listRuntimeSecurityEvents(repo.repoId);
    const runtimeSecurity = summarizeRuntimeSecurity(events);

    await setDoc(
      'repos',
      repo.repoId,
      {
        runtimeSecurity,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    logger.warn('repo_runtime_security_event_recorded', {
      repoId: repo.repoId,
      severity: event.severity,
      phase: event.phase,
      category: event.category,
    });
    res.status(201).json({ success: true, event, runtimeSecurity });
  })
);

router.get(
  '/repos/:id/security',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'id');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const events = await listRuntimeSecurityEvents(repo.repoId);
    const runtimeSecurity = summarizeRuntimeSecurity(events);

    res.json({
      success: true,
      repoId: repo.repoId,
      staticSecurity: repo.analysis?.security ?? null,
      runtimeSecurity: {
        ...runtimeSecurity,
        events,
      },
      runnability: repo.runnability ?? null,
    });
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
