import { v5 as uuidv5 } from 'uuid';

import type { ContextStore } from '@deepagents/context';

import type { ConversationId } from '../mailbox/types.ts';
import { AgentThread } from './agent-thread.ts';

/** ContextStore-backed directory of durable agent instances. */
export class AgentDirectory {
  readonly #store: ContextStore;

  constructor(store: ContextStore) {
    this.#store = store;
  }

  async assertOwnerIfExists(conversation: ConversationId): Promise<void> {
    const chat = await this.#store.getChat(conversation.chatId);
    if (!chat) return;
    this.#assertOwner(conversation, chat.userId);
    const thread = this.#threadFromMetadata(conversation, chat.metadata);
    if (thread) await this.#assertValidParent(thread);
  }

  async load(conversation: ConversationId): Promise<AgentThread | undefined> {
    const chat = await this.#store.getChat(conversation.chatId);
    if (chat) this.#assertOwner(conversation, chat.userId);
    if (!chat) return undefined;
    const thread = this.#threadFromMetadata(conversation, chat.metadata);
    if (thread) await this.#assertValidParent(thread);
    return thread;
  }

  async loadOrCreateRoot(
    conversation: ConversationId,
    declarationName: string,
  ): Promise<AgentThread> {
    await this.#store.upsertChat({
      id: conversation.chatId,
      userId: conversation.userId,
    });
    let thread!: AgentThread;
    let adopted = false;
    await this.#store.updateChat(conversation.chatId, (chat) => {
      this.#assertOwner(conversation, chat.userId);
      const existing = this.#threadFromMetadata(conversation, chat.metadata);
      if (existing) {
        thread = existing;
        adopted = true;
        return undefined;
      }
      thread = AgentThread.root(conversation, declarationName);
      adopted = false;
      return { metadata: thread.toMetadata(chat.metadata) };
    });
    if (adopted) {
      await this.#assertValidParent(thread);
    }
    return thread;
  }

  async recordLatestTurn(
    conversation: ConversationId,
    streamId: string,
  ): Promise<AgentThread> {
    return this.#updateLatestTurn(conversation, streamId);
  }

  async recordLatestTurnIfCurrent(
    conversation: ConversationId,
    streamId: string,
    expectedLastTurnId: string | undefined,
  ): Promise<AgentThread | undefined> {
    return this.#updateLatestTurn(conversation, streamId, expectedLastTurnId);
  }

  async listTree(thread: AgentThread): Promise<AgentThread[]> {
    const chats = await this.#store.listChats({
      userId: thread.conversation.userId,
      metadata: AgentThread.metadataFilter(thread.treeId),
    });
    return Promise.all(
      chats.map(async (chat) => {
        const conversation = { chatId: chat.id, userId: chat.userId };
        const member = this.#threadFromMetadata(conversation, chat.metadata);
        if (!member) {
          throw new Error(
            `AgentDirectory.listTree: chat "${chat.id}" is missing Zukhruf metadata`,
          );
        }
        await this.#assertValidParent(member);
        return member;
      }),
    );
  }

  async resolve(thread: AgentThread, target: string): Promise<AgentThread> {
    const path = thread.path.resolve(target);
    const match = await this.find(thread, target);
    if (match) return match;
    throw new Error(`agent path "${path}" does not exist in this tree`);
  }

  async find(
    thread: AgentThread,
    target: string,
  ): Promise<AgentThread | undefined> {
    const path = thread.path.resolve(target);
    return (await this.listTree(thread)).find((candidate) =>
      candidate.path.equals(path),
    );
  }

  async createChild(options: {
    parent: AgentThread;
    taskName: string;
    declarationName: string;
  }): Promise<AgentThread> {
    const path = options.parent.path.resolve(options.taskName);
    const pathString = path.toString();
    const conversation = {
      chatId: AgentDirectory.#childChatId(
        options.parent.conversation.userId,
        options.parent.treeId,
        pathString,
      ),
      userId: options.parent.conversation.userId,
    };
    const occupied = (await this.listTree(options.parent)).find((thread) =>
      thread.path.equals(path),
    );
    if (occupied && occupied.conversation.chatId !== conversation.chatId) {
      throw new Error(`agent path "${pathString}" already exists`);
    }

    const child = new AgentThread({
      conversation,
      treeId: options.parent.treeId,
      path,
      parentChatId: options.parent.conversation.chatId,
      declarationName: options.declarationName,
    });
    const storedChat = await this.#store.upsertChat({
      id: conversation.chatId,
      userId: conversation.userId,
      metadata: child.toMetadata(undefined),
    });
    const stored = AgentThread.fromMetadata(
      { chatId: storedChat.id, userId: storedChat.userId },
      storedChat.metadata,
    );
    if (
      storedChat.userId !== conversation.userId ||
      stored?.treeId !== child.treeId ||
      !stored.path.equals(child.path) ||
      stored.parentChatId !== child.parentChatId ||
      stored.declarationName !== child.declarationName
    ) {
      throw new Error(`agent path "${pathString}" already exists`);
    }
    return stored;
  }

  static #childChatId(userId: string, treeId: string, path: string): string {
    return uuidv5(
      `urn:deepagents:zukhruf:agent:${JSON.stringify([userId, treeId, path])}`,
      uuidv5.URL,
    );
  }

  #assertOwner(conversation: ConversationId, storedUserId: string): void {
    if (storedUserId === conversation.userId) return;
    throw new Error(
      `chat "${conversation.chatId}" belongs to user "${storedUserId}", not "${conversation.userId}"`,
    );
  }

  #threadFromMetadata(
    conversation: ConversationId,
    metadata: Record<string, unknown> | undefined,
  ): AgentThread | undefined {
    const thread = AgentThread.fromMetadata(conversation, metadata);
    if (!thread && AgentThread.hasReservedMetadata(metadata)) {
      throw new Error(
        `invalid Zukhruf metadata for chat "${conversation.chatId}"`,
      );
    }
    return thread;
  }

  async #assertValidParent(thread: AgentThread): Promise<void> {
    if (thread.path.isRoot) return;
    const parentChatId = thread.parentChatId;
    if (!parentChatId) {
      throw new Error(
        `invalid Zukhruf parent for chat "${thread.conversation.chatId}"`,
      );
    }
    const parentChat = await this.#store.getChat(parentChatId);
    if (!parentChat || parentChat.userId !== thread.conversation.userId) {
      throw new Error(
        `invalid Zukhruf parent for chat "${thread.conversation.chatId}"`,
      );
    }
    const parent = this.#threadFromMetadata(
      { chatId: parentChat.id, userId: parentChat.userId },
      parentChat.metadata,
    );
    const expectedPath = thread.path.parent;
    if (
      !parent ||
      !expectedPath ||
      parent.treeId !== thread.treeId ||
      !parent.path.equals(expectedPath)
    ) {
      throw new Error(
        `invalid Zukhruf parent for chat "${thread.conversation.chatId}"`,
      );
    }
  }

  async #updateLatestTurn(
    conversation: ConversationId,
    streamId: string,
    expectedLastTurnId?: string,
  ): Promise<AgentThread>;
  async #updateLatestTurn(
    conversation: ConversationId,
    streamId: string,
    expectedLastTurnId: string | undefined,
  ): Promise<AgentThread | undefined>;
  async #updateLatestTurn(
    conversation: ConversationId,
    streamId: string,
    ...expected: [string | undefined] | []
  ): Promise<AgentThread | undefined> {
    let result: AgentThread | undefined;
    await this.#store.updateChat(conversation.chatId, (chat) => {
      this.#assertOwner(conversation, chat.userId);
      const thread = this.#threadFromMetadata(conversation, chat.metadata);
      if (!thread) {
        throw new Error(
          `AgentDirectory.recordLatestTurn: missing agent metadata for chat "${conversation.chatId}"`,
        );
      }
      if (expected.length > 0 && thread.lastTurnId !== expected[0]) {
        result = undefined;
        return undefined;
      }
      if (thread.lastTurnId === streamId) {
        result = thread;
        return undefined;
      }
      result = thread.withLatestTurn(streamId);
      return { metadata: result.toMetadata(chat.metadata) };
    });
    return result;
  }
}
