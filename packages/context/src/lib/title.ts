import type { UIMessage } from 'ai';
import { z } from 'zod';

import type { AgentModel } from './advisor.ts';
import { structuredOutput } from './agent.ts';
import { ContextEngine } from './engine.ts';
import { role } from './fragments/domain.ts';
import { stripReminders, user } from './fragments/message/user.ts';
import { InMemoryContextStore } from './store/memory.store.ts';
import { extractPlainText } from './text.ts';

const TITLE_PROMPT = `Generate a short chat title (2-5 words) summarizing the user's message.

Examples:
- "what's the weather in nyc" -> Weather in NYC
- "help me write an essay about space" -> Space Essay Help
- "hi" -> New Conversation
- "debug my python code" -> Python Debugging`;

const titleSchema = z.object({ title: z.string() });

export interface TitleGeneratorOptions {
  context: ContextEngine;
}

export interface EnsureResult {
  title: string;
  source: 'llm' | 'static';
}

export class TitleGenerator {
  #context: ContextEngine;

  constructor(options: TitleGeneratorOptions) {
    this.#context = options.context;
  }

  async ensure(options: {
    model: AgentModel;
    abortSignal?: AbortSignal;
  }): Promise<EnsureResult | null> {
    const msg = await this.#firstUntitledUser();
    if (!msg) return null;
    try {
      const title = await this.#generateTitle(msg, options);
      return this.#applyTitle(title, 'llm');
    } catch (error) {
      console.warn(
        'TitleGenerator: LLM title generation failed, falling back to static.',
        error,
      );
      return this.#applyTitle(this.#staticTitle(msg), 'static');
    }
  }

  async ensureStatic(): Promise<EnsureResult | null> {
    const msg = await this.#firstUntitledUser();
    if (!msg) return null;
    return this.#applyTitle(this.#staticTitle(msg), 'static');
  }

  #staticTitle(message: UIMessage): string {
    return this.#truncateTitle(this.#extractText(message));
  }

  async #generateTitle(
    message: UIMessage,
    options: { model: AgentModel; abortSignal?: AbortSignal },
  ): Promise<string> {
    const text = this.#extractText(message);
    if (!text) {
      throw new Error(
        'Cannot generate chat title: message has no text content.',
      );
    }

    const store = new InMemoryContextStore();
    const context = new ContextEngine({
      store,
      chatId: crypto.randomUUID(),
      userId: 'system',
    });
    context.set(role(TITLE_PROMPT), user(text));

    const { title } = await structuredOutput({
      context,
      model: options.model,
      schema: titleSchema,
    }).generate({}, { abortSignal: options.abortSignal });

    if (!title) {
      throw new Error('Title generation returned an empty string.');
    }
    return title;
  }

  #extractText(message: UIMessage): string {
    return extractPlainText(stripReminders(message));
  }

  #truncateTitle(text: string): string {
    if (!text) return 'New Chat';
    return text.length > 100 ? text.slice(0, 100) + '...' : text;
  }

  async #applyTitle(
    title: string,
    source: 'llm' | 'static',
  ): Promise<EnsureResult> {
    await this.#context.updateChat({ title });
    return { title, source };
  }

  async #firstUntitledUser(): Promise<UIMessage | undefined> {
    if (this.#context.chat?.title) return undefined;
    return this.#context.firstUserMessage();
  }
}
