import limit from 'p-limit';

import { repoTree } from './deepwiki/tools.ts';

export async function repoContext(repoPath: string) {
  const tree = await repoTree(repoPath);
  const limitConcurrency = limit(3);
}
