import type { GraphData, GraphNode } from './store/store.ts';

/**
 * Render a graph as ASCII art.
 *
 * @param data - The graph data to visualize
 * @returns ASCII art representation of the graph
 *
 * @example
 * ```ts
 * const graph = await store.getGraph('my-chat');
 * console.log(visualizeGraph(graph));
 * ```
 */
export function visualizeGraph(data: GraphData): string {
  if (data.nodes.length === 0) {
    return `[chat: ${data.chatId}]\n\n(empty)`;
  }

  // Build lookup maps
  const childrenByParentId = new Map<string | null, GraphNode[]>();
  const branchHeads = new Map<string, string[]>(); // messageId -> branch names
  const checkpointsByMessageId = new Map<string, string[]>(); // messageId -> checkpoint names

  for (const node of data.nodes) {
    const children = childrenByParentId.get(node.parentId) ?? [];
    children.push(node);
    childrenByParentId.set(node.parentId, children);
  }

  for (const branch of data.branches) {
    if (branch.headMessageId) {
      const heads = branchHeads.get(branch.headMessageId) ?? [];
      heads.push(branch.isActive ? `${branch.name} *` : branch.name);
      branchHeads.set(branch.headMessageId, heads);
    }
  }

  for (const checkpoint of data.checkpoints) {
    const cps = checkpointsByMessageId.get(checkpoint.messageId) ?? [];
    cps.push(checkpoint.name);
    checkpointsByMessageId.set(checkpoint.messageId, cps);
  }

  // Find root nodes (parentId === null)
  const roots = childrenByParentId.get(null) ?? [];

  const lines: string[] = [`[chat: ${data.chatId}]`, ''];

  // Recursively render the tree
  function renderNode(
    node: GraphNode,
    prefix: string,
    isLast: boolean,
    isRoot: boolean,
  ): void {
    const connector = isRoot ? '' : isLast ? '└── ' : '├── ';
    const roleLabel = node.deleted ? `~${node.role}~` : node.role;
    const contentPreview = node.content.replace(/\n/g, ' ');

    let line = `${prefix}${connector}${node.id.slice(0, 8)} (${roleLabel}): "${contentPreview}"`;

    // Add branch markers
    const branches = branchHeads.get(node.id);
    if (branches) {
      line += ` <- [${branches.join(', ')}]`;
    }

    // Add checkpoint markers
    const checkpoints = checkpointsByMessageId.get(node.id);
    if (checkpoints) {
      line += ` {${checkpoints.join(', ')}}`;
    }

    lines.push(line);

    // Render children
    const children = childrenByParentId.get(node.id) ?? [];
    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');

    for (let i = 0; i < children.length; i++) {
      renderNode(children[i], childPrefix, i === children.length - 1, false);
    }
  }

  // Render each root
  for (let i = 0; i < roots.length; i++) {
    renderNode(roots[i], '', i === roots.length - 1, true);
  }

  // Add legend
  lines.push('');
  lines.push('Legend: * = active branch, ~role~ = deleted, {...} = checkpoint');

  return lines.join('\n');
}
