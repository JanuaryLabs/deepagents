import { register } from 'node:module';

const hooks = `
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';

const TEXT_EXTENSIONS = new Set(['.sql', '.md', '.txt', '.html', '.graphql', '.gql']);

export async function load(url, context, nextLoad) {
  const ext = extname(new URL(url).pathname);
  if (TEXT_EXTENSIONS.has(ext)) {
    const content = await readFile(fileURLToPath(url), 'utf-8');
    return {
      format: 'module',
      shortCircuit: true,
      source: \`export default \${JSON.stringify(content)};\`,
    };
  }
  return nextLoad(url, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);
