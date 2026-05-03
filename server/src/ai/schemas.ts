import { z } from 'zod';
import type { FunctionDoc, Overview, SecurityScan, TechStack } from '../types';

export interface AiReadmeResponse {
  markdown: string;
}

export interface ChatReplyResponse {
  reply: string;
}

const nonEmptyStringSchema = z.string().trim().min(1);
const nullableStringSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim().length === 0 ? null : value),
  z.string().trim().min(1).nullable()
);

const parameterSchema = z
  .object({
    name: nonEmptyStringSchema,
    type: z.string().trim().default('unknown'),
    description: z.string().trim().default(''),
  })
  .strict();

const returnSchema = z
  .object({
    type: z.string().trim().default('unknown'),
    description: z.string().trim().default(''),
  })
  .strict();

export const techStackResponseSchema: z.ZodType<TechStack> = z
  .object({
    language: nonEmptyStringSchema,
    framework: nullableStringSchema,
    runtime: nonEmptyStringSchema,
    buildTool: nullableStringSchema,
    testingFramework: nullableStringSchema,
    database: nullableStringSchema,
    otherTools: z.array(nonEmptyStringSchema).default([]),
  })
  .strict();

export const overviewResponseSchema: z.ZodType<Overview> = z
  .object({
    oneLiner: nonEmptyStringSchema,
    summary: nonEmptyStringSchema,
    purpose: nonEmptyStringSchema,
    targetUsers: nonEmptyStringSchema,
  })
  .strict();

export const functionDocResponseSchema: z.ZodType<FunctionDoc> = z
  .object({
    name: nonEmptyStringSchema,
    type: z.enum(['function', 'class', 'method']),
    file: nonEmptyStringSchema,
    line: z.coerce.number().int().positive(),
    signature: nonEmptyStringSchema,
    description: nonEmptyStringSchema,
    params: z.array(parameterSchema).default([]),
    returns: returnSchema.default({ type: 'unknown', description: '' }),
    throws: z.array(z.string().trim()).default([]),
    dependencies: z.array(z.string().trim()).default([]),
  })
  .strict();

export const functionsResponseSchema: z.ZodType<FunctionDoc[]> = z
  .array(functionDocResponseSchema)
  .transform((functionDocs) => functionDocs.slice(0, 160));

const securitySeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
const securityConfidenceSchema = z.enum(['high', 'medium', 'low']);
const securityCategorySchema = z.enum([
  'dependency',
  'script',
  'secret',
  'network',
  'execution',
  'obfuscation',
  'supply-chain',
  'malware',
  'config',
  'other',
]);

const securityFindingSchema = z
  .object({
    title: nonEmptyStringSchema,
    severity: securitySeveritySchema,
    category: securityCategorySchema,
    file: nonEmptyStringSchema,
    line: z.coerce.number().int().positive().nullable().default(null),
    evidence: nonEmptyStringSchema,
    impact: nonEmptyStringSchema,
    recommendation: nonEmptyStringSchema,
    confidence: securityConfidenceSchema,
  })
  .strict();

const securityDependencyRiskSchema = z
  .object({
    packageName: nonEmptyStringSchema,
    version: nullableStringSchema,
    severity: securitySeveritySchema,
    risk: nonEmptyStringSchema,
    reason: nonEmptyStringSchema,
    recommendation: nonEmptyStringSchema,
    confidence: securityConfidenceSchema,
  })
  .strict();

export const securityScanResponseSchema: z.ZodType<SecurityScan> = z
  .object({
    riskLevel: z.enum(['critical', 'high', 'medium', 'low', 'info', 'unknown']),
    summary: nonEmptyStringSchema,
    findings: z.array(securityFindingSchema).default([]),
    dependencyRisks: z.array(securityDependencyRiskSchema).default([]),
    scannedFiles: z.array(nonEmptyStringSchema).default([]),
    notes: z.array(nonEmptyStringSchema).default([]),
  })
  .strict()
  .transform((scan) => ({
    ...scan,
    findings: scan.findings.slice(0, 80),
    dependencyRisks: scan.dependencyRisks.slice(0, 60),
    scannedFiles: scan.scannedFiles.slice(0, 120),
    notes: scan.notes.slice(0, 20),
  }));

export const aiReadmeResponseSchema: z.ZodType<AiReadmeResponse> = z
  .object({
    markdown: nonEmptyStringSchema,
  })
  .strict();

export const chatReplyResponseSchema: z.ZodType<ChatReplyResponse> = z
  .object({
    reply: nonEmptyStringSchema,
  })
  .strict();
