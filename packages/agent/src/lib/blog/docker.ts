import { groq } from '@ai-sdk/groq';
import { tool } from 'ai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import z from 'zod';

import { type Agent, agent, instructions } from '../agent.ts';
import { messageToUiMessage, printer } from '../stream_utils.ts';
import { execute } from '../swarm.ts';

const pexecFile = promisify(execFile);

export const SYSTEM_PROMPT = `

You are a multifunctional docker assistant swarm arranged in a mesh topology.

`.trim();

// Utilities
function assertSafeName(name: string, label: string) {
  // Accept common Docker identifiers: 12-64 hex IDs or names with [a-zA-Z0-9_.-]
  const idHex = /^(?:[a-f0-9]{12}|[a-f0-9]{64})$/i;
  const safeName = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  if (!(idHex.test(name) || safeName.test(name))) {
    throw new Error(`Invalid ${label} format`);
  }
}

function assertSafeImageRef(ref: string) {
  // Allow registry/repo[:tag][@digest]
  const ok = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/;
  if (!ok.test(ref)) {
    throw new Error('Invalid image reference format');
  }
}

function looksLikeImageRef(s: string) {
  return s.includes('/') || s.includes(':') || s.includes('@');
}

async function runDocker(args: string[]) {
  const { stdout, stderr } = await pexecFile('docker', args, {
    timeout: 15_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr?.trim() };
}

function parseSizeToBytes(sizeStr: string | undefined): number {
  if (!sizeStr) return 0;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmMgG]?)[bB]\s*$/.exec(sizeStr);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mul =
    unit === 'k'
      ? 1024
      : unit === 'm'
        ? 1024 ** 2
        : unit === 'g'
          ? 1024 ** 3
          : 1;
  return Math.round(n * mul);
}
const docker_container_agent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'docker_container_agent',
  handoffDescription:
    'Specialist for container queries: listing, logs, processes, stats, ports, and container inspect.',
  prompt: instructions({
    purpose: [
      SYSTEM_PROMPT,
      'Answer container-related questions without changing state.',
      'Prefer concise output and suggest filters when large.',
    ],
    routine: [
      'Use docker_ps for listings; docker_logs for logs; docker_top for processes; docker_stats for usage; docker_port for mappings; docker_inspect to inspect a container.',
      'Refuse any action that would change state (start/stop/restart/exec/run/rm).',
    ],
  }),
  tools: {
    docker_ps: tool({
      description:
        'List containers (read-only). Supports { all, quiet, format }. JSON emits one object per line.',
      inputSchema: z.object({
        all: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include non-running containers.'),
        format: z.enum(['table', 'json']).optional().default('table'),
        quiet: z
          .boolean()
          .optional()
          .default(false)
          .describe('Only display numeric IDs.'),
      }),
      execute: async ({ all = false, quiet = false, format = 'table' }) => {
        const args = ['ps'];
        if (all) args.push('-a');
        if (quiet) args.push('-q');
        if (format === 'json') args.push('--format', '{{json .}}');
        const res = await runDocker(args);
        return { text: res.stdout };
      },
    }),
    docker_logs: tool({
      description:
        'Fetch container logs (read-only). Supports { container, tail, since, timestamps }.',
      inputSchema: z.object({
        container: z.string().describe('Container ID or name.'),
        tail: z.number().int().min(1).max(5000).optional().default(200),
        since: z
          .string()
          .optional()
          .describe('Show logs since timestamp or relative (e.g., 1h).'),
        timestamps: z.boolean().optional().default(false),
      }),
      execute: async ({ container, tail = 200, since, timestamps = false }) => {
        assertSafeName(container, 'container');
        const args = ['logs'];
        if (timestamps) args.push('--timestamps');
        if (tail) args.push('--tail', String(tail));
        if (since) args.push('--since', since);
        const res = await runDocker([...args, container]);
        return { text: res.stdout };
      },
    }),
    docker_top: tool({
      description: 'Display running processes of a container (read-only).',
      inputSchema: z.object({
        container: z.string().describe('Container ID or name.'),
      }),
      execute: async ({ container }) => {
        assertSafeName(container, 'container');
        const res = await runDocker(['top', container]);
        return { text: res.stdout };
      },
    }),
    docker_stats: tool({
      description:
        'Resource usage stats snapshot (read-only). Uses --no-stream.',
      inputSchema: z.object({
        containers: z
          .array(z.string())
          .optional()
          .describe('Specific containers; empty lists all.'),
        noTrunc: z.boolean().optional().default(true),
      }),
      execute: async ({ containers = [], noTrunc = true }) => {
        for (const c of containers) assertSafeName(c, 'container');
        const args = ['stats', '--no-stream'];
        if (noTrunc) args.push('--no-trunc');
        const res = await runDocker([...args, ...containers]);
        return { text: res.stdout };
      },
    }),
    docker_port: tool({
      description: 'List port mappings for a container (read-only).',
      inputSchema: z.object({
        container: z.string(),
        private_port: z
          .string()
          .optional()
          .describe('Optional private port like 80 or 80/tcp'),
      }),
      execute: async ({ container, private_port }) => {
        assertSafeName(container, 'container');
        const args = ['port', container];
        if (private_port) args.push(private_port);
        const res = await runDocker(args);
        return { text: res.stdout };
      },
    }),
    docker_inspect: tool({
      description:
        'Inspect a resource (read-only). Supports { id, type, pretty }.',
      inputSchema: z.object({
        id: z.string().describe('Container/image/network/volume ID or name.'),
        type: z.enum(['container', 'image', 'network', 'volume']).optional(),
        pretty: z.boolean().optional().default(true),
      }),
      execute: async ({ id, pretty = true, type }) => {
        if (type === 'image' || looksLikeImageRef(id)) {
          assertSafeImageRef(id);
        } else {
          assertSafeName(id, 'id');
        }
        const args = ['inspect'];
        if (type) args.push(`--type=${type}`);
        if (pretty) args.push('--format', '{{json .}}');
        const res = await runDocker([...args, id]);
        return { text: res.stdout };
      },
    }),
  },
  handoffs: [() => docker_triage_agent],
});

const docker_image_agent: Agent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'docker_image_agent',
  handoffDescription:
    'A helpful agent that specializes in image queries: listing, inspect, history, versions.',
  prompt: instructions({
    purpose: ['Answer image-related questions (list, inspect, history)'],
    routine: [
      'Use docker_images_sorted to list largest images first; docker_images for full list; docker_inspect (type image) to inspect; docker_history for build history; docker_version for client/server versions.',
      'Refuse any action that would change state (pull/build/tag/push/rm).',
    ],
  }),
  tools: {
    docker_images: tool({
      description:
        'List images (read-only). Supports { all, digests, format }.',
      inputSchema: z.object({
        all: z
          .boolean()
          .optional()
          .default(false)
          .describe('Show intermediate images.'),
        digests: z.boolean().optional().default(false),
        format: z.enum(['table', 'json']).optional().default('table'),
      }),
      execute: async ({ all = false, digests = false, format = 'table' }) => {
        const args = ['images'];
        if (all) args.push('-a');
        if (digests) args.push('--digests');
        if (format === 'json') args.push('--format', '{{json .}}');
        const res = await runDocker(args);
        return { text: res.stdout };
      },
    }),
    docker_images_sorted: tool({
      description:
        'List images sorted by size descending (read-only). Parses docker images JSON output and returns top N with bytes field.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().default(10),
        all: z.boolean().optional().default(false),
        digests: z.boolean().optional().default(false),
      }),
      execute: async ({ limit = 10, all = false, digests = false }) => {
        const args = ['images'];
        if (all) args.push('-a');
        if (digests) args.push('--digests');
        args.push('--format', '{{json .}}');
        const res = await runDocker(args);
        const lines = res.stdout.split('\n').filter(Boolean);
        const items = lines
          .map((l) => {
            try {
              const o = JSON.parse(l);
              return { ...o, bytes: parseSizeToBytes(o.Size) };
            } catch {
              return null;
            }
          })
          .filter(Boolean) as Array<Record<string, any> & { bytes: number }>;
        items.sort((a, b) => b.bytes - a.bytes);
        return { json: items.slice(0, limit) } as any;
      },
    }),
    docker_inspect: tool({
      description:
        'Inspect a resource (read-only). Supports { id, type, pretty }.',
      inputSchema: z.object({
        id: z.string().describe('Container/image/network/volume ID or name.'),
        type: z.enum(['container', 'image', 'network', 'volume']).optional(),
        pretty: z.boolean().optional().default(true),
      }),
      execute: async ({ id, pretty = true, type }) => {
        if (type === 'image' || looksLikeImageRef(id)) {
          assertSafeImageRef(id);
        } else {
          assertSafeName(id, 'id');
        }
        const args = ['inspect'];
        if (type) args.push(`--type=${type}`);
        if (pretty) args.push('--format', '{{json .}}');
        const res = await runDocker([...args, id]);
        return { text: res.stdout };
      },
    }),
    docker_history: tool({
      description: 'Show the history of an image (read-only).',
      inputSchema: z.object({
        image: z.string().describe('Image name or ID.'),
        noTrunc: z.boolean().optional().default(true),
        format: z.enum(['table', 'json']).optional().default('table'),
      }),
      execute: async ({ image, noTrunc = true, format = 'table' }) => {
        if (looksLikeImageRef(image)) assertSafeImageRef(image);
        else assertSafeName(image, 'image');
        const args = ['history'];
        if (noTrunc) args.push('--no-trunc');
        if (format === 'json') args.push('--format', '{{json .}}');
        const res = await runDocker([...args, image]);
        return { text: res.stdout };
      },
    }),
    docker_version: tool({
      description: 'Docker client/server version (read-only).',
      inputSchema: z.object({}),
      execute: async () => {
        const res = await runDocker(['version']);
        return { text: res.stdout };
      },
    }),
  },
  handoffs: [() => docker_triage_agent, () => docker_volume_agent],
});

const docker_network_agent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'docker_network_agent',
  handoffDescription:
    'Specialist for network queries: list/inspect networks and related info.',
  prompt: instructions({
    purpose: 'Answer network-related questions in read-only mode.',
    routine: [
      SYSTEM_PROMPT,
      'Use docker_network_ls to list and docker_network_inspect to inspect.',
      'Refuse any action that would change state (create/connect/disconnect/rm).',
    ],
  }),
  tools: {
    docker_network_ls: tool({
      description: 'List networks (read-only).',
      inputSchema: z.object({
        format: z.enum(['table', 'json']).optional().default('table'),
      }),
      execute: async ({ format = 'table' }) => {
        const args = ['network', 'ls'];
        if (format === 'json') args.push('--format', '{{json .}}');
        const res = await runDocker(args);
        return { text: res.stdout };
      },
    }),
    docker_network_inspect: tool({
      description: 'Inspect a network (read-only).',
      inputSchema: z.object({
        name: z.string().describe('Network name or ID.'),
      }),
      execute: async ({ name }) => {
        assertSafeName(name, 'network');
        const res = await runDocker([
          'network',
          'inspect',
          '--format',
          '{{json .}}',
          name,
        ]);
        return { text: res.stdout };
      },
    }),
  },
  handoffs: [() => docker_triage_agent],
});

const docker_volume_agent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'docker_volume_agent',
  handoffDescription:
    'A helpful agent that specializes in volume queries: list/inspect volumes.',
  prompt: instructions({
    purpose: [
      SYSTEM_PROMPT,
      'You are helpful docker volume agents that have access to docker volumes.',
    ],
    routine: [
      'Use docker_volume_ls to list volumes',
      'Use docker_volume_inspect to inspect a volume',
    ],
  }),
  tools: {
    docker_volume_ls: tool({
      description: 'List volumes (read-only).',
      inputSchema: z.object({
        format: z.enum(['table', 'json']).optional().default('table'),
      }),
      execute: async ({ format = 'table' }) => {
        const args = ['volume', 'ls'];
        if (format === 'json') args.push('--format', '{{json .}}');
        const res = await runDocker(args);
        return { text: res.stdout };
      },
    }),
    docker_volume_inspect: tool({
      description: 'Inspect a volume (read-only).',
      inputSchema: z.object({
        name: z.string().describe('Volume name or ID.'),
      }),
      execute: async ({ name }) => {
        assertSafeName(name, 'volume');
        const res = await runDocker([
          'volume',
          'inspect',
          '--format',
          '{{json .}}',
          name,
        ]);
        return { text: res.stdout };
      },
    }),
  },
  handoffs: [() => docker_triage_agent, () => docker_image_agent],
});

const docker_system_agent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'docker_system_agent',
  handoffDescription:
    'Specialist for daemon/system queries: info, df, events, contexts, plugins.',
  prompt: instructions({
    purpose: [
      SYSTEM_PROMPT,
      'Answer system/daemon-wide questions in read-only mode.',
    ],
    routine: [
      'Use docker_info, docker_df, docker_events (bounded), docker_context_ls, docker_plugin_ls.',
      'Refuse any action that would change state (system prune, context use, plugin enable/disable).',
    ],
  }),
  tools: {
    docker_info: tool({
      description: 'Docker daemon info (read-only).',
      inputSchema: z.object({}),
      execute: async () => {
        const res = await runDocker(['info']);
        return { text: res.stdout };
      },
    }),
    docker_df: tool({
      description: 'Docker disk usage summary (read-only).',
      inputSchema: z.object({}),
      execute: async () => {
        const res = await runDocker(['system', 'df']);
        return { text: res.stdout };
      },
    }),
    docker_events: tool({
      description:
        'Show daemon events within a bounded window (read-only). Requires at least since or until to avoid long streams.',
      inputSchema: z.object({
        since: z.string().optional().describe('RFC3339 or relative like 1h'),
        until: z.string().optional().describe('RFC3339 or relative like 10m'),
      }),
      execute: async ({ since, until }) => {
        if (!since && !until) {
          return {
            error:
              'Provide at least one of since or until to bound the output.',
          } as any;
        }
        const args = ['events'];
        if (since) args.push('--since', since);
        if (until) args.push('--until', until);
        args.push('--format', '{{json .}}');
        const res = await runDocker(args);
        return { text: res.stdout };
      },
    }),
    docker_context_ls: tool({
      description: 'List Docker contexts (read-only).',
      inputSchema: z.object({
        format: z.enum(['table', 'json']).optional().default('table'),
      }),
      execute: async ({ format = 'table' }) => {
        const args = ['context', 'ls'];
        if (format === 'json') args.push('--format', '{{json .}}');
        const res = await runDocker(args);
        return { text: res.stdout };
      },
    }),
    docker_plugin_ls: tool({
      description: 'List Docker plugins (read-only).',
      inputSchema: z.object({
        format: z.enum(['table', 'json']).optional().default('table'),
      }),
      execute: async ({ format = 'table' }) => {
        const args = ['plugin', 'ls'];
        if (format === 'json') args.push('--format', '{{json .}}');
        const res = await runDocker(args);
        return { text: res.stdout };
      },
    }),
  },
  handoffs: [() => docker_triage_agent],
});

export const docker_triage_agent: Agent = agent({
  model: groq('openai/gpt-oss-20b'),
  name: 'docker_triage_agent',
  handoffDescription: `Handoff to the triage_agent to handle the request.`,
  prompt: instructions({
    purpose: [
      SYSTEM_PROMPT,
      `You are a helpful orchestrator agent that coordinates the process by delegating tasks to specialized agents based on user requests and the current state of the execution.`,
      `First you need to create plan in order to navigate between the specialized agents`,
      `Transfers to specialized agents are achieved by calling a transfer function, named \`transfer_to_<agent_name>\`.`,
      'To see the latest result of the agents before you look into the messages',
      `When a specialized agent forwards back to you but without producing any result you should blame it so and ask it to produce a result before handing back to you.`,
    ],
    routine: [
      'Plan the execution steps needed to fulfill the user request',
      'If the request is unclear or too broad, ask the user for clarification or suggest narrowing it down.',
    ],
  }),
  handoffs: [
    docker_container_agent,
    docker_image_agent,
    docker_network_agent,
    docker_volume_agent,
    docker_system_agent,
  ],
});

const response = await execute(
  docker_triage_agent,
  // [messageToUiMessage(await input())],
  [
    messageToUiMessage(
      `Environment audit: show docker info, current contexts and plugins, and a concise summary of differences between client and server versions."`,
    ),
  ],
  {},
);

await printer.stdout(response);
