import type { ToolExecutionOptions } from 'ai';

import type {
  ReadFileMediaType,
  ReadFileToolInput,
  ReadFileToolResult,
} from '../types.ts';

export interface FileFormatInput extends ReadFileToolInput {
  bytes: Uint8Array;
  options: ToolExecutionOptions<Record<string, unknown>>;
}

export interface FileFormat {
  read(input: FileFormatInput): ReadFileToolResult | undefined;
}

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function attachment(
  input: FileFormatInput,
  {
    label,
    maxBytes,
    mediaType,
  }: {
    label: string;
    maxBytes: number;
    mediaType: ReadFileMediaType;
  },
): ReadFileToolResult {
  input.options.abortSignal?.throwIfAborted();
  if (input.bytes.byteLength > maxBytes) {
    return {
      error: `${label} exceeds ${formatBytes(maxBytes)} limit (got ${formatBytes(input.bytes.byteLength)})`,
    };
  }
  return {
    mediaType,
    base64: Buffer.from(input.bytes).toString('base64'),
  };
}
