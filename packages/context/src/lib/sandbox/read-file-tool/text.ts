import { readFileContent } from '../read-file.ts';
import { type FileFormat, formatBytes } from './format.ts';

const TEXT_MAX_BYTES = 10 * 1024 * 1024;

export const textFileFormat = {
  read({ bytes, limit, offset, options }) {
    options.abortSignal?.throwIfAborted();
    if (
      offset === undefined &&
      limit === undefined &&
      bytes.byteLength > TEXT_MAX_BYTES
    ) {
      return {
        type: 'error-text',
        value: `Text file exceeds ${formatBytes(TEXT_MAX_BYTES)} limit (got ${formatBytes(bytes.byteLength)}). Use offset/limit to slice.`,
      };
    }

    const content = readFileContent(bytes, { encoding: 'utf-8' });
    if (offset === undefined && limit === undefined) {
      return { type: 'text', value: content };
    }

    const start = (offset ?? 1) - 1;
    const end = limit === undefined ? undefined : start + limit;
    return {
      type: 'text',
      value: content
        .split(/\r\n|\n|\r/u)
        .slice(start, end)
        .join('\n'),
    };
  },
} satisfies FileFormat;
