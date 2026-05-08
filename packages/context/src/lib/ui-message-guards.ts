import type { UIMessage } from 'ai';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUIMessage(value: unknown): value is UIMessage {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'system' ||
      value.role === 'user' ||
      value.role === 'assistant') &&
    Array.isArray(value.parts)
  );
}

export function isUserUIMessage(
  value: unknown,
): value is UIMessage & { role: 'user' } {
  return isUIMessage(value) && value.role === 'user';
}

export function requireUIMessage(value: unknown, source: string): UIMessage {
  if (isUIMessage(value)) {
    return value;
  }
  throw new Error(`${source} is not a UIMessage`);
}

export function requireUserUIMessage(
  value: unknown,
  source: string,
): UIMessage & { role: 'user' } {
  if (isUserUIMessage(value)) {
    return value;
  }
  throw new Error(`${source} is not a user UIMessage`);
}
