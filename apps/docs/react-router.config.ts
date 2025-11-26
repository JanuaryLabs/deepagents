import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '@react-router/dev/config';

function getDocUrls(dir: string, baseUrl = '/docs'): string[] {
  const urls: string[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      urls.push(...getDocUrls(fullPath, `${baseUrl}/${entry}`));
    } else if (entry.endsWith('.mdx')) {
      // index.mdx -> parent directory URL, other.mdx -> /other
      const name = entry.replace('.mdx', '');
      urls.push(name === 'index' ? baseUrl : `${baseUrl}/${name}`);
    }
  }

  return urls;
}

export default {
  ssr: false,
  buildDirectory: 'dist',
  basename: '/deepagents/',
  async prerender() {
    const docsDir = join(import.meta.dirname, 'app/docs');
    const docUrls = getDocUrls(docsDir);

    return ['/', '/api/search', ...docUrls];
  },
} satisfies Config;
