import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repo, SecurityScan, Workspace } from '../../src/types';

const firebaseState = vi.hoisted(() => ({
  collections: new Map<string, Map<string, any>>(),
}));

const aiMocks = vi.hoisted(() => ({
  callOpenRouterStructured: vi.fn(),
  extractAll: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  requestLogger: () => (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock('../../src/ai/openrouter', () => ({
  callOpenRouterStructured: aiMocks.callOpenRouterStructured,
  formatOpenRouterFailure: (error: unknown) => (error instanceof Error ? error.message : 'AI failed'),
  isOpenRouterFailure: () => false,
}));

vi.mock('../../src/ai/extraction', () => ({
  extractAll: aiMocks.extractAll,
}));

vi.mock('../../src/lib/firebase', () => {
  function collectionMap(name: string): Map<string, any> {
    let collection = firebaseState.collections.get(name);

    if (!collection) {
      collection = new Map<string, any>();
      firebaseState.collections.set(name, collection);
    }

    return collection;
  }

  function idField(collection: string): string {
    const fields: Record<string, string> = {
      workspaces: 'workspaceId',
      repos: 'repoId',
      repo_files: 'repoFileId',
      repo_security_events: 'eventId',
      chat_messages: 'messageId',
    };
    return fields[collection] || `${collection.slice(0, -1)}Id`;
  }

  function withId(collection: string, id: string, data: any): any {
    return { ...data, id, [idField(collection)]: data[idField(collection)] || id };
  }

  function documentSnapshot(collection: string, id: string, data: any): any {
    return {
      id,
      exists: Boolean(data),
      ref: { collection, id },
      data: () => ({ ...data }),
    };
  }

  function matches(data: any, filters: Array<{ field: string; value: unknown }>): boolean {
    return filters.every((filter) => data[filter.field] === filter.value);
  }

  function makeQuery(collection: string, filters: Array<{ field: string; value: unknown }> = [], orderField?: string): any {
    return {
      where(field: string, _operator: string, value: unknown) {
        return makeQuery(collection, [...filters, { field, value }], orderField);
      },
      orderBy(field: string) {
        return makeQuery(collection, filters, field);
      },
      async get() {
        const docs = [...collectionMap(collection).entries()]
          .filter(([, data]) => matches(data, filters))
          .sort((left, right) => {
            if (!orderField) return 0;
            return String(left[1][orderField] || '').localeCompare(String(right[1][orderField] || ''));
          })
          .map(([id, data]) => documentSnapshot(collection, id, data));

        return { docs, size: docs.length };
      },
    };
  }

  async function setDoc(collection: string, id: string, data: any, options?: { merge?: boolean }): Promise<void> {
    const docs = collectionMap(collection);
    const existing = docs.get(id) || {};
    docs.set(id, options?.merge ? { ...existing, ...data } : { ...data });
  }

  async function getDoc(collection: string, id: string): Promise<any | null> {
    const data = collectionMap(collection).get(id);
    return data ? withId(collection, id, data) : null;
  }

  async function deleteDoc(collection: string, id: string): Promise<void> {
    collectionMap(collection).delete(id);
  }

  async function deleteQuerySnapshot(snapshot: any): Promise<number> {
    for (const doc of snapshot.docs) {
      collectionMap(doc.ref.collection).delete(doc.id);
    }
    return snapshot.docs.length;
  }

  async function deleteDocsByQuery(query: any): Promise<number> {
    const snapshot = await query.get();
    return deleteQuerySnapshot(snapshot);
  }

  function getCollection(name: string): any {
    return {
      ...makeQuery(name),
      doc(id: string) {
        return {
          id,
          async get() {
            return documentSnapshot(name, id, collectionMap(name).get(id));
          },
          async set(data: any, options?: { merge?: boolean }) {
            await setDoc(name, id, data, options);
          },
          async delete() {
            await deleteDoc(name, id);
          },
        };
      },
    };
  }

  return { getCollection, getDoc, setDoc, deleteDoc, deleteQuerySnapshot, deleteDocsByQuery };
});

import { createApp } from '../../src/app';
import { getDoc, setDoc } from '../../src/lib/firebase';
import { repoFileDocId } from '../../src/lib/repoFiles';

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    workspaceId: 'workspace-1',
    name: 'Workspace',
    description: 'Backend work',
    createdAt: '2026-05-02T00:00:00.000Z',
    ...overrides,
  };
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo-1',
    workspaceId: 'workspace-1',
    name: 'demo',
    githubUrl: 'https://github.com/example/demo',
    status: 'ready',
    runnability: null,
    fileTree: null,
    analysis: null,
    aiReadme: null,
    aiReadmeStatus: null,
    runnable: false,
    runScript: null,
    portalUrl: null,
    createdAt: '2026-05-02T00:00:01.000Z',
    ...overrides,
  };
}

function securityScan(overrides: Partial<SecurityScan> = {}): SecurityScan {
  return {
    riskLevel: 'low',
    summary: 'No obvious suspicious indicators.',
    findings: [],
    dependencyRisks: [],
    scannedFiles: ['package.json'],
    notes: [],
    ...overrides,
  };
}

const app = createApp();

describe('backend routes', () => {
  beforeEach(() => {
    firebaseState.collections.clear();
    aiMocks.callOpenRouterStructured.mockReset();
    aiMocks.extractAll.mockReset();
    aiMocks.callOpenRouterStructured.mockResolvedValue({ reply: 'AI reply' });
    aiMocks.extractAll.mockResolvedValue({
      analysis: { functions: [] },
      aiReadme: '# Readme',
      runnability: { canRun: true, entryPoint: 'dev', blockers: [] },
    });
  });

  it('returns health and JSON 404 responses', async () => {
    const health = await request(app).get('/api/health').expect(200);
    expect(health.body.status).toBe('ok');

    const missing = await request(app).get('/missing').expect(404);
    expect(missing.body).toEqual({ error: 'Route not found' });
  });

  it('creates, lists, loads, and deletes workspaces', async () => {
    const created = await request(app)
      .post('/api/workspaces')
      .send({ name: '  Hackathon  ', description: '  Backend  ' })
      .expect(201);

    expect(created.body).toMatchObject({ name: 'Hackathon', description: 'Backend', repoCount: 0 });

    const listed = await request(app).get('/api/workspaces').expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ name: 'Hackathon', repoCount: 0 });

    await request(app).get(`/api/workspaces/${created.body.workspaceId}`).expect(200);
    await request(app).delete(`/api/workspaces/${created.body.workspaceId}`).expect(200);
    await request(app).get(`/api/workspaces/${created.body.workspaceId}`).expect(404);
  });

  it('returns workspaces in creation order with repo counts', async () => {
    await setDoc('workspaces', 'workspace-later', workspace({
      workspaceId: 'workspace-later',
      name: 'Later',
      createdAt: '2026-05-02T00:00:02.000Z',
    }));
    await setDoc('workspaces', 'workspace-earlier', workspace({
      workspaceId: 'workspace-earlier',
      name: 'Earlier',
      createdAt: '2026-05-02T00:00:01.000Z',
    }));
    await setDoc('repos', 'repo-1', repo({ workspaceId: 'workspace-earlier' }));

    const response = await request(app).get('/api/workspaces').expect(200);

    expect(response.body.map((item: any) => item.name)).toEqual(['Earlier', 'Later']);
    expect(response.body[0].repoCount).toBe(1);
    expect(response.body[1].repoCount).toBe(0);
  });

  it('deletes workspace repos plus repo and workspace scoped cached data', async () => {
    await setDoc('workspaces', 'workspace-1', workspace());
    await setDoc('repos', 'repo-1', repo());
    await setDoc('chat_messages', 'workspace-message', {
      messageId: 'workspace-message',
      scopeType: 'workspace',
      scopeId: 'workspace-1',
      role: 'user',
      content: 'workspace chat',
      timestamp: '1',
    });
    await setDoc('chat_messages', 'repo-message', {
      messageId: 'repo-message',
      scopeType: 'repo',
      scopeId: 'repo-1',
      role: 'user',
      content: 'repo chat',
      timestamp: '2',
    });
    await setDoc('repo_files', 'file-1', { repoFileId: 'file-1', repoId: 'repo-1', path: 'src/index.ts' });
    await setDoc('repo_security_events', 'event-1', { eventId: 'event-1', repoId: 'repo-1', title: 'timeout' });

    await request(app).delete('/api/workspaces/workspace-1').expect(200);

    expect(await getDoc('workspaces', 'workspace-1')).toBeNull();
    expect(await getDoc('repos', 'repo-1')).toBeNull();
    expect(await getDoc('chat_messages', 'workspace-message')).toBeNull();
    expect(await getDoc('chat_messages', 'repo-message')).toBeNull();
    expect(await getDoc('repo_files', 'file-1')).toBeNull();
    expect(await getDoc('repo_security_events', 'event-1')).toBeNull();
  });

  it('validates workspace creation and enforces the workspace limit', async () => {
    await request(app).post('/api/workspaces').send({ name: '', description: '' }).expect(400);

    for (let index = 1; index <= 3; index += 1) {
      await setDoc('workspaces', `workspace-${index}`, workspace({ workspaceId: `workspace-${index}` }));
    }

    const response = await request(app)
      .post('/api/workspaces')
      .send({ name: 'Too many', description: 'No room' })
      .expect(409);

    expect(response.body.error).toContain('Workspace limit reached');
  });

  it('creates repos and validates GitHub URLs', async () => {
    await setDoc('workspaces', 'workspace-1', workspace());

    await request(app).post('/api/workspaces/missing/repos').send({ githubUrl: 'https://github.com/a/b' }).expect(404);
    await request(app).post('/api/workspaces/workspace-1/repos').send({ githubUrl: 'not-github' }).expect(400);

    const created = await request(app)
      .post('/api/workspaces/workspace-1/repos')
      .send({ githubUrl: 'https://github.com/example/demo.git' })
      .expect(201);

    expect(created.body).toMatchObject({ name: 'demo', status: 'cloning', runnable: false });
    expect(await getDoc('repos', created.body.repoId)).toMatchObject({ githubUrl: 'https://github.com/example/demo.git' });
  });

  it('runs, stops, loads, and deletes repos', async () => {
    await setDoc('repos', 'repo-1', repo());

    await request(app).post('/api/repos/repo-1/run').send({ portalUrl: '' }).expect(400);

    const running = await request(app)
      .post('/api/repos/repo-1/run')
      .send({ portalUrl: 'https://preview.example.test' })
      .expect(200);
    expect(running.body).toMatchObject({ status: 'running', portalUrl: 'https://preview.example.test' });

    const stopped = await request(app).post('/api/repos/repo-1/stop').send({}).expect(200);
    expect(stopped.body).toMatchObject({ status: 'ready', portalUrl: null });

    await setDoc('chat_messages', 'message-1', {
      messageId: 'message-1',
      scopeType: 'repo',
      scopeId: 'repo-1',
      role: 'user',
      content: 'hi',
      timestamp: '1',
    });
    await setDoc('repo_files', 'file-1', { repoFileId: 'file-1', repoId: 'repo-1', path: 'src/index.ts' });
    await setDoc('repo_security_events', 'event-1', { eventId: 'event-1', repoId: 'repo-1', title: 'timeout' });

    await request(app).delete('/api/repos/repo-1').expect(200);
    expect(await getDoc('repos', 'repo-1')).toBeNull();
    expect(await getDoc('chat_messages', 'message-1')).toBeNull();
    expect(await getDoc('repo_files', 'file-1')).toBeNull();
    expect(await getDoc('repo_security_events', 'event-1')).toBeNull();
  });

  it('deletes repos through a workspace-scoped route', async () => {
    await setDoc('workspaces', 'workspace-1', workspace());
    await setDoc('workspaces', 'workspace-2', workspace({ workspaceId: 'workspace-2', name: 'Other' }));
    await setDoc('repos', 'repo-1', repo());
    await setDoc('repos', 'repo-other', repo({ repoId: 'repo-other', workspaceId: 'workspace-2' }));
    await setDoc('chat_messages', 'message-1', {
      messageId: 'message-1',
      scopeType: 'repo',
      scopeId: 'repo-1',
      role: 'user',
      content: 'hi',
      timestamp: '1',
    });
    await setDoc('repo_files', 'file-1', { repoFileId: 'file-1', repoId: 'repo-1', path: 'src/index.ts' });
    await setDoc('repo_security_events', 'event-1', { eventId: 'event-1', repoId: 'repo-1', title: 'timeout' });

    await request(app).delete('/api/workspaces/missing/repos/repo-1').expect(404);
    await request(app).delete('/api/workspaces/workspace-1/repos/missing').expect(404);
    await request(app).delete('/api/workspaces/workspace-1/repos/repo-other').expect(404);

    const response = await request(app).delete('/api/workspaces/workspace-1/repos/repo-1').expect(200);

    expect(response.body).toEqual({ success: true, repoId: 'repo-1', workspaceId: 'workspace-1' });
    expect(await getDoc('repos', 'repo-1')).toBeNull();
    expect(await getDoc('repos', 'repo-other')).toMatchObject({ repoId: 'repo-other', workspaceId: 'workspace-2' });
    expect(await getDoc('chat_messages', 'message-1')).toBeNull();
    expect(await getDoc('repo_files', 'file-1')).toBeNull();
    expect(await getDoc('repo_security_events', 'event-1')).toBeNull();
  });

  it('requires run confirmation for high-risk or unrunnable repos', async () => {
    await setDoc('repos', 'repo-risky', repo({
      repoId: 'repo-risky',
      analysis: {
        techStack: { language: 'JavaScript', framework: null, runtime: 'Node.js', buildTool: null, testingFramework: null, database: null, otherTools: [] },
        overview: { oneLiner: 'Risky', summary: 'Risky', purpose: 'Demo', targetUsers: 'Developers' },
        functions: [],
        dependencies: {},
        security: securityScan({ riskLevel: 'high', summary: 'Suspicious install script found.' }),
      },
      runnability: { canRun: true, entryPoint: 'dev', blockers: [] },
    }));
    await setDoc('repos', 'repo-blocked', repo({
      repoId: 'repo-blocked',
      runnability: {
        canRun: false,
        entryPoint: null,
        blockers: ['Missing package.json'],
        blockerDetails: [{
          code: 'missing-package-json',
          severity: 'error',
          title: 'No package.json found',
          description: 'DevHub could not find package metadata for this repo.',
          recommendation: 'Add a package.json or run it manually in the sandbox.',
        }],
      },
    }));

    await request(app)
      .post('/api/repos/repo-risky/run')
      .send({ portalUrl: 'https://preview.example.test' })
      .expect(409);
    await request(app)
      .post('/api/repos/repo-risky/run')
      .send({ portalUrl: 'https://preview.example.test', sandboxConfirmed: true })
      .expect(200);
    await request(app)
      .post('/api/repos/repo-blocked/run')
      .send({ portalUrl: 'https://manual.example.test' })
      .expect(409);
    const manual = await request(app)
      .post('/api/repos/repo-blocked/run')
      .send({ portalUrl: 'https://manual.example.test', manualOverride: true })
      .expect(200);

    expect(manual.body).toMatchObject({ status: 'running', portalUrl: 'https://manual.example.test' });
  });

  it('records runtime security events and returns combined security state', async () => {
    await setDoc('repos', 'repo-1', repo({
      analysis: {
        techStack: { language: 'TypeScript', framework: null, runtime: 'Node.js', buildTool: null, testingFramework: null, database: null, otherTools: [] },
        overview: { oneLiner: 'Demo', summary: 'Demo', purpose: 'Demo', targetUsers: 'Developers' },
        functions: [],
        dependencies: {},
        security: securityScan({ riskLevel: 'medium', summary: 'Static scan found script risk.' }),
      },
    }));

    const created = await request(app)
      .post('/api/repos/repo-1/security-events')
      .send({
        source: 'browserpod',
        phase: 'install',
        category: 'resource',
        severity: 'high',
        title: 'Install timed out',
        description: 'npm install did not finish within 60 seconds.',
        evidence: 'npm install exceeded 60000ms',
        command: 'npm install --ignore-scripts',
      })
      .expect(201);

    expect(created.body).toMatchObject({
      success: true,
      event: {
        repoId: 'repo-1',
        source: 'browserpod',
        phase: 'install',
        category: 'resource',
        severity: 'high',
        title: 'Install timed out',
        command: 'npm install --ignore-scripts',
      },
      runtimeSecurity: {
        riskLevel: 'high',
        eventCount: 1,
      },
    });
    expect(await getDoc('repos', 'repo-1')).toMatchObject({
      runtimeSecurity: { riskLevel: 'high', eventCount: 1 },
    });

    const security = await request(app).get('/api/repos/repo-1/security').expect(200);

    expect(security.body.staticSecurity).toMatchObject({ riskLevel: 'medium' });
    expect(security.body.runnability).toBeNull();
    expect(security.body.runtimeSecurity).toMatchObject({
      riskLevel: 'high',
      eventCount: 1,
      events: [expect.objectContaining({ title: 'Install timed out', evidence: 'npm install exceeded 60000ms' })],
    });
  });

  it('validates runtime security event requests', async () => {
    await request(app)
      .post('/api/repos/missing/security-events')
      .send({ severity: 'high', title: 'Install timed out', description: 'timeout' })
      .expect(404);

    await setDoc('repos', 'repo-1', repo());

    await request(app)
      .post('/api/repos/repo-1/security-events')
      .send({ severity: 'bad', title: 'Install timed out', description: 'timeout' })
      .expect(400);
    await request(app)
      .post('/api/repos/repo-1/security-events')
      .send({ severity: 'high', title: '', description: 'timeout' })
      .expect(400);
    await request(app).get('/api/repos/missing/security').expect(404);
  });

  it('starts extraction, caches files, dedupes active work, and returns extraction state', async () => {
    await setDoc('repos', 'repo-1', repo({ status: 'ready' }));

    const response = await request(app)
      .post('/api/ai/extract/repo-1')
      .send({
        fileTree: {
          name: 'root',
          path: '',
          type: 'directory',
          children: [{ name: 'index.ts', path: 'src/index.ts', type: 'file', extension: '.ts', size: 42, supported: true }],
        },
        files: [{ path: '/src/index.ts', content: 'export function hello() {}' }],
      })
      .expect(202);

    expect(response.body).toMatchObject({ success: true, extractionId: 'repo-1', status: 'analyzing' });
    expect(await getDoc('repo_files', repoFileDocId('repo-1', 'src/index.ts'))).toMatchObject({
      path: 'src/index.ts',
      content: 'export function hello() {}',
    });

    const updatedRepo = await getDoc('repos', 'repo-1');
    expect(updatedRepo).toMatchObject({ status: 'analyzing', aiReadmeStatus: 'pending' });
    expect(updatedRepo?.fileTree).toMatchObject({ children: [{ path: 'src/index.ts', supported: true }] });

    const deduped = await request(app)
      .post('/api/ai/extract/repo-1')
      .send({ files: [{ path: 'src/index.ts', content: 'export function hello() {}' }] })
      .expect(202);
    expect(deduped.body.deduped).toBe(true);

    const extraction = await request(app).get('/api/ai/extract/repo-1').expect(200);
    expect(extraction.body).toMatchObject({ success: true, extractionId: 'repo-1', status: 'analyzing', aiReadmeStatus: 'pending' });
  });

  it('returns runtime profile fields with completed extraction state', async () => {
    await setDoc('repos', 'repo-1', repo({
      status: 'ready',
      runnability: {
        canRun: true,
        entryPoint: 'dev',
        autoCommand: 'npm run dev',
        manualCommands: [{ command: 'npm test', label: 'Run tests', reason: 'Validate without a preview.', confidence: 'high' }],
        runtimeProfile: {
          projectKind: 'preview-app',
          supportLevel: 'auto-preview',
          previewExpected: true,
          autoCommand: 'npm run dev',
          manualCommands: [{ command: 'npm test', label: 'Run tests', reason: 'Validate without a preview.', confidence: 'high' }],
          evidence: ['frontend framework or file indicators'],
          reasoning: 'Frontend app indicators and a preview script were found.',
        },
        blockers: [],
      },
      analysis: {
        techStack: { language: 'TypeScript', framework: 'React', runtime: 'Node.js', buildTool: 'Vite', testingFramework: 'Vitest', database: null, otherTools: [] },
        overview: { oneLiner: 'Demo', summary: 'Demo', purpose: 'Demo', targetUsers: 'Developers' },
        functions: [],
        dependencies: { vite: '^7.2.4' },
        security: securityScan(),
      },
      aiReadme: '# Demo',
    }));

    const extraction = await request(app).get('/api/ai/extract/repo-1').expect(200);

    expect(extraction.body.runnability).toMatchObject({
      canRun: true,
      entryPoint: 'dev',
      autoCommand: 'npm run dev',
      manualCommands: [expect.objectContaining({ command: 'npm test' })],
      runtimeProfile: {
        projectKind: 'preview-app',
        supportLevel: 'auto-preview',
        previewExpected: true,
        autoCommand: 'npm run dev',
      },
    });
  });

  it('validates extraction requests and missing repos', async () => {
    await request(app)
      .post('/api/ai/extract/missing')
      .send({ files: [{ path: 'src/index.ts', content: 'export {}' }] })
      .expect(404);

    await setDoc('repos', 'repo-1', repo());

    await request(app).post('/api/ai/extract/repo-1').send({ files: [] }).expect(400);
    await request(app).post('/api/ai/extract/repo-1').send({ files: [{ path: '', content: 'x' }] }).expect(400);
  });

  it('marks repos as error when background extraction rejects', async () => {
    aiMocks.extractAll.mockRejectedValueOnce(new Error('extract failed'));
    await setDoc('repos', 'repo-error', repo({ repoId: 'repo-error' }));

    await request(app)
      .post('/api/ai/extract/repo-error')
      .send({ files: [{ path: 'src/index.ts', content: 'export function fail() {}' }] })
      .expect(202);
    await new Promise((resolve) => setImmediate(resolve));

    expect(await getDoc('repos', 'repo-error')).toMatchObject({
      status: 'error',
      aiReadmeStatus: 'error',
      analysisError: 'extract failed',
    });
  });

  it('serves cached repo files', async () => {
    await setDoc('repos', 'repo-1', repo());
    await request(app)
      .post('/api/ai/extract/repo-1')
      .send({ files: [{ path: '/src/index.ts', content: 'export function hello() {}' }] })
      .expect(202);

    const file = await request(app).get('/api/repos/repo-1/file').query({ path: 'src/index.ts' }).expect(200);
    expect(file.body).toMatchObject({ path: 'src/index.ts', content: 'export function hello() {}' });

    await request(app).get('/api/repos/repo-1/file').expect(400);
    await request(app).get('/api/repos/repo-1/file').query({ path: 'missing.ts' }).expect(404);
  });

  it('returns cached extraction results when source hash has not changed', async () => {
    await setDoc('repos', 'repo-1', repo({
      analysis: {
        techStack: { language: 'TypeScript', framework: null, runtime: 'Node.js', buildTool: null, testingFramework: null, database: null, otherTools: [] },
        overview: { oneLiner: 'Demo', summary: 'Demo', purpose: 'Demo', targetUsers: 'Developers' },
        functions: [],
        dependencies: {},
        security: {
          riskLevel: 'low',
          summary: 'No obvious suspicious indicators.',
          findings: [],
          dependencyRisks: [],
          scannedFiles: ['README.md'],
          notes: [],
        },
      },
      aiReadme: '# Demo',
      analysisSourceHash: 'existing',
    }));

    const files = [{ path: 'README.md', content: '# Demo' }];
    const first = await request(app).post('/api/ai/extract/repo-1').send({ fileTree: 'README.md', files }).expect(202);
    await new Promise((resolve) => setImmediate(resolve));
    const updatedRepo = await getDoc('repos', 'repo-1');

    await setDoc('repos', 'repo-1', { ...updatedRepo, status: 'ready', aiReadme: '# Demo', analysisSourceHash: updatedRepo?.analysisSourceHash });
    const second = await request(app).post('/api/ai/extract/repo-1').send({ fileTree: 'README.md', files }).expect(200);

    expect(first.body.status).toBe('analyzing');
    expect(second.body.cached).toBe(true);
  });

  it('handles repo chat, cached duplicate replies, and history reads', async () => {
    await setDoc('repos', 'repo-1', repo());

    const first = await request(app).post('/api/chat/repo/repo-1').send({ message: 'Explain this repo' }).expect(200);
    expect(first.body).toEqual({ reply: 'AI reply', degraded: false, conversationId: 'default' });

    const duplicate = await request(app).post('/api/chat/repo/repo-1').send({ message: 'Explain this repo' }).expect(200);
    expect(duplicate.body).toEqual({ reply: 'AI reply', degraded: false, cached: true, conversationId: 'default' });

    const history = await request(app).get('/api/chat/repo/repo-1').expect(200);
    expect(history.body.messages.map((message: any) => message.role)).toEqual(['user', 'assistant']);
  });

  it('keeps repo chat conversations separate and clears one conversation', async () => {
    await setDoc('repos', 'repo-1', repo());

    await request(app).post('/api/chat/repo/repo-1').send({ message: 'Default chat' }).expect(200);
    await request(app)
      .post('/api/chat/repo/repo-1')
      .send({ message: 'Second thread', conversationId: 'thread-2' })
      .expect(200);

    const conversations = await request(app).get('/api/chat/repo/repo-1/conversations').expect(200);
    expect(conversations.body.conversations).toEqual([
      expect.objectContaining({ conversationId: 'thread-2', title: 'Second thread', messageCount: 2 }),
      expect.objectContaining({ conversationId: 'default', title: 'Default chat', messageCount: 2 }),
    ]);

    const secondHistory = await request(app).get('/api/chat/repo/repo-1').query({ conversationId: 'thread-2' }).expect(200);
    expect(secondHistory.body.messages.map((message: any) => message.content)).toEqual(['Second thread', 'AI reply']);

    const cleared = await request(app).delete('/api/chat/repo/repo-1').query({ conversationId: 'thread-2' }).expect(200);
    expect(cleared.body).toEqual({ success: true, conversationId: 'thread-2', deletedCount: 2 });

    const afterClear = await request(app).get('/api/chat/repo/repo-1').query({ conversationId: 'thread-2' }).expect(200);
    expect(afterClear.body.messages).toEqual([]);

    const defaultHistory = await request(app).get('/api/chat/repo/repo-1').expect(200);
    expect(defaultHistory.body.messages.map((message: any) => message.content)).toEqual(['Default chat', 'AI reply']);
  });

  it('validates chat requests and missing chat scopes', async () => {
    await request(app).post('/api/chat/repo/missing').send({ message: 'Hi' }).expect(404);
    await setDoc('repos', 'repo-1', repo());
    await request(app).post('/api/chat/repo/repo-1').send({ message: '' }).expect(400);

    await request(app).post('/api/chat/workspace/missing').send({ message: 'Hi' }).expect(404);
    await setDoc('workspaces', 'workspace-1', workspace());
    await request(app).post('/api/chat/workspace/workspace-1').send({ message: '' }).expect(400);
  });

  it('degrades chat when OpenRouter fails', async () => {
    await setDoc('repos', 'repo-1', repo({ analysis: null }));
    aiMocks.callOpenRouterStructured.mockRejectedValueOnce(new Error('model unavailable'));

    const response = await request(app).post('/api/chat/repo/repo-1').send({ message: 'Help' }).expect(200);

    expect(response.body.degraded).toBe(true);
    expect(response.body.reply).toContain('temporarily unavailable');
  });

  it('handles workspace chat and history reads', async () => {
    await setDoc('workspaces', 'workspace-1', workspace());
    await setDoc('repos', 'repo-1', repo());

    const response = await request(app).post('/api/chat/workspace/workspace-1').send({ message: 'Summarize' }).expect(200);
    expect(response.body).toEqual({ reply: 'AI reply', degraded: false, conversationId: 'default' });

    const history = await request(app).get('/api/chat/workspace/workspace-1').expect(200);
    expect(history.body.messages).toHaveLength(2);
  });
});
