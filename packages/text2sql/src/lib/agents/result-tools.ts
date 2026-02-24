import { tool } from 'ai';
import { createBashTool } from 'bash-tool';
import chalk from 'chalk';
import {
  Bash,
  type CommandContext,
  type CommandNode,
  type IFileSystem,
  MountableFs,
  OverlayFs,
  type ScriptNode,
  type WordNode,
  defineCommand,
  parse,
} from 'just-bash';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as path from 'node:path';
import { v7 } from 'uuid';
import z from 'zod';

import type { SkillPathMapping } from '@deepagents/context';

import type { Adapter } from '../adapters/adapter.ts';

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface SubcommandDefinition {
  usage: string;
  description: string;
  handler: (
    args: string[],
    ctx: CommandContext,
  ) => CommandResult | Promise<CommandResult>;
}

/**
 * Creates a command with subcommands using a declarative API.
 *
 * @example
 * const cmd = createCommand('sql', {
 *   run: {
 *     usage: 'run "SELECT ..."',
 *     description: 'Execute query',
 *     handler: async (args, ctx) => ({ stdout: '...', stderr: '', exitCode: 0 })
 *   }
 * });
 */
function createCommand(
  name: string,
  subcommands: Record<string, SubcommandDefinition>,
) {
  const usageLines = Object.entries(subcommands)
    .map(([, def]) => `  ${name} ${def.usage.padEnd(30)} ${def.description}`)
    .join('\n');

  return defineCommand(name, async (args, ctx) => {
    const subcommand = args[0];
    const restArgs = args.slice(1);

    if (subcommand && subcommand in subcommands) {
      return subcommands[subcommand].handler(restArgs, ctx);
    }

    return {
      stdout: '',
      stderr: `${name}: ${subcommand ? `unknown subcommand '${subcommand}'` : 'missing subcommand'}\n\nUsage:\n${usageLines}`,
      exitCode: 1,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL Command Implementation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates that a query is read-only (SELECT or WITH).
 */
function validateReadOnly(query: string): { valid: boolean; error?: string } {
  const upper = query.toUpperCase().trim();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return { valid: false, error: 'only SELECT or WITH queries allowed' };
  }
  return { valid: true };
}

type MetaStore = AsyncLocalStorage<{ value?: Record<string, unknown> }>;

function createSqlCommand(adapter: Adapter, metaStore: MetaStore) {
  return createCommand('sql', {
    run: {
      usage: 'run "SELECT ..."',
      description: 'Execute query and store results',
      handler: async (args, ctx) => {
        const rawQuery = args.join(' ').trim();

        if (!rawQuery) {
          return {
            stdout: '',
            stderr: 'sql run: no query provided',
            exitCode: 1,
          };
        }

        const validation = validateReadOnly(rawQuery);
        if (!validation.valid) {
          return {
            stdout: '',
            stderr: `sql run: ${validation.error}`,
            exitCode: 1,
          };
        }

        const query = adapter.format(rawQuery);
        const store = metaStore.getStore();
        if (store) store.value = { formattedSql: query };

        const syntaxError = await adapter.validate(query);
        if (syntaxError) {
          return {
            stdout: '',
            stderr: `sql run: ${syntaxError}`,
            exitCode: 1,
          };
        }

        try {
          const rows = await adapter.execute(query);
          const rowsArray = Array.isArray(rows) ? rows : [];
          const content = JSON.stringify(rowsArray, null, 2);

          const filename = `${v7()}.json`;
          const sqlPath = `/sql/${filename}`;

          await ctx.fs.mkdir('/sql', { recursive: true });
          await ctx.fs.writeFile(sqlPath, content);

          const columns =
            rowsArray.length > 0 ? Object.keys(rowsArray[0] as object) : [];

          return {
            stdout:
              [
                `results stored in ${sqlPath}`,
                `columns: ${columns.join(', ') || '(none)'}`,
                `rows: ${rowsArray.length}`,
              ].join('\n') + '\n',
            stderr: '',
            exitCode: 0,
          };
        } catch (error) {
          return {
            stdout: '',
            stderr: `sql run: ${error instanceof Error ? error.message : String(error)}`,
            exitCode: 1,
          };
        }
      },
    },
    validate: {
      usage: 'validate "SELECT ..."',
      description: 'Validate query syntax',
      handler: async (args) => {
        const rawQuery = args.join(' ').trim();

        if (!rawQuery) {
          return {
            stdout: '',
            stderr: 'sql validate: no query provided',
            exitCode: 1,
          };
        }

        const validation = validateReadOnly(rawQuery);
        if (!validation.valid) {
          return {
            stdout: '',
            stderr: `sql validate: ${validation.error}`,
            exitCode: 1,
          };
        }

        const query = adapter.format(rawQuery);
        const store = metaStore.getStore();
        if (store) store.value = { formattedSql: query };

        const syntaxError = await adapter.validate(query);
        if (syntaxError) {
          return {
            stdout: '',
            stderr: `sql validate: ${syntaxError}`,
            exitCode: 1,
          };
        }

        return {
          stdout: 'valid\n',
          stderr: '',
          exitCode: 0,
        };
      },
    },
  });
}

const BLOCKED_DB_CLIENT_COMMANDS = new Set([
  'psql',
  'sqlite3',
  'mysql',
  'duckdb',
]);
const BLOCKED_RAW_SQL_COMMANDS = new Set(['select', 'with']);
const ALLOWED_SQL_PROXY_SUBCOMMANDS = new Set(['run', 'validate']);
const SHELL_INTERPRETER_COMMANDS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
]);
const SQL_PROXY_ENFORCEMENT_MESSAGE = [
  'Direct database querying through bash is blocked.',
  'Use SQL proxy commands in this order:',
  '1) sql validate "SELECT ..."',
  '2) sql run "SELECT ..."',
].join('\n');

type SqlInspectionMode = 'blocked-only' | 'block-all-sql';

type FunctionDefCommand = Extract<CommandNode, { type: 'FunctionDef' }>;

interface InspectionContext {
  functionDefinitions: Map<string, FunctionDefCommand>;
  callStack: Set<string>;
}

function cloneInspectionContext(context: InspectionContext): InspectionContext {
  return {
    functionDefinitions: new Map(context.functionDefinitions),
    callStack: new Set(context.callStack),
  };
}

function asStaticWordText(word: WordNode | null | undefined): string | null {
  if (!word) {
    return null;
  }
  return asStaticWordPartText(
    word.parts as unknown as Array<Record<string, unknown>>,
  );
}

function asStaticWordPartText(
  parts: Array<Record<string, unknown>>,
): string | null {
  let text = '';

  for (const part of parts) {
    const type = part.type;

    if (type === 'Literal' || type === 'SingleQuoted' || type === 'Escaped') {
      if (typeof part.value !== 'string') {
        return null;
      }
      text += part.value;
      continue;
    }

    if (type === 'DoubleQuoted') {
      if (!Array.isArray(part.parts)) {
        return null;
      }
      const inner = asStaticWordPartText(
        part.parts as Array<Record<string, unknown>>,
      );
      if (inner == null) {
        return null;
      }
      text += inner;
      continue;
    }

    return null;
  }

  return text;
}

function isScriptNode(value: unknown): value is ScriptNode {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const node = value as Record<string, unknown>;
  return node.type === 'Script' && Array.isArray(node.statements);
}

function scriptContainsBlockedCommand(
  script: ScriptNode,
  context: InspectionContext,
  mode: SqlInspectionMode = 'blocked-only',
): boolean {
  return statementsContainBlockedCommand(script.statements, context, mode);
}

function statementsContainBlockedCommand(
  statements: Array<{ pipelines: Array<{ commands: CommandNode[] }> }>,
  context: InspectionContext,
  mode: SqlInspectionMode,
): boolean {
  for (const statement of statements) {
    if (statementContainsBlockedCommand(statement, context, mode)) {
      return true;
    }
  }
  return false;
}

function statementContainsBlockedCommand(
  statement: { pipelines: Array<{ commands: CommandNode[] }> },
  context: InspectionContext,
  mode: SqlInspectionMode,
): boolean {
  for (const pipeline of statement.pipelines) {
    if (pipelineContainsBlockedCommand(pipeline, context, mode)) {
      return true;
    }
  }
  return false;
}

function pipelineContainsBlockedCommand(
  pipeline: { commands: CommandNode[] },
  context: InspectionContext,
  mode: SqlInspectionMode,
): boolean {
  for (const command of pipeline.commands) {
    if (command.type === 'FunctionDef') {
      context.functionDefinitions.set(command.name, command);
      continue;
    }
    if (commandContainsBlockedCommand(command, context, mode)) {
      return true;
    }
  }
  return false;
}

function stringCommandContainsBlockedCommand(
  command: string,
  context: InspectionContext,
  mode: SqlInspectionMode = 'blocked-only',
): boolean {
  let script: ScriptNode;
  try {
    script = parse(command);
  } catch {
    return false;
  }

  return scriptContainsBlockedCommand(
    script,
    cloneInspectionContext(context),
    mode,
  );
}

function wordContainsBlockedCommand(
  word: WordNode | null | undefined,
  context: InspectionContext,
  mode: SqlInspectionMode,
): boolean {
  if (!word) {
    return false;
  }

  return wordPartContainsBlockedCommand(
    word.parts as unknown as Array<Record<string, unknown>>,
    context,
    mode,
  );
}

function wordPartContainsBlockedCommand(
  parts: Array<Record<string, unknown>>,
  context: InspectionContext,
  mode: SqlInspectionMode,
): boolean {
  for (const part of parts) {
    if (partContainsBlockedCommand(part, context, mode)) {
      return true;
    }
  }
  return false;
}

function partContainsBlockedCommand(
  node: Record<string, unknown>,
  context: InspectionContext,
  mode: SqlInspectionMode,
): boolean {
  const type = node.type;

  if (type === 'CommandSubstitution' || type === 'ProcessSubstitution') {
    if (isScriptNode(node.body)) {
      return scriptContainsBlockedCommand(
        node.body,
        cloneInspectionContext(context),
        mode,
      );
    }
    return false;
  }

  if (type === 'ArithCommandSubst' && typeof node.command === 'string') {
    return stringCommandContainsBlockedCommand(node.command, context, mode);
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'object' && item !== null) {
          if (
            partContainsBlockedCommand(
              item as Record<string, unknown>,
              context,
              mode,
            )
          ) {
            return true;
          }
        }
      }
      continue;
    }

    if (typeof value === 'object' && value !== null) {
      if (
        partContainsBlockedCommand(
          value as Record<string, unknown>,
          context,
          mode,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function functionInvocationContainsBlockedCommand(
  functionName: string,
  context: InspectionContext,
  mode: SqlInspectionMode,
): boolean {
  const definition = context.functionDefinitions.get(functionName);
  if (!definition) {
    return false;
  }

  if (context.callStack.has(functionName)) {
    return false;
  }

  const invocationContext = cloneInspectionContext(context);
  invocationContext.callStack.add(functionName);
  return commandContainsBlockedCommand(
    definition.body,
    invocationContext,
    mode,
  );
}

function getShellCommandPayload(args: WordNode[]): {
  foundCommandFlag: boolean;
  payload: string | null;
} {
  const hasShortCommandFlag = (token: string): boolean => {
    // Parse compact short-option clusters like -c, -lc, -cl, -xec
    if (!token.startsWith('-') || token.startsWith('--') || token.length <= 1) {
      return false;
    }

    let hasCommandFlag = false;
    for (let index = 1; index < token.length; index += 1) {
      const charCode = token.charCodeAt(index);
      const isLowercase = charCode >= 97 && charCode <= 122;
      const isUppercase = charCode >= 65 && charCode <= 90;
      if (!isLowercase && !isUppercase) {
        return false;
      }
      if (token[index] === 'c') {
        hasCommandFlag = true;
      }
    }

    return hasCommandFlag;
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = asStaticWordText(args[index]);
    if (!token) {
      continue;
    }

    if (token === '--') {
      break;
    }

    if (token === '--command') {
      return {
        foundCommandFlag: true,
        payload: asStaticWordText(args[index + 1]),
      };
    }

    if (token.startsWith('--command=')) {
      return {
        foundCommandFlag: true,
        payload: token.slice('--command='.length),
      };
    }

    if (token === '-c' || hasShortCommandFlag(token)) {
      return {
        foundCommandFlag: true,
        payload: asStaticWordText(args[index + 1]),
      };
    }
  }

  return { foundCommandFlag: false, payload: null };
}

function commandContainsBlockedCommand(
  command: CommandNode,
  context: InspectionContext,
  mode: SqlInspectionMode,
): boolean {
  switch (command.type) {
    case 'SimpleCommand':
      return isBlockedSimpleCommand(command, context, mode);
    case 'If':
      return (
        command.clauses.some(
          (clause) =>
            statementsContainBlockedCommand(
              clause.condition,
              cloneInspectionContext(context),
              mode,
            ) ||
            statementsContainBlockedCommand(
              clause.body,
              cloneInspectionContext(context),
              mode,
            ),
        ) ||
        (command.elseBody
          ? statementsContainBlockedCommand(
              command.elseBody,
              cloneInspectionContext(context),
              mode,
            )
          : false)
      );
    case 'For':
    case 'CStyleFor':
      return statementsContainBlockedCommand(
        command.body,
        cloneInspectionContext(context),
        mode,
      );
    case 'While':
    case 'Until':
      return (
        statementsContainBlockedCommand(
          command.condition,
          cloneInspectionContext(context),
          mode,
        ) ||
        statementsContainBlockedCommand(
          command.body,
          cloneInspectionContext(context),
          mode,
        )
      );
    case 'Case':
      return command.items.some((item) =>
        statementsContainBlockedCommand(
          item.body,
          cloneInspectionContext(context),
          mode,
        ),
      );
    case 'Subshell':
    case 'Group':
      return statementsContainBlockedCommand(
        command.body,
        cloneInspectionContext(context),
        mode,
      );
    case 'FunctionDef':
      return false;
    case 'ArithmeticCommand':
    case 'ConditionalCommand':
      return false;
    default: {
      const _unreachable: never = command;
      return _unreachable;
    }
  }
}

function isBlockedSimpleCommand(
  command: {
    name: WordNode | null;
    args: WordNode[];
    assignments: Array<{
      value: WordNode | null;
      array: WordNode[] | null;
    }>;
    redirections: Array<{
      target: { type?: string; content?: WordNode };
    }>;
  },
  context: InspectionContext,
  mode: SqlInspectionMode,
): boolean {
  if (wordContainsBlockedCommand(command.name, context, mode)) {
    return true;
  }

  if (
    command.args.some((arg) => wordContainsBlockedCommand(arg, context, mode))
  ) {
    return true;
  }

  if (
    command.assignments.some(
      (assignment) =>
        wordContainsBlockedCommand(assignment.value, context, mode) ||
        (assignment.array?.some((value) =>
          wordContainsBlockedCommand(value, context, mode),
        ) ??
          false),
    )
  ) {
    return true;
  }

  if (
    command.redirections.some((redirection) => {
      if (redirection.target.type === 'Word') {
        return wordContainsBlockedCommand(
          redirection.target as unknown as WordNode,
          context,
          mode,
        );
      }
      if (redirection.target.type === 'HereDoc' && redirection.target.content) {
        return wordContainsBlockedCommand(
          redirection.target.content,
          context,
          mode,
        );
      }
      return false;
    })
  ) {
    return true;
  }

  const commandName = asStaticWordText(command.name);
  if (!commandName) {
    return false;
  }

  const normalizedName = path.posix.basename(commandName).toLowerCase();

  if (BLOCKED_DB_CLIENT_COMMANDS.has(normalizedName)) {
    return true;
  }

  if (BLOCKED_RAW_SQL_COMMANDS.has(normalizedName)) {
    return true;
  }

  if (SHELL_INTERPRETER_COMMANDS.has(normalizedName)) {
    const shellCommand = getShellCommandPayload(command.args);
    if (shellCommand.foundCommandFlag) {
      if (!shellCommand.payload) {
        return true;
      }
      if (
        stringCommandContainsBlockedCommand(
          shellCommand.payload,
          context,
          'block-all-sql',
        )
      ) {
        return true;
      }
    }
  }

  if (normalizedName === 'sql') {
    const subcommand = asStaticWordText(command.args[0])?.toLowerCase();
    if (!subcommand) {
      return true;
    }
    if (mode === 'block-all-sql') {
      return true;
    }
    return !ALLOWED_SQL_PROXY_SUBCOMMANDS.has(subcommand);
  }

  if (functionInvocationContainsBlockedCommand(commandName, context, mode)) {
    return true;
  }

  return false;
}

function getSqlProxyEnforcementResult(command: string): CommandResult | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  let script: ScriptNode;
  try {
    script = parse(trimmed);
  } catch {
    return null;
  }

  const blocked = scriptContainsBlockedCommand(script, {
    functionDefinitions: new Map(),
    callStack: new Set(),
  });
  if (!blocked) {
    return null;
  }

  return {
    stdout: '',
    stderr: `${SQL_PROXY_ENFORCEMENT_MESSAGE}\n`,
    exitCode: 1,
  };
}

/**
 * Options for creating result tools.
 */
export interface ResultToolsOptions {
  /** Database adapter for executing SQL queries */
  adapter: Adapter;
  /** Skill mounts mapping host paths to sandbox paths */
  skillMounts: SkillPathMapping[];
  /** Filesystem for storage */
  filesystem: IFileSystem;
}

/**
 * Creates bash tool with integrated sql command.
 *
 * The agent sees only one tool: `bash`
 * SQL is executed via: sql run "SELECT ..."
 */
export async function createResultTools(options: ResultToolsOptions) {
  const { adapter, skillMounts, filesystem: baseFs } = options;

  const metaStore: MetaStore = new AsyncLocalStorage();
  const sqlCommand = createSqlCommand(adapter, metaStore);

  const fsMounts = skillMounts.map(({ host, sandbox }) => ({
    mountPoint: path.dirname(sandbox),
    filesystem: new OverlayFs({
      root: path.dirname(host),
      mountPoint: '/',
      readOnly: true,
    }),
  }));

  const filesystem = new MountableFs({
    base: baseFs,
    mounts: fsMounts,
  });

  const bashInstance = new Bash({
    customCommands: [sqlCommand],
    fs: filesystem,
  });

  const { sandbox, tools } = await createBashTool({
    sandbox: bashInstance,
    destination: '/',
    extraInstructions:
      'Every bash tool call must include a brief non-empty "reasoning" input explaining why the command is needed.',
    onBeforeBashCall: ({ command }) => {
      console.log(chalk.cyan(`[onBeforeBashCall]: ${command}`));
      return { command };
    },
    onAfterBashCall: ({ result }) => {
      if (result.exitCode !== 0) {
        console.log(chalk.yellow(`[onAfterBashCall]: ${result.exitCode}`));
      }
      return { result };
    },
  });

  const guardedSandbox = {
    ...sandbox,
    executeCommand: async (command: string) => {
      const blockedResult = getSqlProxyEnforcementResult(command);
      if (blockedResult) {
        return blockedResult;
      }
      return sandbox.executeCommand(command);
    },
  };

  const bash = tool({
    ...(tools as any).bash,
    inputSchema: z.object({
      command: z.string().describe('The bash command to execute'),
      reasoning: z
        .string()
        .trim()
        .describe('Brief reason for executing this command'),
    }),
    execute: async ({ command }, execOptions) => {
      const execute = tools.bash.execute;
      if (!execute) {
        throw new Error('bash tool execution is not available');
      }

      const blockedResult = getSqlProxyEnforcementResult(command);
      if (blockedResult) {
        return blockedResult;
      }

      return metaStore.run({}, async () => {
        const result = await execute({ command }, execOptions);
        const meta = metaStore.getStore()?.value;
        return meta ? { ...result, meta } : result;
      });
    },
    toModelOutput: ({ output }) => {
      if (typeof output !== 'object' || output === null) {
        return { type: 'json' as const, value: output };
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { meta, ...rest } = output as unknown as Record<string, unknown>;
      return { type: 'json' as const, value: rest };
    },
  });

  return {
    sandbox: guardedSandbox,
    tools: {
      ...tools,
      bash,
    },
  };
}
