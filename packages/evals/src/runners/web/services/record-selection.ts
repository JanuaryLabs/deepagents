export interface ParsedRecordSelection {
  indexes: Set<number>;
  normalized: string;
}

function parsePositiveInt(token: string): number {
  if (!/^\d+$/.test(token)) {
    throw new Error(`Invalid record token "${token}"`);
  }
  const value = Number(token);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Record numbers must be >= 1. Received "${token}"`);
  }
  return value;
}

export function parseRecordSelection(spec: string): ParsedRecordSelection {
  const trimmed = spec.trim();
  if (!trimmed) {
    return { indexes: new Set(), normalized: '' };
  }

  const indexes = new Set<number>();
  const parts = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Record selection is empty.');
  }

  for (const part of parts) {
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (rangeMatch) {
      const start = parsePositiveInt(rangeMatch[1]!);
      const end = parsePositiveInt(rangeMatch[2]!);
      if (end < start) {
        throw new Error(
          `Invalid range "${part}". Range end must be >= range start.`,
        );
      }
      for (let i = start; i <= end; i++) {
        indexes.add(i - 1);
      }
      continue;
    }

    const value = parsePositiveInt(part);
    indexes.add(value - 1);
  }

  return {
    indexes,
    normalized: Array.from(indexes)
      .sort((a, b) => a - b)
      .map((i) => String(i + 1))
      .join(','),
  };
}

export async function* filterRecordsByIndex<T>(
  source: AsyncIterable<T>,
  indexes: Set<number>,
): AsyncIterable<T> {
  if (indexes.size === 0) {
    for await (const item of source) {
      yield item;
    }
    return;
  }

  let idx = 0;
  for await (const item of source) {
    if (indexes.has(idx)) {
      yield item;
    }
    idx++;
  }
}
