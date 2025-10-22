import { titlecase } from 'stringcase';

import type { Agent } from './agent.ts';

export type VisualizeOptions = {
  direction?: 'LR' | 'TB' | 'BT' | 'RL';
  showTools?: boolean;
};

type Node = {
  id: string;
  name: string;
  tools: string[];
};

type Edge = {
  from: string; // node id
  to: string; // node id
  label: string; // e.g., transfer_to_X
};

/**
 * Build a minimal Mermaid flowchart to visualize agents, their local tools, and handoff transfers.
 *
 * - Agent nodes include their name and (optionally) their tool names.
 * - Edges represent transfer tools (handoffs) from one agent to another, labeled by the transfer tool name.
 */
export function visualizeMermaid(
  root: Agent<any>,
  options: VisualizeOptions = {},
): string {
  const { direction = 'LR', showTools = true } = options;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const seen = new Set<string>();
  const nameToId = new Map<string, string>();

  const sanitizeId = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/^_+|_+$/g, '');

  const ensureNode = (agent: Agent) => {
    const name = agent.handoff.name;
    if (!nameToId.has(name)) {
      // Guarantee unique ids even if sanitize collides
      const base = sanitizeId(name) || 'agent';
      let id = base;
      let i = 1;
      while (nodes.some((n) => n.id === id)) id = `${base}_${i++}`;
      nameToId.set(name, id);

      nodes.push({
        id,
        name,
        tools: Object.keys(agent.handoff.tools ?? {}),
      });
    }
    return nameToId.get(name)!;
  };

  const stack: Agent[] = [root];
  while (stack.length) {
    const current = stack.pop()!;
    const currentName = current.handoff.name;
    if (seen.has(currentName)) continue;
    seen.add(currentName);

    const fromId = ensureNode(current);

    for (const child of current.toHandoffs()) {
      const toId = ensureNode(child);
      // Prefer the child's declared handoff tool key (usually transfer_to_{childName})
      const label = Object.keys(child.handoffTool)[0].replace(
        /transfer_to_/g,
        '',
      );
      edges.push({ from: fromId, to: toId, label });
      stack.push(child);
    }
  }

  const lines: string[] = [];
  lines.push(`flowchart ${direction}`);

  // Nodes
  for (const n of nodes) {
    const name = titlecase(n.name.replace(/_agent/g, '').replace(/_/g, ' '));
    const toolLine =
      showTools && n.tools.length
        ? `<br/>tools: ${n.tools.map((it) => it.replace(/transfer_to_/g, '')).join(', ')}`
        : '';
    // Use double quotes for label to allow <br/>
    lines.push(`${n.id}["${escapeLabel(`Agent: ${name}${toolLine}`)}"]`);
  }

  // Edges
  for (const e of edges) {
    lines.push(`${e.from} -- ${escapeLabel(e.label)} --> ${e.to}`);
  }

  return lines.join('\n');
}

function escapeLabel(s: string): string {
  // Minimal escaping for quotes in Mermaid node labels
  return s.replace(/"/g, '\\"');
}

/**
 * Convenience alias with simpler name.
 */
export const visualize = visualizeMermaid;

/**
 * Produce a semantic, human-readable map of transfers between agents.
 * Example lines:
 *   supervisor transfers to: agentx, agenty
 *   agentx transfers to: supervisor
 */
export function visualizeSemantic(root: Agent): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const stack: Agent[] = [root];

  while (stack.length) {
    const current = stack.pop()!;
    const currentName = current.handoff.name;
    if (seen.has(currentName)) continue;
    seen.add(currentName);

    const from = current.handoff.name;
    const transfers = current.toHandoffs().map((h) => h.handoff.name);
    const uniqueTransfers = Array.from(new Set(transfers));
    const rhs = uniqueTransfers.length ? uniqueTransfers.join(', ') : 'none';
    lines.push(`${from} transfers to: ${rhs}`);

    for (const child of current.toHandoffs()) stack.push(child);
  }

  return lines.join('\n');
}

/**
 * Minimal arrow-based semantic visualizer.
 * Prints one line per transfer using Unicode arrows, e.g.:
 *   supervisor ──▶ agentx
 *   supervisor ──▶ agenty
 *   agentx ──▶ supervisor
 */
export function visualizeRichSemantic(root: Agent): string {
  const stack: Agent[] = [root];
  const seen = new Set<string>();
  const edgeSet = new Set<string>();
  const edges: Array<{ from: string; to: string }> = [];

  while (stack.length) {
    const current = stack.pop()!;
    const from = current.handoff.name;
    if (!seen.has(from)) {
      seen.add(from);
      for (const child of current.toHandoffs()) {
        const to = child.handoff.name;
        const key = `${from}->${to}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ from, to });
        }
        stack.push(child);
      }
    }
  }

  if (edges.length === 0) return `${root.handoff.name} ──▶ none`;
  return edges.map(({ from, to }) => `${from} ──▶ ${to}`).join('\n');
}
