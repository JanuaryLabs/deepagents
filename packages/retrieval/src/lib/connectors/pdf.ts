import { glob, readFile } from 'node:fs/promises';

import { extractText, getDocumentProxy } from 'unpdf';

import type { Connector } from './connector.js';

export function pdf(pattern: string): Connector {
  const sourceId = `pdf:${pattern}`;

  return {
    sourceId,
    sources: async function* () {
      const paths = await Array.fromAsync(
        glob(pattern, { exclude: ['**/node_modules/**', '**/.git/**'] }),
      );
      for (const path of paths) {
        if (!path.toLowerCase().endsWith('.pdf')) continue;
        yield {
          id: path,
          content: async () => {
            const buffer = await readFile(path);
            const pdf = await getDocumentProxy(new Uint8Array(buffer));
            const { text } = await extractText(pdf, { mergePages: true });
            return text;
          },
        };
      }
    },
  };
}

export function pdfFile(source: string): Connector {
  const isUrl = /^https?:\/\//.test(source);
  const sourceId = `pdf:${isUrl ? 'url' : 'file'}:${source}`;

  return {
    sourceId,
    sources: async function* () {
      yield {
        id: source,
        content: async () => {
          let buffer: Uint8Array;

          if (isUrl) {
            const response = await fetch(source);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            buffer = new Uint8Array(await response.arrayBuffer());
          } else {
            const fileBuffer = await readFile(source);
            buffer = new Uint8Array(fileBuffer.buffer);
          }

          const pdf = await getDocumentProxy(new Uint8Array(buffer));
          const { text } = await extractText(pdf, { mergePages: true });
          return text;
        },
      };
    },
  };
}
