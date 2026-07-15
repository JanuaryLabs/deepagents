import { type UIMessage, validateUIMessages } from 'ai';
import { v5 as uuidv5 } from 'uuid';

import {
  type ContextStore,
  type MessageData,
  isSyntheticReminderMessage,
} from '@deepagents/context';

import type { AgentThread } from './agent-thread.ts';
import type { ForkTurns } from './fork-turns.ts';

interface HistoryForkRecord {
  forkTurns: ForkTurns;
  parentChatId: string;
  parentHeadMessageId: string | null;
  sourceMessageIds?: string[];
}

interface SourceMessage {
  stored: MessageData;
  message: UIMessage;
}

/** Copies a stable, filtered parent-history snapshot into a new child chat. */
export class AgentHistoryForker {
  readonly #store: ContextStore;

  constructor(store: ContextStore) {
    this.#store = store;
  }

  async fork(
    parent: AgentThread,
    child: AgentThread,
    forkTurns: ForkTurns,
  ): Promise<void> {
    const record = await this.#claim(parent, child, forkTurns);
    if (record.forkTurns === 'none' || record.parentHeadMessageId === null) {
      return;
    }

    const selected = await this.#selectedMessages(parent, child, record);
    if (selected.length === 0) return;

    const cloned = this.#cloneMessages(child, selected);
    const expectedIds = cloned.map((message) => message.id);
    const branch = await this.#store.getActiveBranch(child.conversation.chatId);
    if (!branch) {
      throw new Error(
        `spawn_agent: child chat "${child.conversation.chatId}" has no active branch`,
      );
    }
    if (branch.headMessageId !== null) {
      if (await this.#hasForkedPrefix(child, expectedIds)) return;
      throw new Error(
        `spawn_agent: cannot apply parent history after child "${child.path}" has started`,
      );
    }

    const head = cloned.at(-1);
    if (!head) return;
    await this.#store.addMessages(cloned);
    const committed = await this.#store.updateBranchHead(
      branch.id,
      head.id,
      null,
    );
    if (!committed && !(await this.#hasForkedPrefix(child, expectedIds))) {
      throw new Error(
        `spawn_agent: child "${child.path}" started before parent history was applied`,
      );
    }
    if (!(await this.#hasForkedPrefix(child, expectedIds))) {
      throw new Error(
        `spawn_agent: failed to persist parent history for child "${child.path}"`,
      );
    }
  }

  async #claim(
    parent: AgentThread,
    child: AgentThread,
    forkTurns: ForkTurns,
  ): Promise<HistoryForkRecord> {
    const parentBranch = await this.#store.getActiveBranch(
      parent.conversation.chatId,
    );
    if (!parentBranch) {
      throw new Error(
        `spawn_agent: parent chat "${parent.conversation.chatId}" has no active branch`,
      );
    }
    const proposed: HistoryForkRecord = {
      forkTurns,
      parentChatId: parent.conversation.chatId,
      parentHeadMessageId:
        forkTurns === 'none' ? null : parentBranch.headMessageId,
    };
    let claimed: HistoryForkRecord | undefined;

    await this.#store.updateChat(child.conversation.chatId, (chat) => {
      const metadata = chat.metadata;
      const zukhruf = metadata?.zukhruf;
      if (!isRecord(zukhruf)) {
        throw new Error(
          `spawn_agent: child chat "${child.conversation.chatId}" is missing Zukhruf metadata`,
        );
      }

      if (zukhruf.historyFork !== undefined) {
        claimed = parseHistoryForkRecord(zukhruf.historyFork);
        if (
          claimed.parentChatId !== proposed.parentChatId ||
          claimed.forkTurns !== proposed.forkTurns
        ) {
          throw new Error(
            `spawn_agent: agent path "${child.path}" already exists with a different fork_turns setting`,
          );
        }
        return undefined;
      }

      claimed = proposed;
      return {
        metadata: {
          ...metadata,
          zukhruf: { ...zukhruf, historyFork: proposed },
        },
      };
    });

    if (!claimed) {
      throw new Error(
        `spawn_agent: failed to claim history for child "${child.path}"`,
      );
    }
    return claimed;
  }

  async #sourceMessages(
    parent: AgentThread,
    record: HistoryForkRecord,
  ): Promise<SourceMessage[]> {
    const headId = record.parentHeadMessageId;
    if (headId === null) return [];

    const chain = await this.#store.getMessageChain(headId);
    if (chain.at(-1)?.id !== headId) {
      throw new Error(
        `spawn_agent: parent history head "${headId}" is unavailable`,
      );
    }
    if (
      chain.some((message) => message.chatId !== parent.conversation.chatId)
    ) {
      throw new Error('spawn_agent: parent history crosses chat boundaries');
    }

    const materialized = chain.filter(
      (message) => !isEmptyAssistantPlaceholder(message.data),
    );
    const messages = await validateUIMessages({
      messages: materialized.map((message) => message.data),
    });
    return materialized.map((stored, index) => {
      const message = messages[index];
      if (message.id !== stored.id) {
        throw new Error(
          `spawn_agent: stored message "${stored.id}" has a mismatched payload id`,
        );
      }
      return { stored, message };
    });
  }

  async #selectedMessages(
    parent: AgentThread,
    child: AgentThread,
    record: HistoryForkRecord,
  ): Promise<SourceMessage[]> {
    if (record.forkTurns === 'none') return [];
    if (record.sourceMessageIds !== undefined) {
      return this.#messagesById(parent, record.sourceMessageIds);
    }

    const source = await this.#sourceMessages(parent, record);
    const selected = this.#select(source, record.forkTurns)
      .map((entry) => this.#keepHistoryMessage(entry))
      .filter((entry): entry is SourceMessage => entry !== undefined);
    const sourceMessageIds = await this.#claimSelection(
      child,
      selected.map(({ stored }) => stored.id),
    );
    return arraysEqual(
      sourceMessageIds,
      selected.map(({ stored }) => stored.id),
    )
      ? selected
      : this.#messagesById(parent, sourceMessageIds);
  }

  async #messagesById(
    parent: AgentThread,
    sourceMessageIds: string[],
  ): Promise<SourceMessage[]> {
    const storedMessages = await Promise.all(
      sourceMessageIds.map((id) => this.#store.getMessage(id)),
    );
    if (
      storedMessages.some(
        (message) =>
          message === undefined ||
          message.chatId !== parent.conversation.chatId,
      )
    ) {
      throw new Error(
        'spawn_agent: persisted parent-history snapshot is unavailable',
      );
    }
    const stored = storedMessages as MessageData[];
    const messages = await validateUIMessages({
      messages: stored.map((message) => message.data),
    });
    return stored.map((messageData, index) => {
      const source = this.#keepHistoryMessage({
        stored: messageData,
        message: messages[index],
      });
      if (!source || source.message.id !== messageData.id) {
        throw new Error(
          `spawn_agent: persisted parent-history message "${messageData.id}" changed shape`,
        );
      }
      return source;
    });
  }

  async #claimSelection(
    child: AgentThread,
    proposedIds: string[],
  ): Promise<string[]> {
    let sourceMessageIds: string[] | undefined;
    await this.#store.updateChat(child.conversation.chatId, (chat) => {
      const metadata = chat.metadata;
      const zukhruf = metadata?.zukhruf;
      if (!isRecord(zukhruf)) {
        throw new Error(
          `spawn_agent: child chat "${child.conversation.chatId}" is missing Zukhruf metadata`,
        );
      }
      const record = parseHistoryForkRecord(zukhruf.historyFork);
      if (record.sourceMessageIds !== undefined) {
        sourceMessageIds = record.sourceMessageIds;
        return undefined;
      }

      sourceMessageIds = proposedIds;
      return {
        metadata: {
          ...metadata,
          zukhruf: {
            ...zukhruf,
            historyFork: { ...record, sourceMessageIds: proposedIds },
          },
        },
      };
    });
    if (!sourceMessageIds) {
      throw new Error(
        `spawn_agent: failed to claim parent-history messages for child "${child.path}"`,
      );
    }
    return sourceMessageIds;
  }

  #select(source: SourceMessage[], forkTurns: Exclude<ForkTurns, 'none'>) {
    if (forkTurns === 'all') return source;

    const boundaries = source.flatMap((entry, index) =>
      isForkTurnBoundary(entry.message) ? [index] : [],
    );
    const start = boundaries.at(-forkTurns) ?? boundaries[0];
    return start === undefined ? [] : source.slice(start);
  }

  #keepHistoryMessage(entry: SourceMessage): SourceMessage | undefined {
    const { message } = entry;
    if (message.role === 'user') {
      if (
        isSyntheticReminderMessage(message) ||
        interAgentCommunication(message) !== undefined
      ) {
        return undefined;
      }
      return entry;
    }
    if (message.role !== 'assistant') return undefined;

    const finalStepStart = message.parts.findLastIndex(
      (part) => part.type === 'step-start',
    );
    const parts = message.parts
      .slice(finalStepStart + 1)
      .filter((part) =>
        ['text', 'file', 'source-url', 'source-document'].includes(part.type),
      );
    return parts.length === 0
      ? undefined
      : { ...entry, message: { ...message, parts } };
  }

  #cloneMessages(child: AgentThread, selected: SourceMessage[]): MessageData[] {
    let parentId: string | null = null;
    return selected.map(({ stored, message }) => {
      const id = uuidv5(
        `urn:deepagents:zukhruf:forked-message:${JSON.stringify([
          child.conversation.chatId,
          stored.id,
        ])}`,
        uuidv5.URL,
      );
      const clone: MessageData = {
        id,
        chatId: child.conversation.chatId,
        parentId,
        name: message.role,
        type: 'message',
        data: { ...message, id },
        createdAt: stored.createdAt,
      };
      parentId = id;
      return clone;
    });
  }

  async #hasForkedPrefix(
    child: AgentThread,
    expectedIds: string[],
  ): Promise<boolean> {
    const branch = await this.#store.getActiveBranch(child.conversation.chatId);
    if (!branch?.headMessageId) return false;
    const chain = await this.#store.getMessageChain(branch.headMessageId);
    return expectedIds.every(
      (id, index) =>
        chain[index]?.id === id &&
        chain[index]?.chatId === child.conversation.chatId,
    );
  }
}

function isForkTurnBoundary(message: UIMessage): boolean {
  if (message.role !== 'user' || isSyntheticReminderMessage(message)) {
    return false;
  }
  return interAgentCommunication(message)?.triggerTurn ?? true;
}

function interAgentCommunication(
  message: UIMessage,
): { triggerTurn: boolean } | undefined {
  if (!isRecord(message.metadata)) return undefined;
  if (!Object.hasOwn(message.metadata, 'interAgentCommunication')) {
    return undefined;
  }
  const communication = message.metadata.interAgentCommunication;
  if (
    !isRecord(communication) ||
    typeof communication.triggerTurn !== 'boolean'
  ) {
    throw new Error(
      `spawn_agent: message "${message.id}" has invalid inter-agent metadata`,
    );
  }
  return { triggerTurn: communication.triggerTurn };
}

function parseHistoryForkRecord(value: unknown): HistoryForkRecord {
  if (!isRecord(value)) {
    throw new Error('spawn_agent: invalid persisted history-fork metadata');
  }
  const { forkTurns, parentChatId, parentHeadMessageId, sourceMessageIds } =
    value;
  if (
    !isForkTurns(forkTurns) ||
    typeof parentChatId !== 'string' ||
    !parentChatId.trim() ||
    (parentHeadMessageId !== null &&
      (typeof parentHeadMessageId !== 'string' ||
        parentHeadMessageId.length === 0)) ||
    (sourceMessageIds !== undefined &&
      (!Array.isArray(sourceMessageIds) ||
        !sourceMessageIds.every(
          (id): id is string => typeof id === 'string' && id.trim().length > 0,
        ) ||
        new Set(sourceMessageIds).size !== sourceMessageIds.length))
  ) {
    throw new Error('spawn_agent: invalid persisted history-fork metadata');
  }
  return {
    forkTurns,
    parentChatId,
    parentHeadMessageId,
    ...(sourceMessageIds === undefined ? {} : { sourceMessageIds }),
  };
}

function isForkTurns(value: unknown): value is ForkTurns {
  return (
    value === 'none' ||
    value === 'all' ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmptyAssistantPlaceholder(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.role === 'assistant' &&
    Array.isArray(value.parts) &&
    value.parts.length === 0
  );
}

function arraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
