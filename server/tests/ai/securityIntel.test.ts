import { describe, expect, it } from 'vitest';

import { detectExternalServiceHints, detectKnownDependencyRisks } from '../../src/ai/securityIntel';

describe('security intelligence helpers', () => {
  it('detects known vulnerable nodejs-goof dependency versions from package-lock files', () => {
    const risks = detectKnownDependencyRisks([
      {
        path: 'package-lock.json',
        content: JSON.stringify({
          lockfileVersion: 3,
          packages: {
            '': { dependencies: { marked: '0.3.5', st: '0.2.4', mongoose: '4.2.4' } },
            'node_modules/marked': { version: '0.3.5' },
            'node_modules/st': { version: '0.2.4' },
            'node_modules/ms': { version: '0.7.1' },
            'node_modules/mongoose': { version: '4.2.4' },
            'node_modules/lodash': { version: '4.17.15' },
            'node_modules/handlebars': { version: '4.0.14' },
          },
        }),
      },
    ]);

    expect(risks).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageName: 'marked', version: '0.3.5', severity: 'high' }),
      expect.objectContaining({ packageName: 'st', version: '0.2.4', severity: 'high' }),
      expect.objectContaining({ packageName: 'ms', version: '0.7.1', severity: 'medium' }),
      expect.objectContaining({ packageName: 'mongoose', version: '4.2.4', severity: 'high' }),
      expect.objectContaining({ packageName: 'lodash', version: '4.17.15', severity: 'high' }),
      expect.objectContaining({ packageName: 'handlebars', version: '4.0.14', severity: 'high' }),
    ]));
  });

  it('detects MongoDB service requirements from deps, docker compose, and README', () => {
    const hints = detectExternalServiceHints(
      [
        { path: 'README.md', content: 'Run mongod before npm start. MongoDB 3 is known to work.' },
        { path: 'docker-compose.yml', content: 'services:\n  mongo:\n    image: mongo:3' },
        { path: 'mongoose-db.js', content: 'mongoose.connect(process.env.MONGOLAB_URI || "mongodb://localhost/express-todo")' },
      ],
      { mongoose: '^4.2.4', mongodb: '^2.0.46' },
      {}
    );

    expect(hints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        service: 'MongoDB',
        evidence: expect.stringContaining('mongoose'),
        recommendation: expect.stringContaining('MongoDB'),
        confidence: 'high',
      }),
    ]));
  });
});
