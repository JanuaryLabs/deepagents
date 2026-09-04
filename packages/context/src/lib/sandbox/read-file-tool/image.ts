import { detectMediaType } from '@ai-sdk/provider-utils';

import { type FileFormat, attachment } from './format.ts';

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const supportedImageMediaTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

export const imageFileFormat = {
  read(input) {
    const mediaType = detectMediaType({
      data: input.bytes,
      topLevelType: 'image',
    });
    return mediaType && supportedImageMediaTypes.has(mediaType)
      ? attachment(input, {
          label: 'Image',
          maxBytes: IMAGE_MAX_BYTES,
          mediaType,
        })
      : undefined;
  },
} satisfies FileFormat;
