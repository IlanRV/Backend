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

const knownVulnerableVersions: Record<string, Record<string, Omit<SecurityDependencyRisk, 'packageName' | 'version'>>> = {
  marked: {
    '0.3.5': {
      severity: 'high',
      risk: 'Known vulnerable package version',
      reason: 'marked 0.3.5 is an old release used in vulnerable demos and is associated with XSS-prone markdown rendering paths.',
      recommendation: 'Upgrade marked to a current patched release and sanitize rendered HTML before display.',
      confidence: 'high',
    },
  },
  st: {
    '0.2.4': {
      severity: 'high',
      risk: 'Known vulnerable package version',
      reason: 'st 0.2.4 is associated with directory traversal vulnerabilities in static file serving.',
      recommendation: 'Replace st or upgrade to a patched static-file server implementation.',
      confidence: 'high',
    },
  },
  ms: {
    '0.7.1': {
      severity: 'medium',
      risk: 'Known vulnerable package version',
      reason: 'ms 0.7.1 is an old release associated with regular expression denial-of-service risk.',
      recommendation: 'Upgrade ms through direct or transitive dependency updates.',
      confidence: 'medium',
    },
  },
  mongoose: {
    '4.2.4': {
      severity: 'high',
      risk: 'Known vulnerable package version',
      reason: 'mongoose 4.2.4 is an old dependency used by nodejs-goof and has known security issues in historical advisory data.',
      recommendation: 'Upgrade Mongoose and retest query handling, authentication, and MongoDB compatibility.',
      confidence: 'high',
    },
  },
  lodash: {
    '4.17.15': {
      severity: 'high',
      risk: 'Known vulnerable package version',
      reason: 'lodash 4.17.15 is affected by known prototype pollution vulnerabilities.',
      recommendation: 'Upgrade lodash to a patched version and regenerate the lockfile.',
      confidence: 'high',
    },
    '4.17.10': {
      severity: 'high',
      risk: 'Known vulnerable package version',
      reason: 'lodash 4.17.10 is affected by known prototype pollution vulnerabilities.',
      recommendation: 'Upgrade lodash to a patched version and regenerate the lockfile.',
      confidence: 'high',
    },
    '4.17.4': {
      severity: 'high',
      risk: 'Known vulnerable package version',
      reason: 'lodash 4.17.4 is affected by known prototype pollution vulnerabilities.',
      recommendation: 'Upgrade lodash to a patched version and regenerate the lockfile.',
      confidence: 'high',
    },
  },
  handlebars: {
    '4.0.14': {
      severity: 'high',
      risk: 'Known vulnerable package version',
      reason: 'handlebars 4.0.14 is affected by known template/prototype pollution security advisories.',
      recommendation: 'Upgrade handlebars and review template inputs before rendering.',
      confidence: 'high',
    },
    '4.0.11': {
      severity: 'high',
      risk: 'Known vulnerable package version',
      reason: 'handlebars 4.0.11 is affected by known template/prototype pollution security advisories.',
      recommendation: 'Upgrade handlebars and review template inputs before rendering.',
      confidence: 'high',
    },
  },
  moment: {
    '2.15.1': {
      severity: 'medium',
      risk: 'Known vulnerable package version',
      reason: 'moment 2.15.1 is an old release present in nodejs-goof vulnerability demonstrations.',
      recommendation: 'Upgrade moment or replace it with a maintained date library.',
      confidence: 'medium',
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

function lockfilePackageName(path: string): string | null {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);

  if (index === -1) {
    return null;
  }

  return path.slice(index + marker.length);
}

function knownVersionRisk(packageName: string, version: string): SecurityDependencyRisk | null {
  const risk = knownVulnerableVersions[packageName]?.[version];

  if (!risk) {
    return null;
  }

  return { packageName, version, ...risk };
}

function detectPackageLockRisks(file: SecurityIntelFile): SecurityDependencyRisk[] {
  const parsed = parseJsonObject(file.content);
  const risks: SecurityDependencyRisk[] = [];

  if (isRecord(parsed.packages)) {
    for (const [path, value] of Object.entries(parsed.packages)) {
      if (!isRecord(value) || typeof value.version !== 'string') {
        continue;
      }

      const packageName = lockfilePackageName(path);
      const risk = packageName ? knownVersionRisk(packageName, value.version) : null;

      if (risk) {
        risks.push(risk);
      }
    }
  }

  if (isRecord(parsed.dependencies)) {
    for (const [packageName, value] of Object.entries(parsed.dependencies)) {
      if (!isRecord(value) || typeof value.version !== 'string') {
        continue;
      }

      const risk = knownVersionRisk(packageName, value.version);

      if (risk) {
        risks.push(risk);
      }
    }
  }

  return risks;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectTextLockRisks(file: SecurityIntelFile): SecurityDependencyRisk[] {
  const risks: SecurityDependencyRisk[] = [];

  for (const [packageName, versions] of Object.entries(knownVulnerableVersions)) {
    for (const version of Object.keys(versions)) {
      const escapedName = escapeRegex(packageName);
      const escapedVersion = escapeRegex(version);
      const pattern = new RegExp(`${escapedName}[^\n]{0,100}(?:version\\s+["']${escapedVersion}["']|@${escapedVersion}|version:\\s*${escapedVersion})`, 'i');
      const risk = pattern.test(file.content) ? knownVersionRisk(packageName, version) : null;

      if (risk) {
        risks.push(risk);
      }
    }
  }

  return risks;
}

function dedupeRisks(risks: SecurityDependencyRisk[]): SecurityDependencyRisk[] {
  const unique = new Map<string, SecurityDependencyRisk>();

  for (const risk of risks) {
    unique.set(`${risk.packageName}:${risk.version}:${risk.risk}`, risk);
  }

  return [...unique.values()];
}

export function detectKnownDependencyRisks(files: SecurityIntelFile[]): SecurityDependencyRisk[] {
  return dedupeRisks(files.flatMap((file) => {
    const name = basename(file.path).toLowerCase();

    if (name === 'package-lock.json') {
      return detectPackageLockRisks(file);
    }

    if (name === 'yarn.lock' || name === 'pnpm-lock.yaml') {
      return detectTextLockRisks(file);
    }

    return [];
  }));
}

export function detectExternalServiceHints(
  files: SecurityIntelFile[],
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>
): ExternalServiceHint[] {
  const allDependencies = { ...dependencies, ...devDependencies };
  const dependencyNames = Object.keys(allDependencies);
  const content = files.map((file) => `${file.path}\n${file.content}`).join('\n').toLowerCase();
  const hints: ExternalServiceHint[] = [];

  if (
    dependencyNames.some((dependency) => dependency === 'mongoose' || dependency === 'mongodb') ||
    /\bmongod\b|mongodb:\/\/|mongolab_uri|image:\s*mongo/.test(content)
  ) {
    const evidence = [
      dependencyNames.includes('mongoose') ? 'mongoose dependency' : '',
      dependencyNames.includes('mongodb') ? 'mongodb dependency' : '',
      /\bmongod\b/.test(content) ? 'README or scripts mention mongod' : '',
      /mongodb:\/\//.test(content) ? 'MongoDB connection URI found' : '',
      /image:\s*mongo/.test(content) ? 'docker-compose references mongo image' : '',
    ].filter(Boolean).join('; ');

    hints.push({
      service: 'MongoDB',
      evidence,
      recommendation: 'Start a compatible MongoDB service separately, or keep this repository manual-only in BrowserPod because DevHub does not launch MongoDB automatically.',
      confidence: evidence.includes('mongoose') || evidence.includes('MongoDB connection') ? 'high' : 'medium',
    });
  }

  return hints;
}
