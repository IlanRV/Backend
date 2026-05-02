import { ChatMessage, Repo, Workspace } from '../../types';
import { createLogger } from '../../lib/logger';

const logger = createLogger('prompt-chat-context');

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trim()}...`;
}

function formatHistory(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return 'No prior conversation.';
  }

  return messages
    .slice(-12)
    .map((message) => `${message.role.toUpperCase()}: ${truncateText(message.content, 1200)}`)
    .join('\n');
}

function formatDependencies(dependencies: Record<string, string>): string {
  const entries = Object.entries(dependencies);

  if (entries.length === 0) {
    return 'None detected';
  }

  const visibleDependencies = Object.fromEntries(entries.slice(0, 40));
  const suffix = entries.length > 40 ? `\n...${entries.length - 40} more dependencies omitted` : '';
  return `${JSON.stringify(visibleDependencies, null, 2)}${suffix}`;
}

function formatRepoAnalysis(repo: Repo): string {
  if (!repo.analysis) {
    return `Repository: ${repo.name}\nStatus: ${repo.status}\nNo AI analysis has been generated yet.`;
  }

  const { overview, techStack, functions, dependencies } = repo.analysis;
  const functionDocs = functions
    .slice(0, 40)
    .map(
      (functionDoc) =>
        `- ${functionDoc.name} (${functionDoc.type}) in ${functionDoc.file}:${functionDoc.line}\n` +
        `  Signature: ${functionDoc.signature}\n` +
        `  Description: ${functionDoc.description}`
    )
    .join('\n');

  return [
    `Repository: ${repo.name}`,
    `GitHub URL: ${repo.githubUrl}`,
    `Status: ${repo.status}`,
    'Overview:',
    `- One liner: ${overview.oneLiner}`,
    `- Summary: ${overview.summary}`,
    `- Purpose: ${overview.purpose}`,
    `- Target users: ${overview.targetUsers}`,
    'Tech stack:',
    `- Language: ${techStack.language}`,
    `- Framework: ${techStack.framework || 'None detected'}`,
    `- Runtime: ${techStack.runtime}`,
    `- Build tool: ${techStack.buildTool || 'None detected'}`,
    `- Testing framework: ${techStack.testingFramework || 'None detected'}`,
    `- Database: ${techStack.database || 'None detected'}`,
    `- Other tools: ${techStack.otherTools.length ? techStack.otherTools.join(', ') : 'None detected'}`,
    `Dependencies: ${formatDependencies(dependencies)}`,
    `Functions:\n${functionDocs || 'No function docs extracted.'}`,
    functions.length > 40 ? `Functions omitted from prompt: ${functions.length - 40}` : '',
    repo.aiReadme ? `AI README excerpt:\n${truncateText(repo.aiReadme, 6000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildRepoChatSystemPrompt(repo: Repo, messages: ChatMessage[]): string {
  logger.debug('repo_chat_prompt_built', {
    repoId: repo.repoId,
    status: repo.status,
    hasAnalysis: Boolean(repo.analysis),
    historyCount: messages.length,
  });

  return [
    'You are DevHub, a practical code expert assistant for repository exploration.',
    'Use only the extracted repository context below. You do not have live access to files beyond this context.',
    'Answer directly, cite relevant file paths or function names when useful, and separate confirmed facts from cautious inferences.',
    'If the requested detail is missing from the extracted analysis, say what is missing and suggest the specific file or area to inspect next.',
    'Repository context:',
    formatRepoAnalysis(repo),
    'Recent conversation history:',
    formatHistory(messages),
  ].join('\n\n');
}

export function buildWorkspaceChatSystemPrompt(
  workspace: Workspace,
  repos: Repo[],
  messages: ChatMessage[]
): string {
  logger.debug('workspace_chat_prompt_built', {
    workspaceId: workspace.workspaceId,
    repoCount: repos.length,
    analyzedRepoCount: repos.filter((repo) => Boolean(repo.analysis)).length,
    historyCount: messages.length,
  });

  return [
    'You are DevHub, a practical code expert assistant for multi-repository workspaces.',
    'Use only the extracted workspace context below. You do not have live access to files beyond this context.',
    'Compare repositories when useful, explain likely relationships between services, and be explicit when analysis data is incomplete.',
    'Answer with concrete next steps when the user is asking how to debug, run, extend, or understand the workspace.',
    `Workspace: ${workspace.name}`,
    `Description: ${workspace.description}`,
    'Repository contexts:',
    repos.map(formatRepoAnalysis).join('\n\n---\n\n') || 'No repositories have been added to this workspace yet.',
    'Recent conversation history:',
    formatHistory(messages),
  ].join('\n\n');
}
