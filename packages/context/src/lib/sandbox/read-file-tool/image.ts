import { detectMediaType } from '@ai-sdk/provider-utils';

import { READ_FILE_MEDIA_TYPES, type ReadFileMediaType } from '../types.ts';
import { type FileFormat, attachment } from './format.ts';

const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const supportedImageMediaTypes = new Set<string>(
  READ_FILE_MEDIA_TYPES.filter((mediaType) => mediaType.startsWith('image/')),
);

function isSupportedImageMediaType(
  mediaType: string,
): mediaType is ReadFileMediaType {
  return supportedImageMediaTypes.has(mediaType);
}

export const imageFileFormat = {
  read(input) {
    const mediaType = detectMediaType({
      data: input.bytes,
      topLevelType: 'image',
    });
    return mediaType && isSupportedImageMediaType(mediaType)
      ? attachment(input, {
          label: 'Image',
          maxBytes: IMAGE_MAX_BYTES,
          mediaType,
        })
      : undefined;
  },
} satisfies FileFormat;
