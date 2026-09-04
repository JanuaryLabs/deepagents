import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import type { ToolExecutionOptions } from 'ai';
import path from 'node:path';

import type { ReadFileToolInput } from '../types.ts';

export interface FileFormatInput extends ReadFileToolInput {
  bytes: Uint8Array;
  options: ToolExecutionOptions<Record<string, unknown>>;
}

export interface FileFormat {
  read(input: FileFormatInput): ToolResultOutput | undefined;
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
    mediaType: string;
  },
): ToolResultOutput {
  input.options.abortSignal?.throwIfAborted();
  if (input.bytes.byteLength > maxBytes) {
    return {
      type: 'error-text',
      value: `${label} exceeds ${formatBytes(maxBytes)} limit (got ${formatBytes(input.bytes.byteLength)})`,
    };
  }
  return {
    type: 'content',
    value: [
      {
        type: 'file',
        data: {
          type: 'data',
          data: Buffer.from(input.bytes).toString('base64'),
        },
        mediaType,
        filename: path.posix.basename(input.path),
      },
    ],
  };
}
