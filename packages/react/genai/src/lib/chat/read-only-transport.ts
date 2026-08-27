import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';

/**
 * Transport for surfaces that only render stored messages (shared transcripts,
 * fixtures). Sending from such a surface is a programming error, so it rejects
 * loudly instead of reaching for a network; there is never an active stream
 * to resume.
 */
export class ReadOnlyChatTransport implements ChatTransport<UIMessage> {
  sendMessages(): Promise<ReadableStream<UIMessageChunk>> {
    return Promise.reject(
      new Error(
        'This chat is read-only: it has no transport to send messages through.',
      ),
    );
  }

  reconnectToStream(): Promise<null> {
    return Promise.resolve(null);
  }
}
