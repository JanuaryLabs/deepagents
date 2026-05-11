import type { Text2SqlIndexProgressEvent } from '../../lib/adapter-index.ts';

export type VerboseFormat = 'pretty' | 'json';

const REDUNDANT_MESSAGE_TYPES = new Set<Text2SqlIndexProgressEvent['type']>([
  'adapter:start',
  'adapter:end',
]);

export function formatPretty(event: Text2SqlIndexProgressEvent): string {
  const head = event.adapter ? `${event.type} ${event.adapter}` : event.type;
  const parts = [`[${head}]`];
  if (event.phase) parts.push(`phase=${event.phase}`);
  if (event.table) parts.push(`table=${event.table}`);
  if (
    typeof event.current === 'number' &&
    typeof event.total === 'number' &&
    !event.type.endsWith(':start')
  ) {
    parts.push(`${event.current}/${event.total}`);
  }
  if (event.cached) parts.push('cached');
  if (!REDUNDANT_MESSAGE_TYPES.has(event.type)) parts.push(event.message);
  return parts.join(' ');
}
