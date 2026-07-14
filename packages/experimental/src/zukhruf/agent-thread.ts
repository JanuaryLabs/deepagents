import { AgentPath } from './agent-path.ts';
import type { ConversationId } from './mailbox/types.ts';

export interface AgentThreadOptions {
  conversation: ConversationId;
  treeId: string;
  path: AgentPath;
  parentChatId: string | null;
  declarationName: string;
  lastTurnId?: string;
}

/** Durable identity and persisted metadata for one agent instance. */
export class AgentThread {
  readonly conversation: ConversationId;
  readonly treeId: string;
  readonly path: AgentPath;
  readonly parentChatId: string | null;
  readonly declarationName: string;
  readonly lastTurnId?: string;

  constructor(options: AgentThreadOptions) {
    AgentThread.#assertTopology(options);
    this.conversation = options.conversation;
    this.treeId = options.treeId;
    this.path = options.path;
    this.parentChatId = options.parentChatId;
    this.declarationName = options.declarationName;
    this.lastTurnId = options.lastTurnId;
  }

  static root(
    conversation: ConversationId,
    declarationName: string,
  ): AgentThread {
    return new AgentThread({
      conversation,
      treeId: conversation.chatId,
      path: AgentPath.root(),
      parentChatId: null,
      declarationName,
    });
  }

  static metadataFilter(treeId: string): { key: string; value: string } {
    return { key: 'zukhrufTreeId', value: treeId };
  }

  static hasReservedMetadata(
    metadata: Record<string, unknown> | undefined,
  ): boolean {
    return Boolean(
      metadata &&
      (Object.hasOwn(metadata, 'zukhrufTreeId') ||
        Object.hasOwn(metadata, 'zukhruf')),
    );
  }

  static fromMetadata(
    conversation: ConversationId,
    metadata: Record<string, unknown> | undefined,
  ): AgentThread | undefined {
    const treeId = metadata?.zukhrufTreeId;
    const zukhruf = metadata?.zukhruf;
    if (typeof treeId !== 'string' || !AgentThread.#isRecord(zukhruf)) {
      return undefined;
    }

    const { path, parentChatId, declarationName, lastTurnId } = zukhruf;
    if (
      typeof path !== 'string' ||
      (parentChatId !== null && typeof parentChatId !== 'string') ||
      typeof declarationName !== 'string' ||
      (lastTurnId !== undefined && typeof lastTurnId !== 'string')
    ) {
      return undefined;
    }

    let parsedPath: AgentPath;
    try {
      parsedPath = AgentPath.parse(path);
    } catch {
      return undefined;
    }
    if (parsedPath.toString() !== path) return undefined;

    try {
      return new AgentThread({
        conversation,
        treeId,
        path: parsedPath,
        parentChatId,
        declarationName,
        ...(lastTurnId === undefined ? {} : { lastTurnId }),
      });
    } catch {
      return undefined;
    }
  }

  withLatestTurn(lastTurnId: string): AgentThread {
    return new AgentThread({
      conversation: this.conversation,
      treeId: this.treeId,
      path: this.path,
      parentChatId: this.parentChatId,
      declarationName: this.declarationName,
      lastTurnId,
    });
  }

  toMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const existing = AgentThread.#isRecord(metadata?.zukhruf)
      ? metadata.zukhruf
      : {};
    return {
      ...metadata,
      zukhrufTreeId: this.treeId,
      zukhruf: {
        ...existing,
        path: this.path.toString(),
        parentChatId: this.parentChatId,
        declarationName: this.declarationName,
        ...(this.lastTurnId === undefined
          ? {}
          : { lastTurnId: this.lastTurnId }),
      },
    };
  }

  static #isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  static #assertTopology(options: AgentThreadOptions): void {
    if (options.path.isRoot) {
      if (options.treeId !== options.conversation.chatId) {
        throw new Error('root agent thread treeId must match its chatId');
      }
      if (options.parentChatId !== null) {
        throw new Error('root agent thread cannot have a parent');
      }
      return;
    }
    if (options.parentChatId === null) {
      throw new Error('child agent thread requires a parent');
    }
    if (options.parentChatId === options.conversation.chatId) {
      throw new Error('child agent thread cannot parent itself');
    }
  }
}
