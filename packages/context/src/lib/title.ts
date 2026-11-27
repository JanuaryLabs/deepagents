import type { UIMessage, generateText } from 'ai';
import { z } from 'zod';

import type { AgentModel } from './advisor.ts';
import { structuredOutput } from './agent.ts';
import { ContextEngine } from './engine.ts';
import { role } from './fragments/domain.ts';
import { user } from './fragments/message/user.ts';
import { stripReminders } from './fragments/reminders/index.ts';
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

/** The model call that generates a chat's title. */
export interface TitleModelOptions {
  model: AgentModel;
  /**
   * Call-level provider options of the title call, such as the routing and
   * user the chat's own turns send, so the first message takes the same route.
   */
  providerOptions?: Parameters<typeof generateText>[0]['providerOptions'];
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

  /**
   * Titles an untitled chat with its first message, then upgrades that title
   * to one the model generates. Each write is conditional under the store's
   * lock, so a title set meanwhile (a rename) is kept. Returns `null` when the
   * chat already had another title or it changed while the model ran.
   */
  async ensure(
    options: TitleModelOptions & { abortSignal?: AbortSignal },
  ): Promise<EnsureResult | null> {
    const msg = await this.#context.firstUserMessage();
    if (!msg) return null;
    const staticTitle = this.#staticTitle(msg);
    const { stored } = await this.#placeStatic(staticTitle);
    if (stored !== staticTitle) return null;

    let title: string;
    try {
      title = await this.#generate(msg, options);
    } catch (error) {
      console.warn(
        'TitleGenerator: LLM title generation failed, keeping the static title.',
        error,
      );
      return { title: staticTitle, source: 'static' };
    }
    const upgraded = await this.#context.updateChat((chat) =>
      chat.title === staticTitle ? { title } : undefined,
    );
    return upgraded.title === title ? { title, source: 'llm' } : null;
  }

  /**
   * Titles an untitled chat with its first message. Returns `null` when the
   * chat already has a title.
   */
  async ensureStatic(): Promise<EnsureResult | null> {
    const msg = await this.#context.firstUserMessage();
    if (!msg) return null;
    const title = this.#staticTitle(msg);
    const { placed } = await this.#placeStatic(title);
    return placed ? { title, source: 'static' } : null;
  }

  async #placeStatic(
    title: string,
  ): Promise<{ placed: boolean; stored: string | undefined }> {
    // The chat is open here (firstUserMessage opened it), and a stored title is
    // never removed: stores skip an undefined title (postgres.store.ts:312), so a
    // titled snapshot needs no locked read.
    const known = this.#context.chat?.title;
    if (known !== undefined) return { placed: false, stored: known };
    let placed = false;
    const stored = await this.#context.updateChat((chat) => {
      if (chat.title !== undefined) return undefined;
      placed = true;
      return { title };
    });
    return { placed, stored: stored.title };
  }

  #staticTitle(message: UIMessage): string {
    return this.#truncateTitle(this.#extractText(message));
  }

  async #generate(
    message: UIMessage,
    options: TitleModelOptions & { abortSignal?: AbortSignal },
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
      providerOptions: options.providerOptions,
    }).generate({ abortSignal: options.abortSignal });

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
}
