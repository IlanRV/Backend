export interface Workspace {
  workspaceId: string;
  name: string;
  description: string;
  createdAt: string;
  repoCount?: number;
}

export interface Repo {
  repoId: string;
  workspaceId: string;
  name: string;
  githubUrl: string;
  status: 'cloning' | 'analyzing' | 'ready' | 'running' | 'error';
  runnability: RunnabilityResult | null;
  analysis: ExtractionResult | null;
  analysisSourceHash?: string;
  analysisStartedAt?: string;
  analysisUpdatedAt?: string;
  analysisModel?: string | null;
  aiReadme: string | null;
  portalUrl: string | null;
  createdAt: string;
}

export interface RunnabilityResult {
  canRun: boolean;
  entryPoint: string | null;
  blockers: string[];
}

export interface ExtractionResult {
  techStack: TechStack;
  overview: Overview;
  functions: FunctionDoc[];
  dependencies: Record<string, string>;
}

export interface TechStack {
  language: string;
  framework: string | null;
  runtime: string;
  buildTool: string | null;
  testingFramework: string | null;
  database: string | null;
  otherTools: string[];
}

export interface Overview {
  oneLiner: string;
  summary: string;
  purpose: string;
  targetUsers: string;
}

export interface FunctionDoc {
  name: string;
  type: 'function' | 'class' | 'method';
  file: string;
  line: number;
  signature: string;
  description: string;
  params: { name: string; type: string; description: string }[];
  returns: { type: string; description: string };
  throws: string[];
  dependencies: string[];
}

export interface ChatMessage {
  messageId: string;
  scopeType: 'repo' | 'workspace';
  scopeId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}