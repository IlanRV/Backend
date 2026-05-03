import { createLogger } from '../../lib/logger';

export interface PromptResult {
  system: string;
  user: string;
  schema: object;
}

export interface SecurityPromptChunk extends PromptResult {
  chunkIndex: number;
  totalChunks: number;
  includedFiles: string[];
  omittedCount: number;
}

interface SourceFile {
  path: string;
  content: string;
}

const logger = createLogger('prompt-security');
const ignoredPathFragments = ['/node_modules/', '/dist/', '/build/', '/coverage/', '/.git/'];
const maxRankedFiles = 44;
const maxFilesPerChunk = 11;
const maxChunks = 4;
const maxCharsPerFile = 5200;

function normalizedPath(path: string): string {
  return `/${path.replace(/^\/+/, '').toLowerCase()}`;
}

function extensionOf(path: string): string {
  return path.split('.').pop()?.toLowerCase() || '';
}

function isCandidateFile(path: string): boolean {
  const normalized = normalizedPath(path);

  if (ignoredPathFragments.some((fragment) => normalized.includes(fragment))) {
    return false;
  }

  return [
    'js',
    'ts',
    'jsx',
    'tsx',
    'mjs',
    'cjs',
    'py',
    'json',
    'yml',
    'yaml',
    'env',
    'sh',
    'bash',
    'lock',
    'txt',
  ].includes(extensionOf(path));
}

function scoreSecurityFile(file: SourceFile): number {
  const path = normalizedPath(file.path);
  const content = file.content;
  let score = 0;

  if (/package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|pyproject\.toml|poetry\.lock/.test(path)) score += 35;
  if (/\.github\/workflows|dockerfile|docker-compose|\.env|\.npmrc|\.yarnrc|\.pypirc/.test(path)) score += 24;
  if (/scripts?\//.test(path)) score += 10;
  if (/\b(preinstall|install|postinstall|prepare)\b/.test(content)) score += 24;
  if (/\b(eval|Function\s*\(|exec\s*\(|spawn\s*\(|execSync\s*\(|child_process|subprocess|os\.system)\b/.test(content)) score += 22;
  if (/\b(curl|wget|Invoke-WebRequest|powershell|bash\s+-c|sh\s+-c|nc\s+-|netcat)\b/i.test(content)) score += 20;
  if (/\b(Buffer\.from|atob|btoa|base64|fromCharCode|decodeURIComponent)\b/.test(content)) score += 12;
  if (/\b(process\.env|SECRET|TOKEN|PRIVATE_KEY|PASSWORD|API_KEY)\b/.test(content)) score += 10;
  if (/\b(fetch|axios|http\.request|https\.request|requests\.|urllib|socket)\b/.test(content)) score += 8;

  return score;
}

function chunkItems<T>(items: T[], size: number, maxChunkCount: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length && chunks.length < maxChunkCount; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function buildPromptForChunk(
  selectedFiles: SourceFile[],
  chunkIndex: number,
  totalChunks: number,
  candidateCount: number,
  omittedCount: number
): SecurityPromptChunk {
  const sourceFiles = selectedFiles
    .map((file) => `=== ${file.path} ===\n${file.content.slice(0, maxCharsPerFile)}`)
    .join('\n\n');

  logger.debug('security_prompt_chunk_built', {
    chunkIndex,
    totalChunks,
    candidateCount,
    includedFileCount: selectedFiles.length,
    omittedCount,
  });

  const system = [
    'You are a cautious security review assistant for DevHub.',
    'Inspect only the visible repository evidence for potentially malicious packages, install scripts, obfuscated payloads, credential leaks, dangerous execution paths, suspicious network exfiltration, and malware-like behavior.',
    'Do not claim a package or project is malicious without visible evidence. Use confidence and cautious wording.',
    'Always respond with valid JSON only. No markdown, code fences, or extra text.',
  ].join(' ');

  const user = `Security-scan this repository chunk for suspicious or malicious indicators.
This is chunk ${chunkIndex + 1} of ${totalChunks}. Candidate files: ${candidateCount}. Included here: ${selectedFiles.length}. Omitted lower-priority files: ${omittedCount}.

Look for:
- Potentially malicious or suspicious dependencies, typosquatting indicators, package names that deserve manual verification, and risky dependency versions only when visible in manifests/locks.
- Lifecycle scripts such as preinstall/install/postinstall/prepare that execute network downloads, shell scripts, node -e payloads, chmod, rm, curl/wget, PowerShell, or opaque commands.
- Code execution paths using eval, Function constructor, child_process, subprocess, os.system, dynamic imports of untrusted input, shell execution, or encoded payload execution.
- Obfuscation indicators such as base64 blobs, hex arrays, fromCharCode chains, minified one-line payloads in source, or dynamic string assembly around execution/network calls.
- Credential exposure, secrets committed to the repo, token exfiltration, suspicious webhooks, reverse shells, persistence, crypto-mining, or self-replicating/infectious behavior.
- Unsafe config that materially increases supply-chain or malware risk.

VISIBLE FILES:
${sourceFiles || 'No files provided.'}

Return this exact JSON object:
{
  "riskLevel": "critical" | "high" | "medium" | "low" | "info" | "unknown",
  "summary": "Concise security overview of this chunk",
  "findings": [
    {
      "title": "Short finding title",
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "dependency" | "script" | "secret" | "network" | "execution" | "obfuscation" | "supply-chain" | "malware" | "config" | "other",
      "file": "path/to/file",
      "line": 1,
      "evidence": "Exact visible evidence or short excerpt",
      "impact": "Why this could matter",
      "recommendation": "Concrete next step",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "dependencyRisks": [
    {
      "packageName": "package-name",
      "version": "version or null",
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "risk": "Short risk label",
      "reason": "Visible evidence behind the risk",
      "recommendation": "Concrete package review/remediation step",
      "confidence": "high" | "medium" | "low"
    }
  ],
  "scannedFiles": ["path/to/file"],
  "notes": ["Any important limitation or manual follow-up"]
}

Rules:
- Prefer fewer high-quality findings over noisy guesses.
- If no suspicious indicators are visible, return riskLevel "low" or "info" and explain that no obvious indicators were found in the scanned files.
- Use line null only when a package-level finding cannot be tied to one line.
- Do not include vulnerabilities that require internet CVE lookup unless directly visible in the source or manifest.
- Do not suggest deleting a package solely because it is unfamiliar; recommend verification when confidence is low.`;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      riskLevel: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info', 'unknown'] },
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
            category: {
              type: 'string',
              enum: ['dependency', 'script', 'secret', 'network', 'execution', 'obfuscation', 'supply-chain', 'malware', 'config', 'other'],
            },
            file: { type: 'string' },
            line: { anyOf: [{ type: 'number' }, { type: 'null' }] },
            evidence: { type: 'string' },
            impact: { type: 'string' },
            recommendation: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['title', 'severity', 'category', 'file', 'line', 'evidence', 'impact', 'recommendation', 'confidence'],
        },
      },
      dependencyRisks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            packageName: { type: 'string' },
            version: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
            risk: { type: 'string' },
            reason: { type: 'string' },
            recommendation: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          },
          required: ['packageName', 'version', 'severity', 'risk', 'reason', 'recommendation', 'confidence'],
        },
      },
      scannedFiles: { type: 'array', items: { type: 'string' } },
      notes: { type: 'array', items: { type: 'string' } },
    },
    required: ['riskLevel', 'summary', 'findings', 'dependencyRisks', 'scannedFiles', 'notes'],
  };

  return {
    system,
    user,
    schema,
    chunkIndex,
    totalChunks,
    includedFiles: selectedFiles.map((file) => file.path),
    omittedCount,
  };
}

export function buildSecurityPromptChunks(files: SourceFile[]): SecurityPromptChunk[] {
  const candidateFiles = files.filter((file) => isCandidateFile(file.path));

  if (candidateFiles.length === 0) {
    return [];
  }

  const rankedFiles = [...candidateFiles]
    .sort((left, right) => scoreSecurityFile(right) - scoreSecurityFile(left) || left.path.localeCompare(right.path))
    .slice(0, maxRankedFiles);
  const chunks = chunkItems(rankedFiles, maxFilesPerChunk, maxChunks);
  const omittedCount = Math.max(0, candidateFiles.length - rankedFiles.length);

  logger.debug('security_prompt_chunks_built', {
    inputFileCount: files.length,
    candidateFileCount: candidateFiles.length,
    rankedFileCount: rankedFiles.length,
    chunkCount: chunks.length,
    omittedCount,
  });

  return chunks.map((chunkFiles, chunkIndex) =>
    buildPromptForChunk(chunkFiles, chunkIndex, chunks.length, candidateFiles.length, omittedCount)
  );
}