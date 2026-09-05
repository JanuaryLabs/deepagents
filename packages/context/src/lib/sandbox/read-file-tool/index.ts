import { type ToolExecutionOptions, tool } from 'ai';
import path from 'node:path';
import z from 'zod';

import type { DisposableSandbox, ReadFileTool } from '../types.ts';
import { binaryFileFormat } from './binary.ts';
import { type FileFormat } from './format.ts';
import { imageFileFormat } from './image.ts';
import { ooxmlFileFormat } from './ooxml.ts';
import { pdfFileFormat } from './pdf.ts';
import { textFileFormat } from './text.ts';

const formats = [
  imageFileFormat,
  pdfFileFormat,
  ooxmlFileFormat,
  binaryFileFormat,
  textFileFormat,
] satisfies readonly FileFormat[];

const inputSchema = z.strictObject({
  path: z.string().min(1).describe('The path to the file to read'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based line number to start at for text files'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Number of text lines to return from offset'),
});

export function createReadFileTool({
  sandbox,
  destination,
}: {
  sandbox: DisposableSandbox;
  destination: string;
}): ReadFileTool {
  return tool({
    description:
      'Read a sandbox file. Supports text, PNG, JPEG, GIF, WebP, PDF, XLSX, DOCX, and PPTX; other binary files such as HEIC, video, and audio are refused with conversion guidance. Use offset/limit with large text files.',
    inputExamples: [
      { input: { path: 'README.md' } },
      { input: { path: 'logs/trace.jsonl', offset: 1, limit: 200 } },
    ],
    inputSchema,
    execute: async (
      input,
      options: ToolExecutionOptions<Record<string, unknown>>,
    ) => {
      options.abortSignal?.throwIfAborted();
      const bytes = await sandbox.readFile(
        path.posix.resolve(destination, input.path),
        { encoding: 'binary' },
      );
      options.abortSignal?.throwIfAborted();

      for (const format of formats) {
        const result = format.read({ ...input, bytes, options });
        if (result !== undefined) return result;
      }

      throw new Error(`No file format accepted ${input.path}`);
    },
    toModelOutput: ({ output }) => output,
  });
}
