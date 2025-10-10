import {
  type GenerateTextResult,
  type LanguageModel,
  type ModelMessage,
  Output,
  type StreamTextResult,
  type Tool,
  type ToolChoice,
  type UIDataTypes,
  type UIMessage,
  type UITools,
  dynamicTool,
  generateText,
  jsonSchema,
  stepCountIs,
  tool,
} from 'ai';
import chalk from 'chalk';
import { snakecase } from 'stringcase';
import z from 'zod';

import {
  RECOMMENDED_PROMPT_PREFIX,
  SUPERVISOR_PROMPT_PREFIX,
} from './prompts.ts';
import { toState } from './stream_utils.ts';
import { prepareStep } from './swarm.ts';

export interface Handoff<C> {
  name: string;
  instructions: Instruction<C>;
  handoffDescription?: string;
  tools: Record<string, Tool>;
}
export type Handoffs<C> = (Agent<C> | (() => Agent<C>))[];

export type Runner<T, C> = (
  prompt: string,
  agent: Agent<C>,
  messages: ModelMessage[],
) => Promise<T>;

type transfer_tool = `transfer_to_${string}`;

export type ContextVariables = Record<string, unknown>;

export function agent<C = ContextVariables>(config: CreateAgent<C>): Agent<C> {
  return new Agent(config);
}

export type ResponseMessage = UIMessage<unknown, UIDataTypes, UITools>;

export type AgentModel = Exclude<LanguageModel, string>;
export type OutputExtractorFn = (
  output: GenerateTextResult<Record<string, Tool>, any>,
) => string | Promise<string>;
export type PrepareHandoffFn = (
  messages: ModelMessage[],
) => void | Promise<void>;
export type PrepareEndFn<C> = (config: {
  messages: ResponseMessage[];
  responseMessage: ResponseMessage;
  contextVariables: C;
  abortSignal?: AbortSignal;
}) => StreamTextResult<Record<string, Tool>, any> | undefined | void;

export interface CreateAgent<C> {
  name: string;
  prompt: Instruction<C>;
  temperature?: number;
  handoffDescription?: string;
  prepareHandoff?: PrepareHandoffFn;
  prepareEnd?: PrepareEndFn<C>;
  handoffs?: Handoffs<C>;
  tools?: Record<string, Tool>;
  model?: AgentModel;
  toolChoice?: ToolChoice<Record<string, unknown>>;
  output?: z.Schema<any>;
}
export class Agent<C = ContextVariables> {
  model: AgentModel | undefined;
  toolChoice: ToolChoice<Record<string, unknown>> | undefined;
  parent?: Agent<C>;
  handoffs: Handoffs<C>;
  readonly prepareHandoff?: PrepareHandoffFn;
  readonly prepareEnd?: PrepareEndFn<C>;
  readonly internalName: string;
  readonly handoff: Handoff<C>;
  readonly handoffToolName: transfer_tool;
  readonly handoffTool: Record<string, Tool>;
  readonly output?: z.Schema<any>;
  readonly temperature?: number;
  constructor(config: CreateAgent<C>) {
    this.model = config.model;
    this.toolChoice = config.toolChoice;
    this.handoffs = config.handoffs ?? [];
    this.prepareHandoff = config.prepareHandoff;
    this.prepareEnd = config.prepareEnd;
    this.output = config.output;
    this.temperature = config.temperature;
    this.internalName = snakecase(config.name);
    this.handoff = {
      name: this.internalName,
      instructions: config.prompt,
      tools: config.tools ?? {},
      handoffDescription: config.handoffDescription,
    };
    this.handoffToolName = `transfer_to_${this.internalName}`;
    this.handoffTool = {
      [this.handoffToolName]: dynamicTool({
        description: [
          `An input/parameter/argument less tool to transfer control to the ${this.internalName} agent.`,
          // `Handoff to the ${this.internalName} agent to handle the request`,
          // `Do not include any parameters/inputs. The agent have access to all the context it needs.`,
          config.handoffDescription,
        ]
          .filter(Boolean)
          .join(' '),
        inputSchema: jsonSchema({
          type: 'object',
          properties: {},
          additionalProperties: true,
        }),
        execute: async (_, options) => {
          const state = toState(options) as any;
          state.currentActiveAgent = this.internalName;
          return `Transfer successful to ${this.internalName}.`;
        },
      }),
    };
  }

  get transfer_tools() {
    return Object.fromEntries(
      this.toHandoffs().flatMap((it) => Object.entries(it.handoffTool)),
    );
  }

  get toolsNames() {
    return [
      // Note: do not add the handoff tool itself otherwise it'd create a agent recursion/loop
      ...Object.keys(this.transfer_tools),
      ...Object.keys(this.handoff.tools),
    ];
  }

  #prepareInstructions(contextVariables?: C) {
    return [
      typeof this.handoff.instructions === 'function'
        ? this.handoff.instructions(contextVariables)
        : Array.isArray(this.handoff.instructions)
          ? this.handoff.instructions.join('\n')
          : this.handoff.instructions,
      '',
      '',
    ].join('\n');
  }

  instructions(contextVariables?: C) {
    const text = this.#prepareInstructions(contextVariables);
    const handoffsData = this.toHandoffs();

    if (handoffsData.length === 0) {
      return text.replace('<specialized_agents_placeholder>', ' ');
    }

    const handoffs = [
      '## Specialized Agents',

      '| Agent Name | Agent Description |',
      '| --- | --- |',
      ...handoffsData.map(
        (hf) =>
          `| ${hf.handoff.name} | ${hf.handoff.handoffDescription || 'No description available'} |`,
      ),
      '',
      '',
    ].join('\n');

    return text.replace('<specialized_agents_placeholder>', handoffs);
  }

  toHandoffs() {
    const hfs: Agent<C>[] = [];
    for (const it of this.handoffs ?? []) {
      const hf = typeof it === 'function' ? it() : it;
      hf.parent = this;
      hfs.push(hf);
    }
    return hfs;
  }

  asTool(props?: {
    toolDescription?: string;
    outputExtractor?: OutputExtractorFn;
  }) {
    return tool({
      description: props?.toolDescription || this.handoff.handoffDescription,
      inputSchema: z.object({
        input: z.string(),
      }),
      execute: async ({ input }, options) => {
        try {
          const result = await generateText({
            model: this.model!,
            system: this.#prepareInstructions(),
            prompt: input,
            temperature: 0,
            tools: this.handoff.tools,
            abortSignal: options.abortSignal,
            stopWhen: stepCountIs(25),
            experimental_context: options.experimental_context,
            experimental_output: this.output
              ? Output.object({ schema: this.output })
              : undefined,
            onStepFinish: (step) => {
              const toolCall = step.toolCalls.at(-1);
              if (toolCall) {
                console.log(
                  `Debug: ${chalk.yellow('ToolCalled')}: ${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
                );
              }
            },
            prepareStep: prepareStep(
              this,
              this.model!,
              '',
              options.experimental_context,
            ),
          });
          if (props?.outputExtractor) {
            return await props.outputExtractor(result);
          }
          return result.steps.map((it) => it.toolResults).flat();
        } catch (error) {
          console.error(error);
          return `Error: ${JSON.stringify(error)}`;
        }
      },
    });
  }

  toTool(props?: {
    toolDescription?: string;
    outputExtractor?: OutputExtractorFn;
  }) {
    return {[this.handoffToolName]: this.asTool(props)};
  }

  debug(prefix = '') {
    console.log(
      `Debug: ${chalk.bgMagenta('Agent')}: ${chalk.bold(this.handoff.name)}`,
    );
    // console.log(
    //   `Debug: ${chalk.blue('Tools')}: ${Object.keys(toToolset(agent))}`,
    // );
    const transferTools = this.toolsNames
      .filter((toolName) => toolName.startsWith('transfer_to'))
      .map((toolName) => toolName.replace('transfer_to_', ''));
    const agentTools = this.toolsNames.filter(
      (toolName) => !toolName.startsWith('transfer_to'),
    );
    console.log(
      `Debug: ${chalk.blue('TransferTools')}: ${transferTools.length ? transferTools : 'None'}`,
    );
    console.log(
      `Debug: ${chalk.blue('Agent Tools')}: ${agentTools.length ? agentTools : 'None'}`,
    );
    // if (!isEmpty(agent.handoff.handoffs)) {
    //   console.log(`${prefix}Handoffs:`);
    //   for (const handoff of agent.handoff.handoffs) {
    //     debugAgent(handoff, `${prefix}  `);
    //   }
    // }
  }

  toToolset(options?: {
    includeTransferTool?: boolean;
    includeHandoffs?: boolean;
  }): Record<string, Tool> {
    const tools = flattenTools(
      this as Agent<C>,
      (node) => node.toHandoffs(),
      (node) => node.handoff.tools,
    );

    return {
      ...Object.fromEntries(tools.flatMap((it) => Object.entries(it))),
      ...(options?.includeTransferTool !== false ? this.transfer_tools : {}),
      ...(options?.includeHandoffs !== false ? this.handoffTool : {}),
    };
  }

  clone(agent?: Omit<Partial<CreateAgent<C>>, 'handoffs'>): Agent<C> {
    return new Agent({
      prepareHandoff: (messages) => {
        this.prepareHandoff?.(messages);
      },
      model: agent?.model ?? this.model,
      toolChoice: agent?.toolChoice ?? this.toolChoice,
      prompt: agent?.prompt ?? this.handoff.instructions,
      tools: agent?.tools ?? this.handoff.tools,
      name: agent?.name ?? this.handoff.name,
      handoffDescription:
        agent?.handoffDescription ?? this.handoff.handoffDescription,
      handoffs: [...this.handoffs],
      output: agent?.output ?? this.output,
    });
  }
}

function flattenTools<T, R>(
  root: T,
  getChildren: (node: T) => T[],
  extract: (node: T) => R,
): R[] {
  const stack: T[] = [root];
  const visited = new Set<T>();
  const result: R[] = [];

  while (stack.length) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    result.push(extract(node));
    stack.push(...getChildren(node));
  }

  return result;
}

export type Instruction<C> =
  | string
  | string[]
  | ((contextVariables?: C) => string);

export interface PurposeRoutineInstructions {
  purpose: string | string[];
  routine: string[];
}

export function instructions({ purpose, routine }: PurposeRoutineInstructions) {
  const lines = [
    '# Agent Context',
    ...(Array.isArray(purpose) ? purpose : [purpose]),
    '',
    '',
    '<specialized_agents_placeholder>',
  ];

  if (routine.length) {
    lines.push(
      `Use the following routine to fulfill the task.`,
      `# Routine`,
      ...routine.map((it, i) => `${i + 1}. ${it}`),
    );
  }

  return lines.join('\n');
}

instructions.swarm = ({ purpose, routine }: PurposeRoutineInstructions) => {
  const lines = [
    RECOMMENDED_PROMPT_PREFIX,
    '',
    '',
    '# Agent Context',
    ...(Array.isArray(purpose) ? purpose : [purpose]),
    '',
    '',
    '<specialized_agents_placeholder>',
  ];

  if (routine.length) {
    lines.push(
      `Use the following routine to fulfill the task.`,
      `# Routine`,
      ...routine.map((it, i) => `${i + 1}. ${it}`),
    );
  }

  return lines.join('\n');
};

instructions.supervisor = ({
  purpose,
  routine,
}: PurposeRoutineInstructions) => {
  const lines = [
    SUPERVISOR_PROMPT_PREFIX,
    '',
    '',
    '# Agent Context',
    ...(Array.isArray(purpose) ? purpose : [purpose]),
    '',
    '',
    '<specialized_agents_placeholder>',
  ];

  if (routine.length) {
    lines.push(
      `Use the following routine to fulfill the task.`,
      `# Routine`,
      ...routine.filter(Boolean).map((it, i) => `${i + 1}. ${it}`),
    );
  }

  return lines.join('\n');
};

instructions.supervisor_subagent = ({
  purpose,
  routine,
}: PurposeRoutineInstructions) => {
  const lines = [
    SUPERVISOR_PROMPT_PREFIX,
    '',
    '',
    '# Agent Context',
    ...(Array.isArray(purpose) ? purpose : [purpose]),
    '',
  ];

  if (routine.length) {
    lines.push(
      `Use the following routine to fulfill the task. Execute ALL steps immediately.`,
      `# Routine`,
      ...routine.map((it, i) => `${i + 1}. ${it}`),
      `${routine.length + 1}. transfer_to_supervisor_agent`,
      // `1. IMMEDIATELY START: ${routine[0]}`,
      // ...routine.slice(1).map((it, i) => `${i + 2}. ${it}`),
      // `${routine.length + 1}. STOP HERE - Do not do any other agent's work`,
      // `${routine.length + 2}. MANDATORY: You MUST call transfer_to_supervisor_agent function RIGHT NOW to return control`,
      // `${routine.length + 3}. DO NOT END YOUR RESPONSE WITHOUT CALLING THE TRANSFER FUNCTION`,
    );
  } else {
    lines.push(
      'CRITICAL: end the generation by calling transfer_to_supervisor_agent tool',
    );
  }

  return lines.join('\n');
};

type TransferResult = { lastActiveAgent: string; currentActiveAgent: string };
export type TransferTool = { output: TransferResult };
export function isTransferToolResult(
  call: unknown | undefined,
): call is TransferTool {
  if (!call) {
    return false;
  }
  if (typeof call !== 'object') {
    return false;
  }
  if (!('output' in call)) {
    return false;
  }
  const lastActiveAgent = (call.output as Record<string, string>)
    .lastActiveAgent;

  if (!lastActiveAgent) {
    return false;
  }
  return true;
}

export function lastTransferResult(messages: ResponseMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    for (let i = message.parts.length - 1; i >= 0; i--) {
      const part = message.parts[i];
      if (
        part.type === 'dynamic-tool' &&
        part.toolName.startsWith('transfer_to_') &&
        part.state === 'output-available' &&
        isTransferToolResult(part)
      ) {
        return part.output;
      }
    }
  }
  return undefined;
}
