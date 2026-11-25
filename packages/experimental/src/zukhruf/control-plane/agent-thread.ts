import { isRecord } from '@deepagents/context';

import type { ConversationId } from '../mailbox/types.ts';
import { AgentPath } from './agent-path.ts';

export interface AgentThreadOptions {
  conversation: ConversationId;
  treeId: string;
  path: AgentPath;
  parentChatId: string | null;
  declarationName: string;
  lastTurnId?: string;
  /** When a delete of this root's tree began; set only on a root. */
  deletingAt?: number;
  /** When this agent's tree was archived; set on every member. */
  archivedAt?: number;
}

/** Durable identity and persisted metadata for one agent instance. */
export class AgentThread {
  readonly conversation: ConversationId;
  readonly treeId: string;
  readonly path: AgentPath;
  readonly parentChatId: string | null;
  readonly declarationName: string;
  readonly lastTurnId?: string;
  /**
   * When a delete of this root's tree began. The tree then reads as absent
   * and admits nothing, while its rows stay as the anchor a retried delete
   * finishes from.
   */
  readonly deletingAt?: number;
  /**
   * When this agent's tree was archived. Every member of the tree carries
   * it; the root's decides whether the tree is archived.
   */
  readonly archivedAt?: number;

  constructor(options: AgentThreadOptions) {
    AgentThread.#assertTopology(options);
    this.conversation = {
      chatId: options.conversation.chatId,
      userId: options.conversation.userId,
    };
    this.treeId = options.treeId;
    this.path = options.path;
    this.parentChatId = options.parentChatId;
    this.declarationName = options.declarationName;
    this.lastTurnId = options.lastTurnId;
    this.deletingAt = options.deletingAt;
    this.archivedAt = options.archivedAt;
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
    if (typeof treeId !== 'string' || !isRecord(zukhruf)) {
      return undefined;
    }

    const {
      path,
      parentChatId,
      declarationName,
      lastTurnId,
      deletingAt,
      archivedAt,
    } = zukhruf;
    if (
      typeof path !== 'string' ||
      (parentChatId !== null && typeof parentChatId !== 'string') ||
      typeof declarationName !== 'string' ||
      (lastTurnId !== undefined && typeof lastTurnId !== 'string') ||
      (deletingAt !== undefined && typeof deletingAt !== 'number') ||
      (archivedAt !== undefined && typeof archivedAt !== 'number')
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
        ...(deletingAt === undefined ? {} : { deletingAt }),
        ...(archivedAt === undefined ? {} : { archivedAt }),
      });
    } catch {
      return undefined;
    }
  }

  withLatestTurn(lastTurnId: string): AgentThread {
    return new AgentThread({ ...this.#options(), lastTurnId });
  }

  /** This root, marked as being deleted since `deletingAt`. */
  deleting(deletingAt: number): AgentThread {
    return new AgentThread({ ...this.#options(), deletingAt });
  }

  /** This agent, archived since `archivedAt`. */
  archived(archivedAt: number): AgentThread {
    return new AgentThread({ ...this.#options(), archivedAt });
  }

  /** This agent, no longer archived. */
  unarchived(): AgentThread {
    const options = this.#options();
    delete options.archivedAt;
    return new AgentThread(options);
  }

  #options(): AgentThreadOptions {
    return {
      conversation: this.conversation,
      treeId: this.treeId,
      path: this.path,
      parentChatId: this.parentChatId,
      declarationName: this.declarationName,
      ...(this.lastTurnId === undefined ? {} : { lastTurnId: this.lastTurnId }),
      ...(this.deletingAt === undefined ? {} : { deletingAt: this.deletingAt }),
      ...(this.archivedAt === undefined ? {} : { archivedAt: this.archivedAt }),
    };
  }

  toMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    const existing = isRecord(metadata?.zukhruf) ? { ...metadata.zukhruf } : {};
    // Written only while it is set, so an unarchived thread clears it.
    delete existing.archivedAt;
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
        ...(this.deletingAt === undefined
          ? {}
          : { deletingAt: this.deletingAt }),
        ...(this.archivedAt === undefined
          ? {}
          : { archivedAt: this.archivedAt }),
      },
    };
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
    if (options.deletingAt !== undefined) {
      throw new Error('only a root agent thread is deleted');
    }
    if (options.parentChatId === null) {
      throw new Error('child agent thread requires a parent');
    }
    if (options.parentChatId === options.conversation.chatId) {
      throw new Error('child agent thread cannot parent itself');
    }
  }
}
