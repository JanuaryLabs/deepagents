import { type ToolExecutionOptions, tool } from 'ai';
import path from 'node:path';
import z from 'zod';

import { READ_FILE_MEDIA_TYPES } from '../types.ts';
import type {
  DisposableSandbox,
  ReadFileTool,
  ReadFileToolInput,
  ReadFileToolResult,
} from '../types.ts';
import { type FileFormat } from './format.ts';
import { imageFileFormat } from './image.ts';
import { ooxmlFileFormat } from './ooxml.ts';
import { pdfFileFormat } from './pdf.ts';
import { textFileFormat } from './text.ts';

const formats = [
  imageFileFormat,
  pdfFileFormat,
  ooxmlFileFormat,
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

const outputSchema: z.ZodType<ReadFileToolResult> = z.union([
  z.strictObject({ content: z.string() }),
  z.strictObject({
    mediaType: z.enum(READ_FILE_MEDIA_TYPES),
    base64: z.string(),
  }),
  z.strictObject({ error: z.string() }),
]);

export function createReadFileTool({
  sandbox,
  destination,
}: {
  sandbox: DisposableSandbox;
  destination: string;
}): ReadFileTool {
  return tool({
    description:
      'Read a sandbox file. Supports text, PNG, JPEG, GIF, WebP, PDF, XLSX, DOCX, and PPTX. Use offset/limit with large text files.',
    inputExamples: [
      { input: { path: 'README.md' } },
      { input: { path: 'logs/trace.jsonl', offset: 1, limit: 200 } },
    ],
    inputSchema,
    outputSchema,
    execute: async (
      input: ReadFileToolInput,
      options: ToolExecutionOptions<Record<string, unknown>>,
    ): Promise<ReadFileToolResult> => {
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
    toModelOutput: ({ input, output }) => {
      if ('error' in output) {
        return { type: 'error-text', value: output.error };
      }
      return 'base64' in output
        ? {
            type: 'content',
            value: [
              {
                type: 'file',
                data: { type: 'data', data: output.base64 },
                mediaType: output.mediaType,
                filename: path.posix.basename(input.path),
              },
            ],
          }
        : { type: 'json', value: output };
    },
  });
}
