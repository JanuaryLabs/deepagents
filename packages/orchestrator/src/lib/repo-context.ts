import limit from 'p-limit';

import { repoTree } from '@deepagents/toolbox';

export async function repoContext(repoPath: string) {
  const tree = await repoTree(repoPath);
  const limitConcurrency = limit(3);
}
