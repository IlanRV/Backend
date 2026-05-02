import { ChatMessage, Repo, Workspace } from '../../types';

function formatHistory(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return 'No prior conversation.';
  }

  return messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join('\n');
}

function formatRepoAnalysis(repo: Repo): string {
  if (!repo.analysis) {
    return `Repository: ${repo.name}\nStatus: ${repo.status}\nNo AI analysis has been generated yet.`;
  }

  const { overview, techStack, functions, dependencies } = repo.analysis;
  const functionDocs = functions
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
    `Dependencies: ${Object.keys(dependencies).length ? JSON.stringify(dependencies, null, 2) : 'None detected'}`,
    `Functions:\n${functionDocs || 'No function docs extracted.'}`,
    repo.aiReadme ? `AI README:\n${repo.aiReadme}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildRepoChatSystemPrompt(repo: Repo, messages: ChatMessage[]): string {
  return [
    'You are a code expert assistant. You have access to the full source code of this repository through its extracted analysis.',
    'Answer clearly and ground your response in the repository context. If the requested detail is not present in the extracted analysis, say what is missing and suggest where to inspect next.',
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
  return [
    'You are a code expert. You have access to ALL repositories in this workspace through their extracted analyses.',
    'Compare repositories when useful, explain relationships between services, and be explicit when analysis data is incomplete.',
    `Workspace: ${workspace.name}`,
    `Description: ${workspace.description}`,
    'Repository contexts:',
    repos.map(formatRepoAnalysis).join('\n\n---\n\n') || 'No repositories have been added to this workspace yet.',
    'Recent conversation history:',
    formatHistory(messages),
  ].join('\n\n');
}