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
  fileTree?: FileTreeNode | null;
  analysis: ExtractionResult | null;
  analysisSourceHash?: string;
  analysisStartedAt?: string;
  analysisUpdatedAt?: string;
  analysisModel?: string | null;
  analysisError?: string | null;
  analysisProgress?: AnalysisProgress | null;
  aiReadme: string | null;
  aiReadmeStatus?: 'pending' | 'ready' | 'error' | null;
  runnable?: boolean;
  runScript?: string | null;
  portalUrl: string | null;
  createdAt: string;
  updatedAt?: string;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
  extension?: string;
  size?: number;
  supported?: boolean;
}

export interface RepoFile {
  repoFileId: string;
  repoId: string;
  path: string;
  content: string;
  size: number;
  sourceHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunnabilityResult {
  canRun: boolean;
  entryPoint: string | null;
  blockers: string[];
  blockerDetails?: RunnabilityBlocker[];
  previewPath?: string;
  previewPaths?: string[];
}

export type RunnabilityBlockerCode =
  | 'missing-package-json'
  | 'missing-run-script'
  | 'unsupported-native-dependency';

export type RunnabilityBlockerSeverity = 'info' | 'warning' | 'error';

export interface RunnabilityBlocker {
  code: RunnabilityBlockerCode;
  severity: RunnabilityBlockerSeverity;
  title: string;
  description: string;
  recommendation: string;
  evidence?: string;
}

export type AnalysisProgressPhase = 'queued' | 'scanning' | 'querying' | 'saving' | 'readme' | 'complete' | 'error';

export interface AnalysisProgress {
  phase: AnalysisProgressPhase;
  percent: number;
  message: string;
  updatedAt: string;
}

export interface ExtractionResult {
  techStack: TechStack;
  overview: Overview;
  functions: FunctionDoc[];
  dependencies: Record<string, string>;
  security: SecurityScan;
}

export type SecuritySeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type SecurityConfidence = 'high' | 'medium' | 'low';
export type SecurityCategory =
  | 'dependency'
  | 'script'
  | 'secret'
  | 'network'
  | 'execution'
  | 'obfuscation'
  | 'supply-chain'
  | 'malware'
  | 'config'
  | 'other';

export interface SecurityFinding {
  title: string;
  severity: SecuritySeverity;
  category: SecurityCategory;
  file: string;
  line: number | null;
  evidence: string;
  impact: string;
  recommendation: string;
  confidence: SecurityConfidence;
}

export interface SecurityDependencyRisk {
  packageName: string;
  version: string | null;
  severity: SecuritySeverity;
  risk: string;
  reason: string;
  recommendation: string;
  confidence: SecurityConfidence;
}

export interface SecurityScan {
  riskLevel: SecuritySeverity | 'unknown';
  summary: string;
  findings: SecurityFinding[];
  dependencyRisks: SecurityDependencyRisk[];
  scannedFiles: string[];
  notes: string[];
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
