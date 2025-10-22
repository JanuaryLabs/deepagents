import type { Outline } from './deepwiki/outline-agent.ts';

type WithParent = {
  title: string;
  parent?: WithParent;
  sections?: WithParent[];
};

function flat(item: WithParent) {
  const paths: string[][] = [];
  if (!item.sections || item.sections.length === 0) {
    let current: WithParent | undefined = item;
    const path: string[] = [];
    while (current.parent) {
      current = current.parent;
      path.unshift(current.title);
    }
    path.push(item.title);
    paths.push(path);
    return paths;
  }
  for (const section of item.sections) {
    paths.push(...flat({ ...section, parent: item }));
  }
  return paths;
}

export async function fold(
  item: Outline[number],
  parent: Outline[number],
  write: (section: Outline[number]) => Promise<string>,
  store: {
    set: (key: string, value: string) => Promise<void>;
  },
) {
  const sections = item.sections || [];
  for (const section of sections) {
    await fold(section, item, write, store);
  }
  await store.set(item.title, await write(item));
}
