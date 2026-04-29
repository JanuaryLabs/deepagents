import type { CommandResult } from 'bash-tool';

export function formatResponse(value: unknown): CommandResult {
  const payload = unwrapApiResponse(value);
  if (Array.isArray(payload)) {
    const stdout =
      payload.length === 0
        ? ''
        : payload.map((item) => JSON.stringify(item)).join('\n') + '\n';
    return { stdout, stderr: '', exitCode: 0 };
  }
  return { stdout: JSON.stringify(payload) + '\n', stderr: '', exitCode: 0 };
}

function unwrapApiResponse(value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    'status' in value &&
    'data' in value
  ) {
    return (value as { data: unknown }).data;
  }
  return value;
}

export interface ErrorDetails {
  group: string;
  operation?: string;
  code: string;
  message: string;
  extra?: Record<string, unknown>;
}

export function formatError(details: ErrorDetails): CommandResult {
  const payload: Record<string, unknown> = { ...(details.extra ?? {}) };
  payload.ok = false;
  payload.group = details.group;
  payload.code = details.code;
  payload.message = details.message;
  if (details.operation) payload.operation = details.operation;
  return {
    stdout: '',
    stderr: JSON.stringify(payload) + '\n',
    exitCode: 1,
  };
}
