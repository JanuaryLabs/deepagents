import type { ChatStatus, UIMessage } from 'ai';
import { isReasoningUIPart, isTextUIPart, isToolUIPart } from 'ai';

export function thinking(status: ChatStatus, message: UIMessage) {
  if (status === 'error' || status === 'ready') {
    return null;
  }
  if (!message) {
    return null;
  }
  if (message.role !== 'assistant') {
    return 'Thinking...';
  }
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i];
    if (
      isTextUIPart(part) &&
      part.text &&
      part.providerMetadata?.openai?.phase === 'commentary'
    ) {
      return part.text;
    }
  }
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const lastPart = message.parts[i];
    if (isReasoningUIPart(lastPart) && lastPart.text) {
      return lastPart.text;
    }
    if (isToolUIPart(lastPart)) {
      if (lastPart.input) {
        const input = lastPart.input as Record<string, unknown>;
        const candidates = ['reasoning', 'thoughts', 'thought', 'hint'];
        for (const candidate of candidates) {
          const value = input[candidate];
          if (typeof value === 'string' && value.length > 0) {
            return value;
          }
        }
      }
      return lastPart.toolCallId;
    }
    if (isTextUIPart(lastPart) && lastPart.text) {
      return '';
    }
  }
  return 'Thinking...';
}
