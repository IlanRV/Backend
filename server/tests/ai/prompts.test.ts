import { describe, expect, it } from 'vitest';
import { buildAiReadmePrompt } from '../../src/ai/prompts/aiReadme';
import { buildRepoChatSystemPrompt, buildWorkspaceChatSystemPrompt } from '../../src/ai/prompts/chatContext';
import { buildFunctionPromptChunks, buildFunctionsPrompt } from '../../src/ai/prompts/functions';
import { buildOverviewPrompt } from '../../src/ai/prompts/overview';
import { buildTechStackPrompt } from '../../src/ai/prompts/techStack';
import type { ExtractionResult, FunctionDoc, Repo, RunnabilityResult, Workspace } from '../../src/types';

const functionDoc: FunctionDoc = {
  name: 'hello',
  type: 'function',
  file: 'src/index.ts',
  line: 1,
  signature: 'function hello(name: string): string',
  description: 'Greets a user.',
  params: [{ name: 'name', type: 'string', description: 'User name' }],
  returns: { type: 'string', description: 'Greeting' },
  throws: [],
  dependencies: [],
};

const analysis: ExtractionResult = {
  techStack: {
    language: 'TypeScript',
    framework: 'Express',
    runtime: 'Node.js',
    buildTool: 'TypeScript compiler',
    testingFramework: 'Vitest',
    database: 'Firebase',
    otherTools: ['ESLint'],
  },
  overview: {
    oneLiner: 'A backend API.',
    summary: 'A backend API for testing.',
    purpose: 'Serve data to a frontend.',
    targetUsers: 'Developers',
  },
  functions: [functionDoc],
  dependencies: { express: '^4.22.1' },
  security: {
    riskLevel: 'low',
    summary: 'No obvious suspicious indicators.',
    findings: [],
    dependencyRisks: [],
    scannedFiles: ['package.json', 'src/index.ts'],
    notes: [],
  },
};

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'repo-1',
    workspaceId: 'workspace-1',
    name: 'api',
    githubUrl: 'https://github.com/example/api',
    status: 'ready',
    runnability: { canRun: true, entryPoint: 'dev', blockers: [] },
    analysis,
    aiReadme: '# API\nDetails',
    portalUrl: null,
    createdAt: '2026-05-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('prompt builders', () => {
  it('builds a tech stack prompt with evidence and a strict schema', () => {
    const prompt = buildTechStackPrompt(
      'package.json\nsrc/index.ts',
      '{"dependencies":{"express":"^4.22.1"}}',
      [{ path: 'tsconfig.json', content: '{"compilerOptions":{}}' }]
    );

    expect(prompt.system).toContain('valid JSON only');
    expect(prompt.user).toContain('src/index.ts');
    expect(prompt.user).toContain('tsconfig.json');
    expect(prompt.schema).toMatchObject({ type: 'object', additionalProperties: false });
  });

  it('builds overview prompts from README, package description, and tree', () => {
    const prompt = buildOverviewPrompt('# Demo', { description: 'Demo API' }, 'src/index.ts');

    expect(prompt.user).toContain('# Demo');
    expect(prompt.user).toContain('Demo API');
    expect(prompt.schema).toMatchObject({ type: 'object' });
  });

  it('chunks high-value source files and ignores generated folders', () => {
    const chunks = buildFunctionPromptChunks([
      { path: 'node_modules/pkg/index.ts', content: 'export function ignored() {}' },
      { path: 'src/routes/users.ts', content: 'router.get("/users", handler); export function listUsers() {}' },
      { path: 'src/lib/math.ts', content: 'export function add(a: number, b: number) { return a + b; }' },
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].includedFiles).toContain('src/routes/users.ts');
    expect(chunks[0].includedFiles).toContain('src/lib/math.ts');
    expect(chunks[0].includedFiles).not.toContain('node_modules/pkg/index.ts');
  });

  it('returns an empty functions prompt when there is no supported source', () => {
    const prompt = buildFunctionsPrompt([{ path: 'README.md', content: '# Demo' }]);

    expect(prompt.user).toContain('No source files provided.');
    expect(prompt.schema).toMatchObject({ type: 'array' });
  });

  it('builds README prompts with runnability and dependency context', () => {
    const runnability: RunnabilityResult = {
      canRun: true,
      entryPoint: 'dev',
      autoCommand: 'npm run dev',
      manualCommands: [{ command: 'npm test', label: 'Run tests', reason: 'Validate without a preview.', confidence: 'high' }],
      runtimeProfile: {
        projectKind: 'api-server',
        supportLevel: 'auto-preview',
        previewExpected: true,
        autoCommand: 'npm run dev',
        manualCommands: [{ command: 'npm test', label: 'Run tests', reason: 'Validate without a preview.', confidence: 'high' }],
        evidence: ['HTTP server or route indicators'],
        reasoning: 'Server framework indicators and a startable script were found.',
      },
      blockers: [],
    };
    const prompt = buildAiReadmePrompt(
      analysis.techStack,
      analysis.overview,
      analysis.functions,
      analysis.dependencies,
      'api',
      runnability,
      analysis.security,
      'package.json\nsrc/index.ts',
      '# API'
    );

    expect(prompt.user).toContain('RUNNABILITY:');
    expect(prompt.user).toContain('SECURITY SCAN:');
    expect(prompt.user).toContain('Entry point: dev');
    expect(prompt.user).toContain('Auto command: npm run dev');
    expect(prompt.user).toContain('Project kind: api-server');
    expect(prompt.user).toContain('Manual commands:');
    expect(prompt.user).toContain('express');
    expect(prompt.schema).toMatchObject({ type: 'object' });
  });

  it('builds repo chat prompts with truncated history and analysis context', () => {
    const prompt = buildRepoChatSystemPrompt(repo(), [
      { messageId: 'm1', scopeType: 'repo', scopeId: 'repo-1', role: 'user', content: 'x'.repeat(1300), timestamp: '1' },
    ]);

    expect(prompt).toContain('Repository: api');
    expect(prompt).toContain('hello (function)');
    expect(prompt).toContain('USER:');
    expect(prompt.length).toBeLessThan(12000);
  });

  it('builds workspace chat prompts with each repo context', () => {
    const workspace: Workspace = {
      workspaceId: 'workspace-1',
      name: 'Hackathon',
      description: 'Backend workspace',
      createdAt: '2026-05-02T00:00:00.000Z',
    };

    const prompt = buildWorkspaceChatSystemPrompt(workspace, [repo()], []);

    expect(prompt).toContain('Workspace: Hackathon');
    expect(prompt).toContain('Repository contexts:');
    expect(prompt).toContain('Repository: api');
  });
});
