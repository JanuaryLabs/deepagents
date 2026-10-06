import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';

export { downloadHf, fetchHfRows, hf } from './hf.ts';
export type { HfOptions } from './hf.ts';

export {
  filterRecordsByIndex,
  parseRecordSelection,
  pickFromArray,
} from './record-selection.ts';
export type { ParsedRecordSelection } from './record-selection.ts';

export type TransformFn<T, U> = (item: T) => U;
export type PredicateFn<T> = (item: T) => boolean;

export class Dataset<T> implements AsyncIterable<T> {
  #source: () => AsyncIterable<T>;

  constructor(source: () => AsyncIterable<T>) {
    this.#source = source;
  }

  map<U>(fn: TransformFn<T, U>): Dataset<U> {
    const source = this.#source;
    return new Dataset(async function* () {
      for await (const item of source()) {
        yield fn(item);
      }
    });
  }

  filter(fn: PredicateFn<T>): Dataset<T> {
    const source = this.#source;
    return new Dataset(async function* () {
      for await (const item of source()) {
        if (fn(item)) yield item;
      }
    });
  }

  limit(n: number): Dataset<T> {
    const source = this.#source;
    return new Dataset(async function* () {
      let count = 0;
      for await (const item of source()) {
        if (count >= n) return;
        yield item;
        count++;
      }
    });
  }

  shuffle(): Dataset<T> {
    const source = this.#source;
    return new Dataset(async function* () {
      const items: T[] = [];
      for await (const item of source()) {
        items.push(item);
      }
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = items[i];
        items[i] = items[j];
        items[j] = temp;
      }
      yield* items;
    });
  }

  sample(n: number): Dataset<T> {
    const source = this.#source;
    return new Dataset(async function* () {
      const items: T[] = [];
      for await (const item of source()) {
        items.push(item);
      }
      const count = Math.min(Math.max(0, n), items.length);
      for (let i = items.length - 1; i > items.length - count - 1; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = items[i];
        items[i] = items[j];
        items[j] = temp;
      }
      for (let i = items.length - count; i < items.length; i++) {
        yield items[i]!;
      }
    });
  }

  pick(indexes: Set<number>): Dataset<T> {
    const source = this.#source;
    return new Dataset(async function* () {
      if (indexes.size === 0) {
        yield* source();
        return;
      }
      let idx = 0;
      for await (const item of source()) {
        if (indexes.has(idx)) {
          yield item;
        }
        idx++;
      }
    });
  }

  async toArray(): Promise<T[]> {
    const result: T[] = [];
    for await (const item of this.#source()) {
      result.push(item);
    }
    return result;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.#source()[Symbol.asyncIterator]();
  }
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"' && current === '') {
        inQuotes = true;
      } else if (char === ',') {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current);
  return fields;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadJSON(
  filePath: string,
): () => AsyncIterable<Record<string, unknown>> {
  return async function* () {
    const content = await readFile(filePath, 'utf-8');
    const data: unknown = JSON.parse(content);
    if (!Array.isArray(data)) {
      throw new Error(`JSON file "${filePath}" does not contain an array`);
    }
    for (const [index, row] of data.entries()) {
      if (!isRecord(row)) {
        throw new Error(
          `JSON file "${filePath}" has a non-object row at index ${index}`,
        );
      }
      yield row;
    }
  };
}

function loadJSONL(
  filePath: string,
): () => AsyncIterable<Record<string, unknown>> {
  return async function* () {
    const rl = createInterface({
      input: createReadStream(filePath, 'utf-8'),
      crlfDelay: Infinity,
    });
    try {
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const row: unknown = JSON.parse(trimmed);
        if (!isRecord(row)) {
          throw new Error(
            `JSONL file "${filePath}" has a non-object row: ${trimmed.slice(0, 200)}`,
          );
        }
        yield row;
      }
    } finally {
      rl.close();
    }
  };
}

function loadCSV(
  filePath: string,
): () => AsyncIterable<Record<string, string>> {
  return async function* () {
    const rl = createInterface({
      input: createReadStream(filePath, 'utf-8'),
      crlfDelay: Infinity,
    });
    try {
      let headers: string[] | undefined;
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const fields = parseCSVLine(trimmed);
        if (!headers) {
          headers = fields;
          continue;
        }
        const row: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
          row[headers[i]!] = fields[i] ?? '';
        }
        yield row;
      }
    } finally {
      rl.close();
    }
  };
}

/**
 * Builds a dataset from in-memory items, an async source, or a JSON, JSONL or
 * CSV file. A file's rows must be objects; CSV cells are strings.
 */
export function dataset<T>(source: T[] | AsyncIterable<T>): Dataset<T>;
export function dataset(source: string): Dataset<Record<string, unknown>>;
export function dataset<T>(
  source: T[] | AsyncIterable<T> | string,
): Dataset<T> | Dataset<Record<string, unknown>> {
  if (Array.isArray(source)) {
    return new Dataset(async function* () {
      yield* source;
    });
  }

  if (typeof source === 'object' && Symbol.asyncIterator in source) {
    return new Dataset(() => source);
  }

  const ext = extname(source).toLowerCase();
  switch (ext) {
    case '.json':
      return new Dataset(loadJSON(source));
    case '.jsonl':
      return new Dataset(loadJSONL(source));
    case '.csv':
      return new Dataset(loadCSV(source));
    default:
      throw new Error(
        `Unsupported file extension "${ext}" for dataset file "${source}". Supported: .json, .jsonl, .csv`,
      );
  }
}
