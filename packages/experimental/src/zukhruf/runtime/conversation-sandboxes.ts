import type {
  AgentDeclaration,
  SandboxContext,
  ZukhrufSandbox,
} from '../agent.ts';

/**
 * The sandbox of each conversation, as DESIGN.md places it (sandbox →
 * conversation, stream → turn). The first turn of a conversation acquires it
 * from the declaration; later turns and plugins borrow the same handle, and
 * the host disposes it when the host ends. A handle can hold a connection
 * (a Microsandbox microVM refuses every connect after about 107 open ones),
 * and disposing it can end the environment (a container sandbox stops its
 * container), so neither a turn nor a plugin disposes it.
 */
export class ConversationSandboxes implements AsyncDisposable {
  // One memoized acquisition for each declaration and conversation.
  readonly #held = new Map<string, () => Promise<ZukhrufSandbox>>();

  acquire(
    declaration: AgentDeclaration,
    context: SandboxContext,
  ): Promise<ZukhrufSandbox> {
    const key = JSON.stringify([
      declaration.name,
      context.chatId,
      context.userId,
    ]);
    const held = this.#held.get(key);
    if (held !== undefined) return held();
    // A failed acquisition is forgotten, so the next turn tries again.
    const acquiring = declaration.sandbox(context).catch((error: unknown) => {
      this.#held.delete(key);
      throw error;
    });
    this.#held.set(key, () => acquiring);
    return acquiring;
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
