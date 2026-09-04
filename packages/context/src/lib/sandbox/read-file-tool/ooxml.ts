import { extname } from 'node:path';

import type { ReadFileMediaType } from '../types.ts';
import { type FileFormat, attachment } from './format.ts';

const OFFICE_MAX_BYTES = 50 * 1024 * 1024;
const mediaTypeByExtension: Partial<Record<string, ReadFileMediaType>> = {
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function hasZipSignature(bytes: Uint8Array): boolean {
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

export const ooxmlFileFormat = {
  read(input) {
    if (!hasZipSignature(input.bytes)) return undefined;
    const mediaType = mediaTypeByExtension[extname(input.path).toLowerCase()];
    return mediaType
      ? attachment(input, {
          label: 'Office file',
          maxBytes: OFFICE_MAX_BYTES,
          mediaType,
        })
      : undefined;
  },
} satisfies FileFormat;
