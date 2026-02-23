export function truncate(str: string, maxLen = 80): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

export function generateFilename(
  name: string,
  runId: string,
  ext: string,
): string {
  const slug = name.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
  const prefix = runId.slice(0, 8);
  return `${slug}-${prefix}.${ext}`;
}

export function stringifyUnknown(
  value: unknown,
  options?: {
    space?: number;
    fallback?: string;
  },
): string {
  if (typeof value === 'string') return value;

  const space = options?.space ?? 0;
  const fallback = options?.fallback ?? 'null';
  try {
    return JSON.stringify(value, null, space) ?? fallback;
  } catch {
    return String(value);
  }
}

export function formatInputValue(value: unknown): string {
  return stringifyUnknown(value, { space: 0, fallback: '' });
}

export function formatErrorValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return stringifyUnknown(value, { space: 2, fallback: '' });
}

export function escapeCsv(value: unknown): string {
  const str = stringifyUnknown(value, { space: 0, fallback: 'null' });
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}
