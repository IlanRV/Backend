import type { SecurityDependencyRisk } from '../types';

export interface SecurityIntelFile {
  path: string;
  content: string;
}

export interface ExternalServiceHint {
  service: string;
  evidence: string;
  recommendation: string;
  confidence: 'high' | 'medium' | 'low';
}

export function detectKnownDependencyRisks(_files: SecurityIntelFile[]): SecurityDependencyRisk[] {
  return [];
}

export function detectExternalServiceHints(
  _files: SecurityIntelFile[],
  _dependencies: Record<string, string>,
  _devDependencies: Record<string, string>
): ExternalServiceHint[] {
  return [];
}
