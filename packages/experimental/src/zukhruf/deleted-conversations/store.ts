/**
 * The tombstones of deleted chats. Chat ids are client-minted, so without
 * them a stale tab's request would create a fresh, empty session or sandbox
 * under a deleted id; with them a deleted id stays refused, for every user,
 * as Codex never returns a deleted thread.
 */
export abstract class DeletedConversationStore {
  /** Whether a chat with this id was deleted, whoever owned it. */
  abstract has(chatId: string): Promise<boolean>;

  /** Records that the chat with this id was deleted at `deletedAt`, keeping an earlier record; its owner is not kept. */
  abstract add(chatId: string, deletedAt: number): Promise<void>;
}

/** The tombstones as read outside an admission, which only an admission writes. */
export type DeletedConversations = Pick<DeletedConversationStore, 'has'>;
