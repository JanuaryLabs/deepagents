const CANVAS_EXPORT_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

export interface PrepareImageOptions {
  /** Longest edge allowed before the image is scaled down. */
  maxDimension?: number;
}

/**
 * Downscale an image to `maxDimension` on its long side and re-encode formats
 * the model cannot ingest. Browsers without canvas decoding return the file
 * untouched so the server stays the authority on what it accepts.
 */
export async function prepareImageFile(
  file: File,
  { maxDimension = 2048 }: PrepareImageOptions = {},
): Promise<File> {
  const context = canvasContext();
  if (!context || typeof createImageBitmap !== 'function') {
    return file;
  }
  const bitmap = await createImageBitmap(file);
  try {
    const longSide = Math.max(bitmap.width, bitmap.height);
    const exportable = CANVAS_EXPORT_EXTENSIONS.has(file.type);
    if (exportable && longSide <= maxDimension) {
      return file;
    }
    const scale = Math.min(1, maxDimension / longSide);
    const { canvas } = context;
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await encode(canvas, exportable ? file.type : 'image/png');
    return new File([blob], fileNameFor(file, blob.type), {
      type: blob.type,
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}

function canvasContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  return document.createElement('canvas').getContext('2d');
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error(`Could not encode image as ${type}`));
      }
    }, type);
  });
}

function fileNameFor(file: File, type: string): string {
  if (type === file.type) return file.name;
  const extension = CANVAS_EXPORT_EXTENSIONS.get(type) ?? 'png';
  const stem = file.name.replace(/\.[^./\\]+$/, '');
  return `${stem || 'image'}.${extension}`;
}
