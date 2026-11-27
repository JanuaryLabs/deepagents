import { ReadOnlyChatTransport } from '../lib/chat/read-only-transport.ts';

/** A read-only chat transport that an AgentProvider accepts: it sends nothing, stores no files and runs no turn to cancel. */
export class StoredMessagesTransport extends ReadOnlyChatTransport {
  uploadFile(): Promise<never> {
    return Promise.reject(new Error('This chat stores no files.'));
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}
