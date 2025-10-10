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

// ---------- V2: ELK.js layered layout + ASCII renderer ----------

type SimpleNode = { id: string; label: string };
type SimpleEdge = { from: string; to: string };

function collectGraph(root: Agent): {
  nodes: SimpleNode[];
  edges: SimpleEdge[];
} {
  const nodes: SimpleNode[] = [];
  const edges: SimpleEdge[] = [];
  const seen = new Set<string>();
  const edgeSet = new Set<string>();
  const stack: Agent[] = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    const id = cur.handoff.name;
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ id, label: id });
      for (const child of cur.toHandoffs()) {
        const to = child.handoff.name;
        const key = `${id}->${to}`;
        if (!edgeSet.has(key)) {
          edgeSet.add(key);
          edges.push({ from: id, to });
        }
        stack.push(child);
      }
    }
  }
  return { nodes, edges };
}

function boxSizeForLabel(label: string) {
  const textWidth = Math.max(4, Math.min(24, label.length + 2));
  const width = textWidth;
  const height = 3; // top border, label, bottom border
  return { width, height };
}

function drawAsciiDiagram(
  layout: {
    nodes: Array<{
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      label: string;
    }>;
    edges: Array<{
      points: Array<{ x: number; y: number }>;
      from: string;
      to: string;
    }>;
  },
  options: { padding?: number; maxCols?: number; maxRows?: number } = {},
): string {
  const padding = options.padding ?? 1;
  const desiredCols =
    options.maxCols ??
    Math.max(60, Math.min(process.stdout.columns ?? 100, 140));
  const desiredRows = options.maxRows ?? 40;

  // Compute bounds
  const rawNodes = layout.nodes;
  const rawEdges = layout.edges;
  const minX = Math.min(
    0,
    ...rawNodes.map((n) => n.x),
    ...rawEdges.flatMap((e) => e.points.map((p) => p.x)),
  );
  const minY = Math.min(
    0,
    ...rawNodes.map((n) => n.y),
    ...rawEdges.flatMap((e) => e.points.map((p) => p.y)),
  );
  const maxX =
    Math.max(
      1,
      ...rawNodes.map((n) => n.x + n.width),
      ...rawEdges.flatMap((e) => e.points.map((p) => p.x)),
    ) - minX;
  const maxY =
    Math.max(
      1,
      ...rawNodes.map((n) => n.y + n.height),
      ...rawEdges.flatMap((e) => e.points.map((p) => p.y)),
    ) - minY;

  // Determine scaling to fit into terminal
  const innerCols = Math.max(10, desiredCols - padding * 2 - 2);
  const innerRows = Math.max(10, desiredRows - padding * 2 - 2);
  const scaleX = Math.min(1, innerCols / maxX);
  const scaleY = Math.min(1, innerRows / maxY);

  const rows = Math.ceil(maxY * scaleY) + padding * 2 + 2;
  const cols = Math.ceil(maxX * scaleX) + padding * 2 + 2;
  const grid: string[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(' '),
  );

  function put(r: number, c: number, ch: string) {
    if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch;
  }

  // Draw edges as polylines with simple chars (first, so nodes overwrite lines)
  function drawSegment(r1: number, c1: number, r2: number, c2: number) {
    if (r1 === r2) {
      const [cStart, cEnd] = c1 <= c2 ? [c1, c2] : [c2, c1];
      for (let c = cStart; c <= cEnd; c++) put(r1, c, '─');
    } else if (c1 === c2) {
      const [rStart, rEnd] = r1 <= r2 ? [r1, r2] : [r2, r1];
      for (let r = rStart; r <= rEnd; r++) put(r, c1, '│');
    } else {
      // simple L-shape via horizontal then vertical
      drawSegment(r1, c1, r1, c2);
      drawSegment(r1, c2, r2, c2);
    }
  }

  for (const e of rawEdges) {
    const pts = e.points.map((p) => ({
      r: Math.round((p.y - minY) * scaleY) + padding,
      c: Math.round((p.x - minX) * scaleX) + padding,
    }));
    for (let i = 0; i < pts.length - 1; i++)
      drawSegment(pts[i].r, pts[i].c, pts[i + 1].r, pts[i + 1].c);
    // arrow head at end, oriented by last segment
    const last = pts[pts.length - 1];
    const prev = pts.length > 1 ? pts[pts.length - 2] : last;
    const dr = last.r - prev.r;
    const dc = last.c - prev.c;
    let arrow = '▶';
    if (Math.abs(dc) >= Math.abs(dr)) arrow = dc >= 0 ? '▶' : '◀';
    else arrow = dr >= 0 ? '▼' : '▲';
    put(last.r, last.c, arrow);
  }

  // Draw nodes as boxes (after edges so they appear above lines)
  for (const n of rawNodes) {
    const r0 = Math.round((n.y - minY) * scaleY) + padding;
    const c0 = Math.round((n.x - minX) * scaleX) + padding;
    const label = titlecase(n.label.replace(/_agent/g, '').replace(/_/g, ' '));
    const minW = Math.max(4, label.length + 2);
    const h = Math.max(3, Math.round(n.height * scaleY));
    const w = Math.max(minW, Math.round(n.width * scaleX));
    // borders
    put(r0, c0, '┌');
    put(r0, c0 + w - 1, '┐');
    put(r0 + h - 1, c0, '└');
    put(r0 + h - 1, c0 + w - 1, '┘');
    for (let cc = c0 + 1; cc < c0 + w - 1; cc++) {
      put(r0, cc, '─');
      put(r0 + h - 1, cc, '─');
    }
    for (let rr = r0 + 1; rr < r0 + h - 1; rr++) {
      put(rr, c0, '│');
      put(rr, c0 + w - 1, '│');
    }
    // label
    const start = c0 + Math.max(1, Math.floor((w - 2 - label.length) / 2));
    for (let i = 0; i < Math.min(label.length, w - 2); i++)
      put(r0 + Math.floor(h / 2), start + i, label[i]);
  }

  return grid.map((row) => row.join('')).join('\n');
}

function toDot(nodes: SimpleNode[], edges: SimpleEdge[]): string {
  const lines = ['digraph G {', '  rankdir=LR;'];
  for (const n of nodes) lines.push(`  "${n.id}" [label="${n.label}"];`);
  for (const e of edges) lines.push(`  "${e.from}" -> "${e.to}";`);
  lines.push('}');
  return lines.join('\n');
}
