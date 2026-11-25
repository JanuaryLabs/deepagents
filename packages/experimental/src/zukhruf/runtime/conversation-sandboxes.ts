import { type SandboxContext, SandboxNotFoundError } from '@deepagents/context';

import type { AgentDeclaration, ZukhrufSandbox } from '../agent.ts';
import { ConversationNotFoundError } from '../control-plane/conversation-not-found-error.ts';

type Acquisition = () => Promise<ZukhrufSandbox>;

/**
 * The sandbox handle of each conversation, as DESIGN.md places it (sandbox →
 * conversation, stream → turn). The first borrow opens the chat's sandbox in
 * the declaration's environment; later turns and plugins borrow the same
 * handle, which each borrow resumes (a stopped sandbox starts again), and the
 * host closes every handle when the host ends. A handle can hold a connection
 * (a Microsandbox microVM refuses every connect after about 107 open ones),
 * so neither a turn nor a plugin closes it. Closing never stops or removes
 * the sandbox, which other workers may be using: stopping and deleting a
 * chat's sandbox belongs to its environment. A handle whose sandbox is gone
 * is closed, and the chat is opened again while it is `reopenable`; a chat
 * that is not (it was deleted, perhaps by another worker) is forgotten and
 * reads as absent, so a stale handle never creates its sandbox again.
 */
export class ConversationSandboxes implements AsyncDisposable {
  readonly #reopenable: (chat: SandboxContext) => Promise<boolean>;
  // One memoized acquisition for each declaration and conversation.
  readonly #held = new Map<string, Acquisition>();
  // The check of a held acquisition that is in flight, which every caller
  // shares: a caller's own check could still be running on a handle that
  // another caller's check found gone and closed.
  readonly #checks = new WeakMap<Acquisition, Acquisition>();

  constructor(options: {
    /** Whether a chat whose sandbox is gone may open it again. */
    reopenable(chat: SandboxContext): Promise<boolean>;
  }) {
    this.#reopenable = options.reopenable;
  }

  acquire(
    declaration: AgentDeclaration,
    context: SandboxContext,
  ): Promise<ZukhrufSandbox> {
    const key = ConversationSandboxes.#key(declaration, context);
    const held = this.#held.get(key);
    if (held === undefined)
      return this.#hold(key, declaration.sandbox.open(context));
    let check = this.#checks.get(held);
    if (check === undefined) {
      const checking = this.#check(key, held, declaration, context).finally(
        () => this.#checks.delete(held),
      );
      check = () => checking;
      this.#checks.set(held, check);
    }
    return check();
  }

  /**
   * Closes the handle this process holds for the chat, as deleting the chat
   * does, once a check in flight settles: a check that opened the chat again
   * holds the handle to close.
   */
  async forget(
    declaration: AgentDeclaration,
    context: SandboxContext,
  ): Promise<void> {
    const key = ConversationSandboxes.#key(declaration, context);
    const held = this.#held.get(key);
    if (held === undefined) return;
    // Waits for an acquire or check in flight to settle; its caller gets its
    // failure, so a failed one leaves nothing here to close.
    await Promise.allSettled([this.#checks.get(held)?.()]);
    const current = this.#held.get(key);
    this.#held.delete(key);
    const [acquired] = await Promise.allSettled([current?.()]);
    if (acquired.status === 'fulfilled') await acquired.value?.sandbox.close();
  }

  static #key(declaration: AgentDeclaration, context: SandboxContext): string {
    return JSON.stringify([declaration.name, context.chatId, context.userId]);
  }

  // A failed acquisition is forgotten, so the next turn tries again.
  #hold(
    key: string,
    acquiring: Promise<ZukhrufSandbox>,
  ): Promise<ZukhrufSandbox> {
    const held = acquiring.catch((error: unknown) => {
      this.#held.delete(key);
      throw error;
    });
    this.#held.set(key, () => held);
    return held;
  }

  /**
   * Resumed before the turn, not left to its first command: the turn's tools
   * are bound to this handle, so a sandbox found gone mid-turn fails the
   * model's tool call instead of opening the chat again.
   */
  async #check(
    key: string,
    held: Acquisition,
    declaration: AgentDeclaration,
    context: SandboxContext,
  ): Promise<ZukhrufSandbox> {
    const handle = await held();
    try {
      await handle.sandbox.resume();
      return handle;
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }
    if (!(await this.#reopenable(context))) {
      this.#held.delete(key);
      await handle.sandbox.close();
      throw new ConversationNotFoundError(context.chatId);
    }
    // Held before the release, so a caller that comes during it waits for
    // the new acquisition instead of starting one of its own.
    return this.#hold(
      key,
      handle.sandbox.close().then(() => declaration.sandbox.open(context)),
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await using handles = new AsyncDisposableStack();
    const acquired = await Promise.allSettled(
      Array.from(this.#held.values(), (held) => held()),
    );
    this.#held.clear();
    for (const result of acquired)
      if (result.status === 'fulfilled') handles.use(result.value.sandbox);
  }
}
