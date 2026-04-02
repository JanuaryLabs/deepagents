import { randomUUID } from 'node:crypto';

export function traceId(): string {
  return `trace_${randomUUID().replace(/-/g, '')}`;
}

export function spanId(): string {
  return `span_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function groupId(): string {
  return `group_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
