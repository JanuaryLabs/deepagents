import { type Tool, dynamicTool } from 'ai';
import z from 'zod';

import { type Agent, agent, instructions } from '../agent.ts';

// Simple in-memory mock filesystem shared across tools
const mockFS = new Map<string, string>();

// --- Built-in tools (planning + mock filesystem) ---
const writeTodosSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string(),
        status: z
          .enum(['pending', 'in_progress', 'completed'])
          .default('pending'),
      }),
    )
    .describe('Complete list of todos to set (overwrite).'),
});
const writeTodos = dynamicTool({
  description:
    'Create or update a structured todo list for this session. Use for multi-step tasks. Returns the full list back.',
  inputSchema: writeTodosSchema,
  execute: async (input) => {
    const { todos } = writeTodosSchema.parse(input);
    return { ok: true as const, todos };
  },
});

const ls = dynamicTool({
  description: 'List all files in the mock workspace.',
  inputSchema: z.object({}),
  execute: async () => ({ files: Array.from(mockFS.keys()) }),
});

const readFileSchema = z.object({
  path: z.string(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});
const readFile = dynamicTool({
  description:
    'Read a file from the mock workspace. Returns numbered lines like cat -n. Errors if not found.',
  inputSchema: readFileSchema,
  execute: async (input) => {
    const { path, offset = 0, limit = 2000 } = readFileSchema.parse(input);
    if (!mockFS.has(path)) return { error: `Error: File '${path}' not found` };
    const content = mockFS.get(path) ?? '';
    if (!content.trim())
      return { text: 'System reminder: File exists but has empty contents' };
    const lines = content.split('\n');
    if (offset >= lines.length)
      return {
        error: `Error: Line offset ${offset} exceeds file length (${lines.length} lines)`,
      };
    const out: string[] = [];
    const end = Math.min(offset + limit, lines.length);
    for (let i = offset; i < end; i++) {
      // cap very long lines for safety
      const line = lines[i].slice(0, 2000);
      const num = (i + 1).toString().padStart(6, ' ');
      out.push(`${num}\t${line}`);
    }
    return { text: out.join('\n') };
  },
});

const writeFileSchema = z.object({ path: z.string(), content: z.string() });
const writeFile = dynamicTool({
  description: 'Write content to a file in the mock workspace (overwrites).',
  inputSchema: writeFileSchema,
  execute: async (input) => {
    const { path, content } = writeFileSchema.parse(input);
    mockFS.set(path, content);
    return { ok: true as const, path };
  },
});

const editFileSchema = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional().default(false),
});
const editFile = dynamicTool({
  description:
    'Replace text in a file. If replace_all=false, the old_string must be unique or the edit will fail.',
  inputSchema: editFileSchema,
  execute: async (input) => {
    const {
      path,
      old_string,
      new_string,
      replace_all = false,
    } = editFileSchema.parse(input);
    if (!mockFS.has(path)) return { error: `Error: File '${path}' not found` };
    const current = mockFS.get(path) ?? '';
    const count = (
      current.match(
        new RegExp(old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      ) || []
    ).length;
    if (!replace_all) {
      if (count === 0)
        return { error: `Error: String not found in file: '${old_string}'` };
      if (count > 1)
        return {
          error: `Error: String '${old_string}' appears ${count} times in file. Use replace_all=true or provide a more specific string.`,
        };
      mockFS.set(path, current.replace(old_string, new_string));
      return { ok: true as const, replaced: 1 };
    }
    mockFS.set(path, current.replaceAll(old_string, new_string));
    return { ok: true as const, replaced: count };
  },
});

// Task tool: launch a subagent by handing off control. The swarm will switch agents
// when a tool returns an object containing `{ agent: '<agent_name>' }`.
const taskSchema = z.object({
  subagent_type: z
    .string()
    .describe('Target agent name, e.g., research_agent or critique_agent'),
  description: z
    .string()
    .describe('Detailed autonomous task for the sub-agent.'),
});
const task = dynamicTool({
  description:
    'Launch a specialized sub-agent to execute a complex task. Provide a subagent_type and a detailed description. Returns a handoff to the chosen agent.',
  inputSchema: taskSchema,
  execute: async (input) => {
    const { subagent_type } = taskSchema.parse(input);
    return { agent: subagent_type };
  },
});

// Shared toolset for all deep agents
const builtInTools = {
  write_todos: writeTodos,
  ls,
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  task,
};

export const SYSTEM_PROMPT_DEEPAGENTS = `
You are part of a deep multi-agent swarm that plans, researches, edits, and composes comprehensive reports.
Use tools frequently: maintain a todo plan, read/write files (question.txt, final_report.md), and hand off to specialists via the Task tool or transfers.
Do not expose handoffs; just continue the work seamlessly.
`.trim();

// Python-compatible SubAgent shape
export type SubAgent = {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  model_settings?: Record<string, unknown>; // accepted for API parity; not used here
};

// create_deep_agent: Python-style API, implemented using our swarm Agent
export function create_deep_agent(
  tools: Record<string, Tool>,
  prompt: string,
  model?: unknown, // accepted for parity; not used, model is selected in swarm()
  subagents?: SubAgent[],
) {
  const externalTools: Record<string, Tool> = tools ?? {};
  const allToolset: Record<string, Tool> = {
    ...builtInTools,
    ...externalTools,
  };

  // general-purpose subagent mirrors Python default behavior
  const generalPurpose = agent({
    name: 'general-purpose',
    handoffDescription:
      'General-purpose agent for researching complex questions and multi-step tasks.',
    prompt: instructions({
      purpose: prompt,
      routine: [
        'Use write_todos to plan multi-step tasks.',
        'Read/write files as needed (question.txt, final_report.md).',
        'When done with a subtask, transfer_to_deepagents_manager.',
      ],
    }),
    tools: allToolset,
    handoffs: [],
  });

  const customAgents = (subagents ?? []).map((sa) => {
    const filtered: Record<string, Tool> = sa.tools
      ? sa.tools.reduce<Record<string, Tool>>(
          (acc, key) => {
            if (externalTools[key]) acc[key] = externalTools[key];
            return acc;
          },
          { ...builtInTools },
        )
      : { ...allToolset };
    return agent({
      name: sa.name,
      handoffDescription: sa.description,
      prompt: instructions({ purpose: sa.prompt, routine: [] }),
      tools: filtered,
      handoffs: [],
    });
  });

  const children = [generalPurpose, ...customAgents];

  const manager: Agent = agent({
    name: 'deepagents_manager',
    handoffDescription:
      'Coordinates deep agent workflow and delegates via task or transfers.',
    prompt: instructions({
      purpose: `${prompt}\n\n${SYSTEM_PROMPT_DEEPAGENTS}`,
      routine: [
        'Capture the user brief to question.txt using write_file.',
        'Maintain plan with write_todos; only one in_progress at a time.',
        'Use task or transfer_to a subagent when beneficial.',
        'Iterate until final_report.md is complete and polished.',
      ],
    }),
    tools: allToolset,
    handoffs: children.map((c) => () => c),
  });

  // allow subagents to hand back to manager
  for (const child of children) {
    child.handoffs = [() => manager];
  }

  return manager;
}
