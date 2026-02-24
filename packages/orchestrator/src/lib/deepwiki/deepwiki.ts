import { writeFile } from 'node:fs/promises';

import { repoTree } from '@deepagents/toolbox';

import { completeWiki } from './complete-wiki.ts';
import { type OutlineAgentContext } from './outline-agent.ts';

const state: OutlineAgentContext = {
  repo_path: '/Users/ezzabuzaid/Desktop/mo/cold-ambulance',
  // outline: [JSON.parse(await readFile('./outline.json', 'utf-8'))],
  outline: [
    {
      title: 'Project Overview',
      sections: [
        {
          title: 'Healthcare Platform Architecture',
          sections: [
            {
              title: 'Multi-Tenant Structure',
            },
            {
              title: 'Modular Monorepo Setup',
            },
          ],
        },
        {
          title: 'Technology Stack',
        },
        {
          title: 'Multi-Tenant Design',
          sections: [
            {
              title: 'Customer and Vendor Separation',
            },
            {
              title: 'Shared Resources',
            },
          ],
        },
        {
          title: 'API-First Approach',
        },
      ],
    },
  ],
  scratchpad: '## Scratchpad\n\n',
  tree: await repoTree('/Users/ezzabuzaid/Desktop/mo/cold-ambulance'),
};

// const outline = await generateOutline(state);

// await writeFile(
//   './outline_large.json',
//   JSON.stringify(state.outline, null, 2),
//   'utf-8',
// );
// await writeFile('./outline.json', JSON.stringify(outline, null, 2), 'utf-8');

// const finalDoc = await generateWiki({
//   repo_path: state.repo_path,
//   outline: state.outline,
//   tree: state.tree,
// });
// const finalDoc = await singlePageWiki({
//   repo_path: state.repo_path,
//   outline: state.outline,
//   tree: state.tree,
// });
// await writeFile('./wiki.md', finalDoc, 'utf-8');

const result = await completeWiki({
  repo_path: state.repo_path,
  outline: state.outline,
  tree: state.tree,
});

// Write index
await writeFile('docs/index.md', result.index, 'utf-8');

// All section files are already written to docs/
console.log('Generated files:', result.files);
