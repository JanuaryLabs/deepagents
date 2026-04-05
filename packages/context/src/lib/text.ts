import { type UIMessage, isTextUIPart } from 'ai';

export function getTextParts(message: UIMessage): string[] {
  return message.parts.filter(isTextUIPart).map((part) => part.text);
}

export function extractPlainText(message: UIMessage): string {
  return getTextParts(message).join(' ');
}
