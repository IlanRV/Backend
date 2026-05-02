import { describe, expect, it } from 'vitest';
import {
  aiReadmeResponseSchema,
  chatReplyResponseSchema,
  functionDocResponseSchema,
  functionsResponseSchema,
  overviewResponseSchema,
  techStackResponseSchema,
} from '../../src/ai/schemas';

describe('AI response schemas', () => {
  it('normalizes nullable and array defaults on tech stack responses', () => {
    const parsed = techStackResponseSchema.parse({
      language: ' TypeScript ',
      framework: '',
      runtime: 'Node.js',
      buildTool: '',
      testingFramework: 'Vitest',
      database: '',
    });

    expect(parsed).toEqual({
      language: 'TypeScript',
      framework: null,
      runtime: 'Node.js',
      buildTool: null,
      testingFramework: 'Vitest',
      database: null,
      otherTools: [],
    });
  });

  it('rejects incomplete overview responses', () => {
    expect(() => overviewResponseSchema.parse({ oneLiner: 'Only one field' })).toThrow();
  });

  it('coerces line numbers and fills function doc defaults', () => {
    const parsed = functionDocResponseSchema.parse({
      name: 'hello',
      type: 'function',
      file: 'src/index.ts',
      line: '3',
      signature: 'function hello() {}',
      description: 'Greets a user.',
    });

    expect(parsed.line).toBe(3);
    expect(parsed.params).toEqual([]);
    expect(parsed.returns).toEqual({ type: 'unknown', description: '' });
    expect(parsed.throws).toEqual([]);
    expect(parsed.dependencies).toEqual([]);
  });

  it('caps function response arrays to eighty entries', () => {
    const docs = Array.from({ length: 90 }, (_, index) => ({
      name: `fn${index}`,
      type: 'function',
      file: 'src/index.ts',
      line: index + 1,
      signature: `function fn${index}() {}`,
      description: 'A documented function.',
      params: [],
      returns: { type: 'void', description: '' },
      throws: [],
      dependencies: [],
    }));

    expect(functionsResponseSchema.parse(docs)).toHaveLength(80);
  });

  it('requires non-empty AI README and chat replies', () => {
    expect(aiReadmeResponseSchema.parse({ markdown: '# Readme' })).toEqual({ markdown: '# Readme' });
    expect(chatReplyResponseSchema.parse({ reply: 'Hello' })).toEqual({ reply: 'Hello' });
    expect(() => chatReplyResponseSchema.parse({ reply: '   ' })).toThrow();
  });
});
