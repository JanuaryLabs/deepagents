import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.html', '.graphql', '.gql']);

registerHooks({
  load(url, context, nextLoad) {
    const ext = extname(new URL(url).pathname);
    if (TEXT_EXTENSIONS.has(ext)) {
      const content = readFileSync(fileURLToPath(url), 'utf-8');
      return {
        format: 'module',
        shortCircuit: true,
        source: `export default ${JSON.stringify(content)};`,
      };
    }
    return nextLoad(url, context);
  },
});
