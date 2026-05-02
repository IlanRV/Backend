import { beforeEach, describe, expect, it, vi } from 'vitest';

const firebaseMocks = vi.hoisted(() => ({
  getDoc: vi.fn(),
  setDoc: vi.fn(),
}));

vi.mock('../../src/lib/firebase', () => firebaseMocks);
vi.mock('../../src/config', () => ({
  config: {
    openrouter: {
      apiKey: '',
      model: 'deepseek/deepseek-v4-flash',
      fallbackModels: [],
      maxTokens: 4096,
      retryCount: 0,
      timeoutMs: 1000,
      strictJsonSchema: true,
      appName: 'DevHub',
      siteUrl: '',
    },
  },
}));
vi.mock('../../src/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { extractAll } from '../../src/ai/extraction';

describe('extractAll fallback path', () => {
  beforeEach(() => {
    firebaseMocks.getDoc.mockReset();
    firebaseMocks.setDoc.mockReset();
    firebaseMocks.getDoc.mockResolvedValue({ repoId: 'repo-1' });
  });

  it('builds fallback analysis, runnability, README, and persists final results', async () => {
    const result = await extractAll(
      'repo-1',
      'demo-api',
      'package.json\nsrc/index.ts\nREADME.md',
      [
        {
          path: 'package.json',
          content: JSON.stringify({
            name: 'demo-api',
            description: 'Small Express API',
            scripts: { dev: 'tsx src/index.ts' },
            dependencies: { express: '^4.22.1' },
            devDependencies: { typescript: '^5.9.3', vitest: '^4.1.5' },
          }),
        },
        {
          path: 'src/index.ts',
          content: [
            'import express from "express";',
            'const app = express();',
            'app.get("/api/health", (_req, res) => res.json({ ok: true }));',
            'export function hello(name: string) { return `Hello ${name}`; }',
            'export class Greeter {}',
          ].join('\n'),
        },
        { path: 'README.md', content: '# Demo API\n\nBackend demo.' },
      ],
      { sourceHash: 'source-hash' }
    );

    expect(result.analysis.techStack).toMatchObject({
      language: 'TypeScript',
      framework: 'Express',
      runtime: 'Node.js',
      testingFramework: 'Vitest',
    });
    expect(result.runnability).toMatchObject({ canRun: true, entryPoint: 'dev', previewPath: '/api/health' });
    expect(result.analysis.functions.map((item) => item.name)).toEqual(['hello', 'Greeter']);
    expect(result.aiReadme).toContain('# Demo API');
    expect(firebaseMocks.setDoc).toHaveBeenLastCalledWith(
      'repos',
      'repo-1',
      expect.objectContaining({
        status: 'ready',
        aiReadmeStatus: 'ready',
        runnable: true,
        runScript: 'dev',
        analysisSourceHash: 'source-hash',
      }),
      { merge: true }
    );
  });

  it('marks projects without package scripts as not runnable', async () => {
    const result = await extractAll('repo-1', 'docs-only', 'README.md', [
      { path: 'README.md', content: '# Docs Only' },
    ]);

    expect(result.runnability.canRun).toBe(false);
    expect(result.runnability.blockers).toContain('No readable package.json found at repo root');
    expect(result.runnability.blockers).toContain('No runnable npm script found: expected "dev", "start", or "serve"');
  });

  it('does not write analysis when the repo disappears before saving', async () => {
    firebaseMocks.getDoc.mockResolvedValue(null);

    await extractAll('repo-1', 'deleted', 'README.md', [{ path: 'README.md', content: '# Deleted' }]);

    expect(firebaseMocks.setDoc).not.toHaveBeenCalled();
  });
});
