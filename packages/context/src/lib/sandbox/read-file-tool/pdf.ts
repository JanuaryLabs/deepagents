import { detectMediaType } from '@ai-sdk/provider-utils';

import { type FileFormat, attachment } from './format.ts';

const PDF_MAX_BYTES = 32 * 1024 * 1024;

export const pdfFileFormat = {
  read(input) {
    return detectMediaType({
      data: input.bytes,
      topLevelType: 'application',
    }) === 'application/pdf'
      ? attachment(input, {
          label: 'PDF',
          maxBytes: PDF_MAX_BYTES,
          mediaType: 'application/pdf',
        })
      : undefined;
  },
} satisfies FileFormat;
