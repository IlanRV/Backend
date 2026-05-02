import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { callOpenRouter, formatOpenRouterFailure, isOpenRouterFailure } from '../ai/openrouter';
import { buildRepoChatSystemPrompt, buildWorkspaceChatSystemPrompt } from '../ai/prompts/chatContext';
import { getCollection, getDoc, setDoc } from '../lib/firebase';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { createLogger } from '../lib/logger';
import { ChatMessage, Repo, Workspace } from '../types';

const router = Router();
const logger = createLogger('routes-chat');

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function messageFromDoc(document: FirebaseFirestore.QueryDocumentSnapshot): ChatMessage {
  return {
    ...(document.data() as ChatMessage),
    messageId: document.id,
  };
}

function byTimestamp(left: ChatMessage, right: ChatMessage): number {
  return left.timestamp.localeCompare(right.timestamp);
}

async function getMessages(scopeType: ChatMessage['scopeType'], scopeId: string): Promise<ChatMessage[]> {
  const snapshot = await getCollection('chat_messages')
    .where('scopeType', '==', scopeType)
    .where('scopeId', '==', scopeId)
    .get();

  return snapshot.docs.map(messageFromDoc).sort(byTimestamp);
}

async function getLastMessages(scopeType: ChatMessage['scopeType'], scopeId: string): Promise<ChatMessage[]> {
  const snapshot = await getCollection('chat_messages')
    .where('scopeType', '==', scopeType)
    .where('scopeId', '==', scopeId)
    .get();

  return snapshot.docs.map(messageFromDoc).sort(byTimestamp).slice(-20);
}

async function saveChatMessage(message: Omit<ChatMessage, 'messageId' | 'timestamp'>): Promise<ChatMessage> {
  const chatMessage: ChatMessage = {
    ...message,
    messageId: uuidv4(),
    timestamp: new Date().toISOString(),
  };

  await setDoc('chat_messages', chatMessage.messageId, chatMessage);
  logger.debug('chat_message_saved', {
    messageId: chatMessage.messageId,
    scopeType: chatMessage.scopeType,
    scopeId: chatMessage.scopeId,
    role: chatMessage.role,
    contentLength: chatMessage.content.length,
  });
  return chatMessage;
}

function buildRepoFallbackReply(repo: Repo, reason: string): string {
  const context = repo.analysis
    ? [
        `I still have the saved extraction for ${repo.name}: ${repo.analysis.overview.oneLiner}`,
        `Detected stack: ${repo.analysis.techStack.language}${repo.analysis.techStack.framework ? ` / ${repo.analysis.techStack.framework}` : ''}.`,
        `Documented symbols: ${repo.analysis.functions.length}.`,
      ].join(' ')
    : `No completed extraction is available for ${repo.name} yet.`;

  return [
    'The AI model is temporarily unavailable, so I cannot generate a fresh answer right now.',
    reason,
    context,
    'Try again shortly, or switch OPENROUTER_MODEL to an available DeepSeek model for smoother chat.',
  ].join('\n\n');
}

function buildWorkspaceFallbackReply(workspace: Workspace, repos: Repo[], reason: string): string {
  const readyRepos = repos.filter((repo) => repo.analysis).length;

  return [
    'The AI model is temporarily unavailable, so I cannot generate a fresh workspace answer right now.',
    reason,
    `${workspace.name} currently has ${repos.length} repos, with ${readyRepos} completed extractions available for future chat context.`,
    'Try again shortly, or switch OPENROUTER_MODEL to an available DeepSeek model for smoother chat.',
  ].join('\n\n');
}

function getDuplicateCachedReply(messages: ChatMessage[], content: string): string | null {
  const previousUserMessage = messages[messages.length - 2];
  const previousAssistantMessage = messages[messages.length - 1];

  if (
    previousUserMessage?.role === 'user' &&
    previousAssistantMessage?.role === 'assistant' &&
    previousUserMessage.content.trim() === content
  ) {
    return previousAssistantMessage.content;
  }

  return null;
}

router.post(
  '/repo/:repoId',
  asyncHandler(async (req, res) => {
    const { message } = req.body as { message?: unknown };

    if (!isNonEmptyString(message)) {
      throw createHttpError(400, 'message is required');
    }

    const repoId = getRouteParam(req, 'repoId');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const trimmedMessage = message.trim();
    const history = await getLastMessages('repo', repo.repoId);
    const cachedReply = getDuplicateCachedReply(history, trimmedMessage);

    if (cachedReply) {
      res.json({ reply: cachedReply, degraded: false, cached: true });
      return;
    }

    const systemPrompt = buildRepoChatSystemPrompt(repo, history);
    logger.info('repo_chat_requested', {
      repoId: repo.repoId,
      historyCount: history.length,
      messageLength: trimmedMessage.length,
    });

    let degraded = false;
    let reply: string;

    try {
      reply = await callOpenRouter(trimmedMessage, systemPrompt);
    } catch (error) {
      if (!isOpenRouterFailure(error)) {
        throw error;
      }

      degraded = true;
      const reason = formatOpenRouterFailure(error);
      logger.warn('repo_chat_degraded', { repoId: repo.repoId, reason });
      reply = buildRepoFallbackReply(repo, reason);
    }

    await saveChatMessage({
      scopeType: 'repo',
      scopeId: repo.repoId,
      role: 'user',
      content: trimmedMessage,
    });
    await saveChatMessage({
      scopeType: 'repo',
      scopeId: repo.repoId,
      role: 'assistant',
      content: reply,
    });

    logger.info('repo_chat_replied', {
      repoId: repo.repoId,
      replyLength: reply.length,
    });
    res.json({ reply, degraded });
  })
);

router.get(
  '/repo/:repoId',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'repoId');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const messages = await getMessages('repo', repo.repoId);
    logger.debug('repo_chat_history_returned', {
      repoId: repo.repoId,
      messageCount: messages.length,
    });
    res.json(messages);
  })
);

router.post(
  '/workspace/:wsId',
  asyncHandler(async (req, res) => {
    const { message } = req.body as { message?: unknown };

    if (!isNonEmptyString(message)) {
      throw createHttpError(400, 'message is required');
    }

    const workspaceId = getRouteParam(req, 'wsId');
    const workspace = await getDoc<Workspace>('workspaces', workspaceId);

    if (!workspace) {
      throw createHttpError(404, 'Workspace not found');
    }

    const repoSnapshot = await getCollection('repos')
      .where('workspaceId', '==', workspace.workspaceId)
      .get();
    const repos = repoSnapshot.docs.map((document) => ({
      ...(document.data() as Repo),
      repoId: document.id,
    })).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const trimmedMessage = message.trim();
    const history = await getLastMessages('workspace', workspace.workspaceId);
    const cachedReply = getDuplicateCachedReply(history, trimmedMessage);

    if (cachedReply) {
      res.json({ reply: cachedReply, degraded: false, cached: true });
      return;
    }

    const systemPrompt = buildWorkspaceChatSystemPrompt(workspace, repos, history);
    logger.info('workspace_chat_requested', {
      workspaceId: workspace.workspaceId,
      repoCount: repos.length,
      historyCount: history.length,
      messageLength: trimmedMessage.length,
    });

    let degraded = false;
    let reply: string;

    try {
      reply = await callOpenRouter(trimmedMessage, systemPrompt);
    } catch (error) {
      if (!isOpenRouterFailure(error)) {
        throw error;
      }

      degraded = true;
      const reason = formatOpenRouterFailure(error);
      logger.warn('workspace_chat_degraded', { workspaceId: workspace.workspaceId, reason });
      reply = buildWorkspaceFallbackReply(workspace, repos, reason);
    }

    await saveChatMessage({
      scopeType: 'workspace',
      scopeId: workspace.workspaceId,
      role: 'user',
      content: trimmedMessage,
    });
    await saveChatMessage({
      scopeType: 'workspace',
      scopeId: workspace.workspaceId,
      role: 'assistant',
      content: reply,
    });

    logger.info('workspace_chat_replied', {
      workspaceId: workspace.workspaceId,
      replyLength: reply.length,
    });
    res.json({ reply, degraded });
  })
);

router.get(
  '/workspace/:wsId',
  asyncHandler(async (req, res) => {
    const workspaceId = getRouteParam(req, 'wsId');
    const workspace = await getDoc<Workspace>('workspaces', workspaceId);

    if (!workspace) {
      throw createHttpError(404, 'Workspace not found');
    }
    const messages = await getMessages('workspace', workspace.workspaceId);
    logger.debug('workspace_chat_history_returned', {
      workspaceId: workspace.workspaceId,
      messageCount: messages.length,
    });
    res.json(messages);
  })
);

export default router;
