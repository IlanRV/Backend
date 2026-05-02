import { afterEach, describe, expect, it, vi } from 'vitest';

function fakeFirestore() {
  const data = new Map<string, Map<string, any>>();
  const collectionMap = (name: string) => {
    let collection = data.get(name);
    if (!collection) {
      collection = new Map<string, any>();
      data.set(name, collection);
    }
    return collection;
  };

  return {
    data,
    collection: vi.fn((name: string) => ({
      doc: (id: string) => ({
        id,
        async get() {
          const value = collectionMap(name).get(id);
          return { id, exists: Boolean(value), data: () => value };
        },
        async set(value: any, options?: { merge?: boolean }) {
          const existing = collectionMap(name).get(id) || {};
          collectionMap(name).set(id, options?.merge ? { ...existing, ...value } : value);
        },
        async delete() {
          collectionMap(name).delete(id);
        },
      }),
      where: (field: string, _operator: string, value: unknown) => ({
        async get() {
          const docs = [...collectionMap(name).entries()]
            .filter(([, entry]) => entry[field] === value)
            .map(([id, entry]) => ({ id, ref: { name, id }, data: () => entry }));
          return { docs, size: docs.length };
        },
      }),
    })),
    batch: vi.fn(() => ({ delete: vi.fn(), commit: vi.fn() })),
  };
}

async function loadFirebase(config: object, firestore = fakeFirestore()) {
  vi.resetModules();
  const admin = {
    apps: [] as object[],
    credential: { cert: vi.fn((value) => value) },
    initializeApp: vi.fn(() => admin.apps.push({ initialized: true })),
    firestore: vi.fn(() => firestore),
  };
  vi.doMock('firebase-admin', () => admin);
  vi.doMock('../../src/config', () => ({ config }));
  vi.doMock('../../src/lib/logger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }));
  const module = await import('../../src/lib/firebase');
  return { module, admin, firestore };
}

describe('firebase helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('firebase-admin');
    vi.doUnmock('../../src/config');
    vi.doUnmock('../../src/lib/logger');
  });

  it('throws when Firebase credentials are missing', async () => {
    const { module } = await loadFirebase({ firebase: { projectId: '', privateKey: '', clientEmail: '' } });

    expect(() => module.getDb()).toThrow('Firebase credentials are not configured');
  });

  it('initializes Firebase once and maps document IDs onto returned docs', async () => {
    const { module, admin, firestore } = await loadFirebase({
      firebase: { projectId: 'project', privateKey: 'private', clientEmail: 'client@example.com' },
    });

    await module.setDoc('repos', 'repo-1', { name: 'demo' });
    await module.setDoc('repos', 'repo-1', { status: 'ready' }, { merge: true });

    const repo = await module.getDoc('repos', 'repo-1');

    expect(admin.initializeApp).toHaveBeenCalledTimes(1);
    expect(firestore.collection).toHaveBeenCalledWith('repos');
    expect(repo).toMatchObject({ id: 'repo-1', repoId: 'repo-1', name: 'demo', status: 'ready' });
  });

  it('returns null for missing docs and maps query docs', async () => {
    const { module } = await loadFirebase({
      firebase: { projectId: 'project', privateKey: 'private', clientEmail: 'client@example.com' },
    });

    await module.setDoc('workspaces', 'workspace-1', { workspaceId: 'workspace-1', name: 'one' });
    await module.setDoc('workspaces', 'workspace-2', { workspaceId: 'workspace-2', name: 'two' });

    expect(await module.getDoc('repos', 'missing')).toBeNull();
    await expect(module.queryDocs('workspaces', 'name', '==', 'two')).resolves.toEqual([
      expect.objectContaining({ id: 'workspace-2', workspaceId: 'workspace-2', name: 'two' }),
    ]);
  });
});
