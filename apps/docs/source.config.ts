import type { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { type DocsCollection, defineDocs } from 'fumadocs-mdx/config';

export const docs: DocsCollection<typeof pageSchema, typeof metaSchema> =
  defineDocs({
    dir: './app/docs',
  });
