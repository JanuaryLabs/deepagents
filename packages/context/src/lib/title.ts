import type { UIMessage } from 'ai';
import { z } from 'zod';

import type { AgentModel } from '@deepagents/agent';

import { structuredOutput } from './agent.ts';
import { ContextEngine } from './engine.ts';
import { role } from './fragments/domain.ts';
import { stripReminders, user } from './fragments/message/user.ts';
import { InMemoryContextStore } from './store/memory.store.ts';

const TITLE_PROMPT = `Generate a short chat title (2-5 words) summarizing the user's message.

Examples:
- "what's the weather in nyc" -> Weather in NYC
- "help me write an essay about space" -> Space Essay Help
- "hi" -> New Conversation
- "debug my python code" -> Python Debugging`;

const titleSchema = z.object({ title: z.string() });

function extractText(message: UIMessage): string {
  const cleaned = stripReminders(message);
  const textPart = cleaned.parts.find((p) => p.type === 'text');
  return textPart && 'text' in textPart ? textPart.text : '';
}

function truncateTitle(text: string): string {
  if (!text) return 'New Chat';
  return text.length > 100 ? text.slice(0, 100) + '...' : text;
}

export function staticChatTitle(message: UIMessage): string {
  return truncateTitle(extractText(message));
}

export interface GenerateChatTitleOptions {
  message: UIMessage;
  model: AgentModel;
  abortSignal?: AbortSignal;
}

export async function generateChatTitle(
  options: GenerateChatTitleOptions,
): Promise<string> {
  const text = extractText(options.message);
  const fallback = truncateTitle(text);

  if (!text) return fallback;

  const store = new InMemoryContextStore();
  const context = new ContextEngine({
    store,
    chatId: crypto.randomUUID(),
    userId: 'system',
  });
  context.set(role(TITLE_PROMPT), user(text));

  try {
    const { title } = await structuredOutput({
      context,
      model: options.model,
      schema: titleSchema,
    }).generate({}, { abortSignal: options.abortSignal });
    return title || fallback;
  } catch (error) {
    console.warn('Title generation failed, using fallback:', error);
    return fallback;
  }
}
