import { detectMediaType } from '@ai-sdk/provider-utils';
import path from 'node:path';

import type { FileFormat } from './format.ts';

const SNIFF_BYTES = 8 * 1024;
const NUL = 0;
const mediaKinds = new Set(['image', 'video', 'audio']);

/**
 * Bytes no earlier format claimed but that are not text either: stills the
 * model cannot view (HEIC), video, audio, or anything with a NUL byte up
 * front. Refusing here keeps decoded garbage out of the prompt and tells the
 * model how to turn the file into something readFile does render.
 */
export const binaryFileFormat = {
  read({ bytes, path: filePath, options }) {
    options.abortSignal?.throwIfAborted();
    const mediaType = detectMediaType({ data: bytes });
    const kind = mediaType?.split('/')[0];
    const binary =
      (kind !== undefined && mediaKinds.has(kind)) ||
      bytes.subarray(0, SNIFF_BYTES).includes(NUL);
    if (!binary) return undefined;
    return {
      type: 'error-text',
      value: `${path.posix.basename(filePath)} is a binary ${mediaType ?? 'file'} that readFile cannot display. Convert it in the sandbox first and read the result: HEIC stills with \`heif-dec in.heic out.jpg\`, video frames with \`ffmpeg -i in.mov -frames:v 1 frame.jpg\`, audio through a transcript or metadata tool. UTF-16 text counts as binary too; re-encode it as UTF-8.`,
    };
  },
} satisfies FileFormat;
