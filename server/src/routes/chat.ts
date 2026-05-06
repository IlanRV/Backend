import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { callOpenRouterStructured, formatOpenRouterFailure, isOpenRouterFailure } from '../ai/openrouter';
import { buildRepoChatSystemPrompt, buildWorkspaceChatSystemPrompt } from '../ai/prompts/chatContext';
import { chatReplyResponseSchema, type ChatReplyResponse } from '../ai/schemas';
import { deleteDoc, getCollection, getDoc, setDoc } from '../lib/firebase';
import { asyncHandler, createHttpError, getRouteParam } from '../lib/http';
import { createLogger } from '../lib/logger';
import { ChatConversationSummary, ChatMessage, Repo, Workspace } from '../types';

const router = Router();
const logger = createLogger('routes-chat');
const defaultConversationId = 'default';
const defaultSessionId = 'anonymous';
const chatReplyJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reply: { type: 'string' },
  },
  required: ['reply'],
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeConversationId(value: unknown): string {
  if (typeof value !== 'string') {
    return defaultConversationId;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : defaultConversationId;
}

function extractSessionId(req: { headers: Record<string, unknown> }): string {
  const raw = req.headers['x-session-id'];

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return defaultSessionId;
  }

  return raw.trim().slice(0, 128);
}

function messageFromDoc(document: FirebaseFirestore.QueryDocumentSnapshot): ChatMessage {
  const data = document.data() as ChatMessage;

  return {
    ...data,
    messageId: document.id,
    sessionId: data.sessionId || defaultSessionId,
    conversationId: normalizeConversationId(data.conversationId),
  };
}

function byTimestamp(left: ChatMessage, right: ChatMessage): number {
  return left.timestamp.localeCompare(right.timestamp);
}

async function getScopeMessages(scopeType: ChatMessage['scopeType'], scopeId: string, sessionId: string): Promise<ChatMessage[]> {
  const snapshot = await getCollection('chat_messages')
    .where('scopeType', '==', scopeType)
    .where('scopeId', '==', scopeId)
    .where('sessionId', '==', sessionId)
    .get();

  return snapshot.docs.map(messageFromDoc).sort(byTimestamp);
}

async function getMessages(scopeType: ChatMessage['scopeType'], scopeId: string, sessionId: string, conversationId: string): Promise<ChatMessage[]> {
  const messages = await getScopeMessages(scopeType, scopeId, sessionId);
  return messages.filter((message) => message.conversationId === conversationId);
}

async function getLastMessages(scopeType: ChatMessage['scopeType'], scopeId: string, sessionId: string, conversationId: string): Promise<ChatMessage[]> {
  const messages = await getMessages(scopeType, scopeId, sessionId, conversationId);
  return messages.slice(-20);
}

function buildConversationTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  const title = firstUserMessage?.content.replace(/\s+/g, ' ').trim() || 'New chat';
  return title.length > 48 ? `${title.slice(0, 45)}...` : title;
}

async function getConversationSummaries(scopeType: ChatMessage['scopeType'], scopeId: string, sessionId: string): Promise<ChatConversationSummary[]> {
  const groupedMessages = new Map<string, ChatMessage[]>();

  for (const message of await getScopeMessages(scopeType, scopeId, sessionId)) {
    const conversationMessages = groupedMessages.get(message.conversationId) ?? [];
    conversationMessages.push(message);
    groupedMessages.set(message.conversationId, conversationMessages);
  }

  return [...groupedMessages.entries()]
    .map(([conversationId, messages]) => ({
      conversationId,
      title: buildConversationTitle(messages),
      updatedAt: messages[messages.length - 1]?.timestamp ?? new Date(0).toISOString(),
      messageCount: messages.length,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function saveChatMessage(message: Omit<ChatMessage, 'messageId' | 'timestamp'>): Promise<ChatMessage> {
  const chatMessage: ChatMessage = {
    ...message,
    conversationId: normalizeConversationId(message.conversationId),
    messageId: uuidv4(),
    timestamp: new Date().toISOString(),
  };

  await setDoc('chat_messages', chatMessage.messageId, chatMessage);
  return chatMessage;
}

async function deleteMessages(scopeType: ChatMessage['scopeType'], scopeId: string, sessionId: string, conversationId: string): Promise<number> {
  const snapshot = await getCollection('chat_messages')
    .where('scopeType', '==', scopeType)
    .where('scopeId', '==', scopeId)
    .where('sessionId', '==', sessionId)
    .get();
  let deletedCount = 0;

  for (const document of snapshot.docs) {
    const message = messageFromDoc(document);

    if (message.conversationId === conversationId) {
      await deleteDoc('chat_messages', document.id);
      deletedCount += 1;
    }
  }

  return deletedCount;
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

function buildStructuredChatPrompt(systemPrompt: string): string {
  return [
    systemPrompt,
    'Response contract:',
    'Return valid JSON only with this shape: { "reply": "plain Markdown answer for the user" }.',
    'The reply field should contain the complete answer. Do not include JSON, schema details, or tool metadata inside the reply text.',
  ].join('\n\n');
}

async function callStructuredChatReply(message: string, systemPrompt: string): Promise<string> {
  const response = await callOpenRouterStructured<ChatReplyResponse>(
    message,
    buildStructuredChatPrompt(systemPrompt),
    chatReplyJsonSchema,
    chatReplyResponseSchema
  );

  return response.reply.trim();
}

function chatFailureReason(error: unknown): string {
  if (isOpenRouterFailure(error)) {
    return formatOpenRouterFailure(error);
  }

  return 'The AI response did not match DevHub validation, so it was rejected before being shown.';
}

router.post(
  '/repo/:repoId',
  asyncHandler(async (req, res) => {
    const { message, conversationId: bodyConversationId } = req.body as { message?: unknown; conversationId?: unknown };

    if (!isNonEmptyString(message)) {
      throw createHttpError(400, 'message is required');
    }

    const repoId = getRouteParam(req, 'repoId');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const sessionId = extractSessionId(req);
    const trimmedMessage = message.trim();
    const conversationId = normalizeConversationId(bodyConversationId);
    const history = await getLastMessages('repo', repo.repoId, sessionId, conversationId);
    const cachedReply = getDuplicateCachedReply(history, trimmedMessage);

    if (cachedReply) {
      res.json({ reply: cachedReply, degraded: false, cached: true, conversationId });
      return;
    }

    const systemPrompt = buildRepoChatSystemPrompt(repo, history);

    let degraded = false;
    let reply: string;

    try {
      reply = await callStructuredChatReply(trimmedMessage, systemPrompt);
    } catch (error) {
      degraded = true;
      const reason = chatFailureReason(error);
      logger.warn('repo_chat_degraded', { repoId: repo.repoId, reason });
      reply = buildRepoFallbackReply(repo, reason);
    }

    await saveChatMessage({
      scopeType: 'repo',
      scopeId: repo.repoId,
      sessionId,
      conversationId,
      role: 'user',
      content: trimmedMessage,
    });
    await saveChatMessage({
      scopeType: 'repo',
      scopeId: repo.repoId,
      sessionId,
      conversationId,
      role: 'assistant',
      content: reply,
    });

    res.json({ reply, degraded, conversationId });
  })
);

router.get(
  '/repo/:repoId/conversations',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'repoId');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const sessionId = extractSessionId(req);
    res.json({ conversations: await getConversationSummaries('repo', repo.repoId, sessionId) });
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

    const sessionId = extractSessionId(req);
    const conversationId = normalizeConversationId(req.query.conversationId);
    const messages = await getMessages('repo', repo.repoId, sessionId, conversationId);
    res.json({ conversationId, messages });
  })
);

router.delete(
  '/repo/:repoId',
  asyncHandler(async (req, res) => {
    const repoId = getRouteParam(req, 'repoId');
    const repo = await getDoc<Repo>('repos', repoId);

    if (!repo) {
      throw createHttpError(404, 'Repo not found');
    }

    const sessionId = extractSessionId(req);
    const conversationId = normalizeConversationId(req.query.conversationId);
    const deletedCount = await deleteMessages('repo', repo.repoId, sessionId, conversationId);
    res.json({ success: true, conversationId, deletedCount });
  })
);

router.post(
  '/workspace/:wsId',
  asyncHandler(async (req, res) => {
    const { message, conversationId: bodyConversationId } = req.body as { message?: unknown; conversationId?: unknown };

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
    const sessionId = extractSessionId(req);
    const trimmedMessage = message.trim();
    const conversationId = normalizeConversationId(bodyConversationId);
    const history = await getLastMessages('workspace', workspace.workspaceId, sessionId, conversationId);
    const cachedReply = getDuplicateCachedReply(history, trimmedMessage);

    if (cachedReply) {
      res.json({ reply: cachedReply, degraded: false, cached: true, conversationId });
      return;
    }

    const systemPrompt = buildWorkspaceChatSystemPrompt(workspace, repos, history);

    let degraded = false;
    let reply: string;

    try {
      reply = await callStructuredChatReply(trimmedMessage, systemPrompt);
    } catch (error) {
      degraded = true;
      const reason = chatFailureReason(error);
      logger.warn('workspace_chat_degraded', { workspaceId: workspace.workspaceId, reason });
      reply = buildWorkspaceFallbackReply(workspace, repos, reason);
    }

    await saveChatMessage({
      scopeType: 'workspace',
      scopeId: workspace.workspaceId,
      sessionId,
      conversationId,
      role: 'user',
      content: trimmedMessage,
    });
    await saveChatMessage({
      scopeType: 'workspace',
      scopeId: workspace.workspaceId,
      sessionId,
      conversationId,
      role: 'assistant',
      content: reply,
    });

    res.json({ reply, degraded, conversationId });
  })
);

router.get(
  '/workspace/:wsId/conversations',
  asyncHandler(async (req, res) => {
    const workspaceId = getRouteParam(req, 'wsId');
    const workspace = await getDoc<Workspace>('workspaces', workspaceId);

    if (!workspace) {
      throw createHttpError(404, 'Workspace not found');
    }

    const sessionId = extractSessionId(req);
    res.json({ conversations: await getConversationSummaries('workspace', workspace.workspaceId, sessionId) });
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
    const sessionId = extractSessionId(req);
    const conversationId = normalizeConversationId(req.query.conversationId);
    const messages = await getMessages('workspace', workspace.workspaceId, sessionId, conversationId);
    res.json({ conversationId, messages });
  })
);

router.delete(
  '/workspace/:wsId',
  asyncHandler(async (req, res) => {
    const workspaceId = getRouteParam(req, 'wsId');
    const workspace = await getDoc<Workspace>('workspaces', workspaceId);

    if (!workspace) {
      throw createHttpError(404, 'Workspace not found');
    }

    const sessionId = extractSessionId(req);
    const conversationId = normalizeConversationId(req.query.conversationId);
    const deletedCount = await deleteMessages('workspace', workspace.workspaceId, sessionId, conversationId);
    res.json({ success: true, conversationId, deletedCount });
  })
);

export default router;
