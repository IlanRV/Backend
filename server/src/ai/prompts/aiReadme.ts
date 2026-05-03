import type { FunctionDoc, Overview, RunnabilityResult, SecurityScan, TechStack } from '../../types';

interface PromptResult {
  system: string;
  user: string;
  schema: object;
}

export function buildAiReadmePrompt(
  techStack: TechStack,
  overview: Overview,
  functions: FunctionDoc[],
  dependencies: Record<string, string>,
  repoName: string,
  runnability: RunnabilityResult,
  security: SecurityScan,
  fileTree: string,
  originalReadme: string
): PromptResult {
  const functionsText = functions
    .slice(0, 140)
    .map((item) => {
      const params = item.params.length
        ? ` Params: ${item.params.map((param) => `${param.name}: ${param.type || 'unknown'}${param.description ? ` - ${param.description}` : ''}`).join('; ')}.`
        : '';
      const returns = item.returns.description ? ` Returns: ${item.returns.description}` : '';
      const throws = item.throws.length ? ` Throws: ${item.throws.join('; ')}.` : '';
      const functionDependencies = item.dependencies.length ? ` Uses: ${item.dependencies.join(', ')}.` : '';
      return `- ${item.type.toUpperCase()} \`${item.signature}\` in \`${item.file}\`:${item.line} - ${item.description}${params}${returns}${throws}${functionDependencies}`;
    })
    .join('\n');
  const depsText = Object.entries(dependencies)
    .map(([name, version]) => `- \`${name}\`: \`${version}\``)
    .join('\n');
  const blockerDetailsText = runnability.blockerDetails?.length
    ? runnability.blockerDetails
        .map((blocker) => {
          const evidence = blocker.evidence ? ` Evidence: ${blocker.evidence}.` : '';
          return `- ${blocker.severity.toUpperCase()} ${blocker.title}: ${blocker.description} Recommendation: ${blocker.recommendation}.${evidence}`;
        })
        .join('\n')
    : runnability.blockers.join('; ') || 'None detected';
  const manualCommandsText = runnability.manualCommands?.length
    ? runnability.manualCommands
        .map((command) => `- ${command.command} (${command.confidence}): ${command.reason}`)
        .join('\n')
    : 'None detected';
  const runtimeProfile = runnability.runtimeProfile;
  const securityText = [
    `- Overall risk: ${security.riskLevel}`,
    `- Summary: ${security.summary}`,
    ...security.findings.slice(0, 20).map(
      (finding) =>
        `- ${finding.severity.toUpperCase()} ${finding.category}: ${finding.title} in ${finding.file}${finding.line ? `:${finding.line}` : ''} - ${finding.evidence}`
    ),
    ...security.dependencyRisks.slice(0, 20).map(
      (risk) =>
        `- ${risk.severity.toUpperCase()} dependency ${risk.packageName}${risk.version ? `@${risk.version}` : ''}: ${risk.risk} - ${risk.reason}`
    ),
  ].join('\n');

  const system = [
    'You are a senior staff engineer and technical writer who writes complete, useful README documentation for real repositories.',
    'Extract as much concrete signal as possible from the file tree, existing README, runtime profile, function docs, dependencies, and security scan.',
    'Favor specific repository evidence over generic boilerplate, but infer carefully when multiple evidence points agree.',
    'Write substantial Markdown that helps a developer understand, run, inspect, and maintain the project.',
    'Return valid JSON only, with the raw README markdown in the markdown field.',
    'Do not add prose outside the JSON object.',
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

FILE TREE:
${fileTree.slice(0, 16000) || 'No file tree provided.'}

EXISTING README EXCERPT:
${originalReadme.slice(0, 12000) || 'No existing README was found.'}

FUNCTIONS AND API:
${functionsText || 'No functions documented.'}
${functions.length > 140 ? `\n...${functions.length - 140} additional function entries omitted from this prompt.` : ''}

DEPENDENCIES:
${depsText || 'No dependencies found.'}

SECURITY SCAN:
${securityText || 'No security scan data found.'}

RUNNABILITY:
- Can run in BrowserPod: ${runnability.canRun ? 'yes' : 'no'}
- Entry point: ${runnability.entryPoint || 'None detected'}
- Auto command: ${runnability.autoCommand || runtimeProfile?.autoCommand || 'None detected'}
- Project kind: ${runtimeProfile?.projectKind || 'unknown'}
- Runtime support level: ${runtimeProfile?.supportLevel || 'analysis-only'}
- Preview expected: ${runtimeProfile?.previewExpected ? 'yes' : 'no'}
- Runtime reasoning: ${runtimeProfile?.reasoning || 'No runtime profile reasoning available.'}
- Runtime evidence: ${runtimeProfile?.evidence.join('; ') || 'None detected'}
- Manual commands:
${manualCommandsText}
- Blockers: ${runnability.blockers.join('; ') || 'None detected'}
- Blocker details:
${blockerDetailsText}

Write a README.md with these sections, in this order, and return it as the JSON field "markdown":

# ${repoName}

## Overview
A rich overview based on the summary above. Explain what the project does, who it is for, and the main workflow in plain language.

## Features
List concrete features, behaviors, routes, commands, UI surfaces, services, or library capabilities inferred from the evidence. Avoid generic bullets.

## Architecture
Describe the project architecture, data flow, important modules, and how the pieces interact. Use a small ASCII text diagram when helpful.

## Tech Stack
Summarize languages, frameworks, runtimes, build tools, test tools, databases, and important supporting packages with short explanations.

## Setup Instructions
Step-by-step setup instructions with exact commands when they can be inferred.

## Running Locally
Explain the primary run command, alternate commands, preview behavior, BrowserPod support, and what URL or console output users should expect when known.

## API Reference
Document every function, component, hook, route handler, service, CLI command, or endpoint from the FUNCTIONS AND API section. Group by file and include signatures, parameters, return behavior, side effects, and dependencies when available.

## Environment Variables
List inferred environment variables in a table with Variable, Required, Default, and Description.

## Project Structure
Describe the likely folder structure and what each file or folder does.

## Dependencies
Split into production and development dependencies when possible. Add brief descriptions for key dependencies.

## Testing and Quality
List test commands, lint/build checks, relevant test files, and any quality gates that can be inferred.

## Security Notes
Summarize dependency/script/code security findings. Be careful and evidence-based; do not overstate low-confidence findings.

## Troubleshooting
Capture likely setup, runtime, BrowserPod, dependency, or environment issues only when supported by evidence. Include practical next checks.

## Contributing
Include concise development and contribution guidelines.

## License
Note that the license should be confirmed by the project maintainer.

Rules:
- Be specific, not generic.
- Prefer a complete README over a short summary. When enough evidence exists, target detailed sections with useful paragraphs, tables, and bullets rather than one-line placeholders.
- Reference actual function names, file paths, and dependencies.
- Preserve and expand useful existing README content when it is compatible with the extracted evidence; do not merely summarize it away.
- Extract feature bullets from package scripts, route/component/function names, notable files, and existing README claims when they are supported by the evidence.
- Include exact setup and run commands only when they can be inferred from the available data.
- If Preview expected is yes, include "Run in BrowserPod with: ..." using the auto command.
- Include alternate manual commands in Running Locally or Testing and Quality when they are present, and explain when they are console-only.
- If Project kind is library, say "This is a library, not a live preview app" and show suggested validation commands.
- If Project kind is cli, say "This is a CLI/tooling repo, not a preview app" and show help/test commands.
- If Project kind is unknown, say "No reliable preview command could be inferred" and show manual suggestions if any.
- If BrowserPod runnability has blockers, explain them plainly in Setup Instructions without making non-preview repos sound broken.
- Include a meaningful API Reference even for frontend utilities/components: group documented functions, components, hooks, route handlers, pages, services, and helpers by file.
- For frontend apps, document user-facing screens/components and data flow when functions/components indicate them.
- For backend apps, document routes, request/response behavior, storage, jobs, and integrations when functions/files indicate them.
- For CLIs or scripts, document commands, arguments, inputs, outputs, and failure modes when functions/files indicate them.
- Include Security Notes based only on the security scan evidence above.
- Do not list environment variables unless they are strongly implied by code, config names, or dependency usage.
- If information is missing, infer cautiously and say what maintainers should confirm.
- Do not invent unsupported features.
- Do not leave sections empty. If a section has limited evidence, write a short evidence-based note about what is known and what should be confirmed.
- The markdown field must contain raw Markdown, not a markdown code fence.`;

  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      markdown: { type: 'string' },
    },
    required: ['markdown'],
  };

  return { system, user, schema };
}
