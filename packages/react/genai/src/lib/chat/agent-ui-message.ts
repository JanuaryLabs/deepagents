import type { UIMessage } from 'ai';

import type { ChatDataTypes } from '@deepagents/context';

/** The messages a Zukhruf chat streams, typed with the data parts `chat()` writes. */
export type AgentUIMessage = UIMessage<unknown, ChatDataTypes>;
