import type { ToolSet } from 'ai';

import type { AgentToolContext } from './agent-tool-context.ts';
import type { Capability, Guidance, Role, ToolNamer } from './capability.ts';
import { DirectMessaging } from './direct-messaging.ts';
import { DirectTools } from './direct-tools.ts';
import { Spawning } from './spawning.ts';
import { Supervision } from './supervision.ts';
import type { ToolExposure, ToolSurface } from './tool-exposure.ts';
import type { WaitBounds } from './wait-bounds.ts';
import { Waiting } from './waiting.ts';

/** Codex `DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION`. */
const DEFAULT_MAX_CONCURRENT_THREADS = 4;
const SHARED_WORKSPACE =
  'All agents share the same workspace, current working directory, and filesystem.';
const USE_CLAUSES = new Intl.ListFormat('en', { type: 'conjunction' });

const ROLE_GUIDANCE: Record<
  Role,
  { preamble: string; introSeparator: string; envelopes: string }
> = {
  root: {
    preamble:
      "You are `/root`, the primary agent in a team of agents collaborating to fulfill the user's goals.",
    introSeparator: '\n\n',
    envelopes:
      'Child messages arrive as `MESSAGE` or `FINAL_ANSWER` mailbox envelopes with their task name, sender, and payload preserved.',
  },
  subagent: {
    preamble: 'You are an agent in a team collaborating to complete a task.',
    introSeparator: ' ',
    envelopes:
      'Your final response is delivered automatically to your parent agent. Mailbox messages arrive as `NEW_TASK`, `MESSAGE`, or `FINAL_ANSWER` envelopes with their task name, sender, and payload preserved.',
  },
};

/** Verbatim Codex `resolve_usage_hints` closing sentence. */
function concurrencySlotsText(maxConcurrency: number): string {
  return `There are ${maxConcurrency} available concurrency slots, meaning that up to ${maxConcurrency} agents can be active at once, including you.`;
}

/** The tools context of a team's tools, each acting as one agent. */
export type TeamToolsContext<TOOLS extends ToolSet> = {
  [NAME in keyof TOOLS]: AgentToolContext;
} & { code_mode?: AgentToolContext };

export interface TeamOptions {
  /**
   * Codex `max_concurrent_threads_per_session`: how many agents of one tree
   * may run turns at once, including the root. Defaults to 4.
   */
  maxConcurrentThreads?: number;
  /** How the tools reach the model. Defaults to direct, unnamespaced tools. */
  exposure?: ToolExposure;
  /** Rewrites a role's composed guidance; `undefined` gives that role none. */
  guidance?: Partial<Record<Role, (composed: string) => string | undefined>>;
}

/**
 * The collaboration capabilities a tree of agents shares. Its tools always
 * include `spawn_agent`: every other capability acts on spawned agents.
 */
export class Team<
  TOOLS extends ToolSet & Spawning['tools'] = Spawning['tools'],
> {
  readonly maxConcurrentThreads: number;
  readonly exposure: ToolExposure;
  /** What a turn's model request carries for the team's tools. */
  readonly surface: ToolSurface<TOOLS>;
  readonly #members: Capability & { readonly tools: TOOLS };
  readonly #options: TeamOptions;

  constructor(
    spawning: Capability & { readonly tools: TOOLS },
    options: TeamOptions = {},
  ) {
    const maxConcurrentThreads =
      options.maxConcurrentThreads ?? DEFAULT_MAX_CONCURRENT_THREADS;
    if (
      !Number.isSafeInteger(maxConcurrentThreads) ||
      maxConcurrentThreads < 1
    ) {
      throw new Error(
        'AgentRuntime: multiAgent.maxConcurrentThreadsPerSession must be a positive integer',
      );
    }
    this.maxConcurrentThreads = maxConcurrentThreads;
    this.exposure = options.exposure ?? new DirectTools();
    this.#members = spawning;
    this.#options = options;
    this.surface = this.exposure.surface(this.tools);
  }

  /** Every capability, in Codex order. */
  static codex({
    usageHintText,
    waitBounds,
    ...options
  }: TeamOptions & {
    usageHintText?: string;
    waitBounds?: WaitBounds;
  } = {}) {
    return new Team(new Spawning({ usageHintText }), options)
      .with(new DirectMessaging())
      .with(new Waiting(waitBounds))
      .with(new Supervision());
  }

  /** A team that also has `capability`. Two tools of one name throw. */
  with<CAPABILITY extends Capability>(
    capability: CAPABILITY,
  ): Team<TOOLS & CAPABILITY['tools']> {
    for (const name of Object.keys(capability.tools)) {
      if (Object.hasOwn(this.#members.tools, name)) {
        throw new Error(
          `AgentRuntime: multiAgent already has the "${name}" collaboration tool`,
        );
      }
    }
    return new Team(new Joined(this.#members, capability), this.#options);
  }

  /** The collaboration tools as the exposure carries them, in team order. */
  get tools(): TOOLS {
    const tools: TOOLS = { ...this.#members.tools };
    for (const name in tools) {
      const collaborationTool = tools[name];
      tools[name] = this.exposure.tool({
        ...collaborationTool,
        metadata: {
          ...collaborationTool.metadata,
          zukhruf: {
            kind: 'collaboration',
          },
        },
      });
    }
    return tools;
  }

  /** Names a plugin tool cannot take. */
  get reservedToolNames(): readonly string[] {
    return this.surface.reservedToolNames;
  }

  /** The tools context of every tool that acts as `agent`. */
  contextFor(agent: AgentToolContext): TeamToolsContext<TOOLS> {
    const context: Record<string, AgentToolContext> = {};
    for (const name of Object.keys(this.#members.tools)) context[name] = agent;
    if (!coversEveryTool(this.#members.tools, context)) {
      throw new Error('AgentRuntime: a collaboration tool has no context');
    }
    return { ...context, ...this.exposure.callerContext(agent) };
  }

  /** The role's collaboration guidance, or `undefined` for none. */
  guidance(role: Role): string | undefined {
    const composed = this.#compose(role);
    const transform = this.#options.guidance?.[role];
    return transform === undefined ? composed : transform(composed);
  }

  #compose(role: Role): string {
    const name: ToolNamer = (toolName) => this.exposure.toolName(toolName);
    const {
      intro,
      uses = [],
      notes,
      outro,
    } = this.#members.guidance(role, name);
    const { preamble, introSeparator, envelopes } = ROLE_GUIDANCE[role];
    const lead = [
      intro,
      joined(
        [
          uses.length === 0 ? undefined : `Use ${USE_CLAUSES.format(uses)}.`,
          notes,
        ],
        ' ',
      ),
    ];
    return [
      preamble,
      joined(lead, introSeparator),
      envelopes,
      this.exposure.callLine(Object.keys(this.#members.tools)),
      SHARED_WORKSPACE,
      outro,
      concurrencySlotsText(this.maxConcurrentThreads),
    ]
      .filter((paragraph) => paragraph !== undefined)
      .join('\n\n');
  }
}

/** Two capabilities as one: tools merged in order, guidance joined. */
class Joined<
  FIRST extends Capability,
  SECOND extends Capability,
> implements Capability {
  readonly tools: FIRST['tools'] & SECOND['tools'];
  readonly #first: FIRST;
  readonly #second: SECOND;

  constructor(first: FIRST, second: SECOND) {
    this.tools = { ...first.tools, ...second.tools };
    this.#first = first;
    this.#second = second;
  }

  guidance(role: Role, name: ToolNamer): Guidance {
    const first = this.#first.guidance(role, name);
    const second = this.#second.guidance(role, name);
    return {
      intro: joined([first.intro, second.intro], ' '),
      uses: [...(first.uses ?? []), ...(second.uses ?? [])],
      notes: joined([first.notes, second.notes], ' '),
      outro: joined([first.outro, second.outro], '\n\n'),
    };
  }
}

/** Whether `context` gives every tool of `tools` a context. */
function coversEveryTool<TOOLS extends ToolSet>(
  tools: TOOLS,
  context: Record<string, AgentToolContext>,
): context is { [NAME in keyof TOOLS]: AgentToolContext } {
  return Object.keys(tools).every((name) => Object.hasOwn(context, name));
}

function joined(
  texts: readonly (string | undefined)[],
  separator: string,
): string | undefined {
  const present = texts.filter((text) => text !== undefined);
  return present.length === 0 ? undefined : present.join(separator);
}
