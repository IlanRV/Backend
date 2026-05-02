import type { FunctionDoc, Overview, TechStack } from '../../types';
import { createLogger } from '../../lib/logger';

interface PromptResult {
  system: string;
  user: string;
}

const logger = createLogger('prompt-ai-readme');

export function buildAiReadmePrompt(
  techStack: TechStack,
  overview: Overview,
  functions: FunctionDoc[],
  dependencies: Record<string, string>,
  repoName: string
): PromptResult {
  const functionsText = functions
    .map((item) => `- \`${item.signature}\` in \`${item.file}\`:${item.line} - ${item.description}`)
    .join('\n');
  const depsText = Object.entries(dependencies)
    .map(([name, version]) => `- \`${name}\`: \`${version}\``)
    .join('\n');

  logger.debug('ai_readme_prompt_built', {
    repoName,
    functionCount: functions.length,
    dependencyCount: Object.keys(dependencies).length,
    language: techStack.language,
    framework: techStack.framework,
    overviewLength: overview.summary.length,
  });

  const system = [
    'You are a senior developer who writes exceptional README documentation.',
    'Respond in clean, well-formatted Markdown.',
    'Do not wrap your response in code fences. Return raw markdown only.',
  ].join(' ');

  const user = `Generate a complete, professional README.md for the project "${repoName}".

TECH STACK:
- Language: ${techStack.language}
- Framework: ${techStack.framework || 'None'}
- Runtime: ${techStack.runtime}
- Build Tool: ${techStack.buildTool || 'None'}
- Testing: ${techStack.testingFramework || 'None'}
- Database: ${techStack.database || 'None'}
- Other Tools: ${techStack.otherTools.join(', ') || 'None'}

OVERVIEW:
- One Liner: ${overview.oneLiner}
- Purpose: ${overview.purpose}
- Target Users: ${overview.targetUsers}
- Summary: ${overview.summary}

FUNCTIONS AND API:
${functionsText || 'No functions documented.'}

DEPENDENCIES:
${depsText || 'No dependencies found.'}

Write a README.md with these sections, in this order:

# ${repoName}

## Overview
A comprehensive overview based on the summary above.

## Architecture
Describe the project architecture. Use a small ASCII text diagram when helpful.

## Setup Instructions
Step-by-step setup instructions with exact commands when they can be inferred.

## API Reference
Document every function or endpoint from the FUNCTIONS AND API section. Group by file.

## Environment Variables
List inferred environment variables in a table with Variable, Required, Default, and Description.

## Project Structure
Describe the likely folder structure and what each file or folder does.

## Dependencies
Split into production and development dependencies when possible. Add brief descriptions for key dependencies.

## Contributing
Include concise development and contribution guidelines.

## License
Note that the license should be confirmed by the project maintainer.

Rules:
- Be specific, not generic.
- Reference actual function names, file paths, and dependencies.
- Include exact commands that work when they can be inferred.
- If information is missing, infer cautiously and say when maintainers should confirm it.
- Do not invent unsupported features.`;

  return { system, user };
}
