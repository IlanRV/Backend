const apiUrl = process.env.SMOKE_API_URL || 'http://localhost:3001/api';

async function request(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path} failed: ${response.status} ${text}`);
  }

  return body;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForExtraction(repoId) {
  for (let attempt = 1; attempt <= 180; attempt += 1) {
    const repo = await request(`/repos/${repoId}`);
    const extraction = await request(`/ai/extract/${repoId}`);

    if (repo.status === 'error') {
      throw new Error(`Extraction failed for repo ${repoId}`);
    }

    if (repo.status === 'ready' && extraction.techStack) {
      return { repo, extraction };
    }

    await delay(1000);
  }

  throw new Error(`Timed out waiting for extraction for repo ${repoId}`);
}

async function runSmokeTest() {
  let workspaceId = null;

  try {
    const workspace = await request('/workspaces', {
      method: 'POST',
      body: JSON.stringify({
        name: `Smoke Test ${new Date().toISOString()}`,
        description: 'Temporary backend CRUD verification',
      }),
    });
    workspaceId = workspace.workspaceId;
    console.log(`workspace created: ${workspace.workspaceId}`);

    const repo = await request(`/workspaces/${workspace.workspaceId}/repos`, {
      method: 'POST',
      body: JSON.stringify({ githubUrl: 'https://github.com/example/devhub-smoke-test.git' }),
    });
    console.log(`repo created: ${repo.repoId} (${repo.name})`);

    const extractionPayload = {
      fileTree: 'package.json\nsrc/index.ts\nREADME.md',
      files: [
        {
          path: 'package.json',
          content: JSON.stringify({
            name: 'devhub-smoke-test',
            description: 'Tiny Express API for backend smoke testing',
            scripts: { dev: 'tsx src/index.ts', start: 'node dist/index.js' },
            dependencies: { express: '^4.22.1' },
            devDependencies: { typescript: '^5.9.3', vitest: '^3.0.0' },
          }),
        },
        {
          path: 'src/index.ts',
          content: 'export function hello(name: string) { return `Hello ${name}`; }\nexport class Greeter { greet() { return hello("DevHub"); } }',
        },
        {
          path: 'README.md',
          content: '# DevHub Smoke Test\n\nA small repo used to verify DevHub backend extraction.',
        },
      ],
    };

    const extractionStart = await request(`/ai/extract/${repo.repoId}`, {
      method: 'POST',
      body: JSON.stringify(extractionPayload),
    });
    console.log(`extraction started: ${extractionStart.extractionId}`);

    const duplicateExtractionStart = await request(`/ai/extract/${repo.repoId}`, {
      method: 'POST',
      body: JSON.stringify(extractionPayload),
    });

    if (!duplicateExtractionStart.deduped && !duplicateExtractionStart.cached) {
      throw new Error('Duplicate extraction request was not deduped or served from cache');
    }

    console.log(
      `duplicate extraction: ${duplicateExtractionStart.cached ? 'cached' : 'deduped'}`
    );

    const { extraction } = await waitForExtraction(repo.repoId);
    console.log(`extraction: ${extraction.techStack.language}, ${extraction.functions.length} symbols`);

    await request(`/repos/${repo.repoId}/run`, {
      method: 'POST',
      body: JSON.stringify({ portalUrl: 'https://smoke-3000.browserportal.io' }),
    });
    const runningRepo = await request(`/repos/${repo.repoId}`);
    console.log(`repo after run: ${runningRepo.status}, ${runningRepo.portalUrl}`);

    await request(`/repos/${repo.repoId}/stop`, { method: 'POST' });
    const stoppedRepo = await request(`/repos/${repo.repoId}`);
    console.log(`repo after stop: ${stoppedRepo.status}, ${stoppedRepo.portalUrl}`);

    const loadedWorkspace = await request(`/workspaces/${workspace.workspaceId}`);
    console.log(`workspace repo count: ${loadedWorkspace.repos.length}`);
  } finally {
    if (workspaceId) {
      await request(`/workspaces/${workspaceId}`, { method: 'DELETE' });
      console.log('cleanup complete');
    }
  }
}

runSmokeTest().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});