import type { ModelMessage } from 'ai';

/** Media and opaque provider parts must stay verbatim; a text summary cannot preserve them. */
function hasOpaqueContent(message: ModelMessage): boolean {
  if (typeof message.content === 'string') return false;
  return message.content.some((part) => {
    switch (part.type) {
      case 'text':
      case 'reasoning':
      case 'tool-call':
      case 'tool-approval-request':
      case 'tool-approval-response':
        return false;
      case 'tool-result':
        return (
          part.output.type === 'content' &&
          part.output.value.some((value) => value.type !== 'text')
        );
      default:
        return true;
    }
  });
}

/** Text estimate only. Provider framing and tokenization can differ. */
export function estimateTokens(messages: readonly ModelMessage[]): number {
  if (messages.some(hasOpaqueContent)) {
    throw new TypeError(
      'compact: provide countTokens for messages containing media or opaque provider content.',
    );
  }
  // ponytail: character heuristic; supply countTokens for model-specific counting.
  return messages.length === 0
    ? 0
    : Math.ceil(JSON.stringify(messages).length / 4);
}

/** Select one contiguous, completed prefix, leaving protected messages untouched. */
export function replacementRange(
  messages: readonly ModelMessage[],
  keepLastMessages: number,
): { start: number; end: number } | undefined {
  let start = 0;
  while (messages[start]?.role === 'system') start++;

  let limit = messages.length - keepLastMessages;

  // A link spans all messages participating in a tool call or approval. Open
  // links pin their first message; closed links cannot straddle the cut.
  const links = new Map<
    string,
    { first: number; last: number; open: boolean }
  >();
  const link = (key: string, index: number, open?: boolean) => {
    const previous = links.get(key);
    links.set(key, {
      first: previous?.first ?? index,
      last: index,
      open: open ?? previous?.open ?? false,
    });
  };

  for (const [index, message] of messages.entries()) {
    if (
      (index >= start && message.role === 'system') ||
      hasOpaqueContent(message)
    ) {
      limit = Math.min(limit, index);
    }
    if (typeof message.content === 'string') continue;
    for (const part of message.content) {
      switch (part.type) {
        case 'tool-call':
          link(`tool:${part.toolCallId}`, index, true);
          break;
        case 'tool-result':
          link(`tool:${part.toolCallId}`, index, false);
          break;
        case 'tool-approval-request':
          link(`tool:${part.toolCallId}`, index);
          link(`approval:${part.approvalId}`, index, true);
          break;
        case 'tool-approval-response':
          link(`approval:${part.approvalId}`, index, false);
          break;
        default:
          break;
      }
    }
  }

  // Difference array marks unsafe boundaries in O(messages + links), including
  // overlapping parallel tool calls and approvals spanning several messages.
  const crossings = new Int32Array(messages.length + 1);
  for (const { first, last, open } of links.values()) {
    if (open) limit = Math.min(limit, first);
    crossings[first + 1]++;
    crossings[last + 1]--;
  }
  let crossingCount = 0;
  let end = start;
  for (let index = 0; index <= limit; index++) {
    crossingCount += crossings[index];
    if (index > start && crossingCount === 0) end = index;
  }
  return end > start ? { start, end } : undefined;
}
