import type { UIMessage } from 'ai';

export interface Message {
  id: string;
  chatId: string;
  role: string;
  createdAt: string | Date;
  content: UIMessage;
}

export interface Chat {
  id: string;
  userId: string;
  title?: string | null;
  messages: Message[];
}

export interface CreateChatParams {
  id: string;
  userId: string;
  title?: string;
}

export interface UpdateChatParams {
  title?: string;
}

export interface CreateMessageParams {
  id: string;
  chatId: string;
  role: string;
  content: UIMessage;
  createdAt?: Date;
}

export abstract class History {
  abstract listChats(userId: string): Promise<Chat[]>;
  abstract getChat(chatId: string): Promise<Chat | null>;
  abstract createChat(chat: CreateChatParams): Promise<Chat>;
  abstract upsertChat(chat: CreateChatParams): Promise<Chat>;
  abstract deleteChat(chatId: string): Promise<void>;
  abstract updateChat(chatId: string, updates: UpdateChatParams): Promise<void>;
  abstract addMessage(message: CreateMessageParams): Promise<void>;
  abstract upsertMessage(message: CreateMessageParams): Promise<Message>;
  abstract deleteMessage(messageId: string): Promise<void>;
}
