import { createContext } from 'react';

/**
 * True under a `ChatBot`, whose MessageScroller needs the message list as its
 * content and each message as an item. Messages rendered anywhere else stay
 * plain blocks.
 */
export const ChatBotScrollerContext = createContext(false);
