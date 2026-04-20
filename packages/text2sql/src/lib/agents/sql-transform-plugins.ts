import type { CommandResult } from 'bash-tool';
import type {
  CommandNode,
  ScriptNode,
  TransformContext,
  TransformPlugin,
  TransformResult,
  WordNode,
} from 'just-bash';
import { parse, serialize } from 'just-bash';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { BashException } from '@deepagents/context';

// ─────────────────────────────────────────────────────────────────────────────
// Shared AST Utilities
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// SQL Proxy Enforcement Plugin
// ─────────────────────────────────────────────────────────────────────────────

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
const WRAPPER_COMMANDS = new Set(['env', 'command', 'eval']);

const SQL_PROXY_ENFORCEMENT_MESSAGE = [
  'Direct database querying through bash is blocked.',
  'Use SQL proxy commands in this order:',
  '1) sql validate "SELECT ..."',
  '2) sql run "SELECT ..."',
].join('\n');

export class SqlProxyViolationError extends BashException {
  constructor() {
    super(SQL_PROXY_ENFORCEMENT_MESSAGE);
    this.name = 'SqlProxyViolationError';
  }

  format(): CommandResult {
    return { stdout: '', stderr: `${this.message}\n`, exitCode: 1 };
  }
}

type SqlInspectionMode = 'blocked-only' | 'block-all-sql';

type FunctionDefCommand = Extract<CommandNode, { type: 'FunctionDef' }>;

interface InspectionContext {
  functionDefinitions: Map<string, FunctionDefCommand>;
  callStack: Set<string>;
}

interface CommandInspectionOptions {
  stdinFromPipe: boolean;
}

interface ShellInvocationDescriptor {
  kind: 'command' | 'script' | 'stdin' | 'none' | 'unknown';
  payload: string | null;
}

interface WrapperCommandResolution {
  kind: 'resolved' | 'none' | 'unknown';
  name?: WordNode;
  args?: WordNode[];
}

function cloneInspectionContext(context: InspectionContext): InspectionContext {
  return {
    functionDefinitions: new Map(context.functionDefinitions),
    callStack: new Set(context.callStack),
  };
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
  for (const [index, command] of pipeline.commands.entries()) {
    if (command.type === 'FunctionDef') {
      context.functionDefinitions.set(command.name, command);
      continue;
    }
    if (
      commandContainsBlockedCommand(command, context, mode, {
        stdinFromPipe: index > 0,
      })
    ) {
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
    { stdinFromPipe: false },
  );
}

function isAsciiLetter(character: string): boolean {
  const charCode = character.charCodeAt(0);
  return (
    (charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)
  );
}

function isAsciiDigit(character: string): boolean {
  const charCode = character.charCodeAt(0);
  return charCode >= 48 && charCode <= 57;
}

function isValidEnvVariableName(name: string): boolean {
  if (!name) {
    return false;
  }

  const firstChar = name[0];
  if (!(isAsciiLetter(firstChar) || firstChar === '_')) {
    return false;
  }

  for (let index = 1; index < name.length; index += 1) {
    const char = name[index];
    if (!(isAsciiLetter(char) || isAsciiDigit(char) || char === '_')) {
      return false;
    }
  }

  return true;
}

function isEnvAssignmentToken(token: string): boolean {
  const separatorIndex = token.indexOf('=');
  if (separatorIndex <= 0) {
    return false;
  }

  return isValidEnvVariableName(token.slice(0, separatorIndex));
}

function parseShortOptionCluster(option: string): {
  valid: boolean;
  hasCommandFlag: boolean;
  hasStdinFlag: boolean;
  consumesNextArg: boolean;
} {
  if (
    !option.startsWith('-') ||
    option.startsWith('--') ||
    option.length <= 1
  ) {
    return {
      valid: false,
      hasCommandFlag: false,
      hasStdinFlag: false,
      consumesNextArg: false,
    };
  }

  let hasCommandFlag = false;
  let hasStdinFlag = false;
  let consumesNextArg = false;

  for (let index = 1; index < option.length; index += 1) {
    const char = option[index];
    if (!isAsciiLetter(char)) {
      return {
        valid: false,
        hasCommandFlag: false,
        hasStdinFlag: false,
        consumesNextArg: false,
      };
    }

    if (char === 'c') {
      hasCommandFlag = true;
    } else if (char === 's') {
      hasStdinFlag = true;
    } else if (char === 'O' || char === 'o') {
      consumesNextArg = true;
    }
  }

  return { valid: true, hasCommandFlag, hasStdinFlag, consumesNextArg };
}

function getShellInvocationDescriptor(
  args: WordNode[],
): ShellInvocationDescriptor {
  let readsFromStdin = false;
  const longOptionsWithValue = new Set(['--rcfile', '--init-file']);

  for (let index = 0; index < args.length; index += 1) {
    const token = asStaticWordText(args[index]);
    if (token == null) {
      return { kind: 'unknown', payload: null };
    }

    if (token === '--') {
      if (index + 1 >= args.length) {
        break;
      }
      return {
        kind: 'script',
        payload: asStaticWordText(args[index + 1]),
      };
    }

    if (token === '--command') {
      return {
        kind: 'command',
        payload: asStaticWordText(args[index + 1]),
      };
    }

    if (token.startsWith('--command=')) {
      return {
        kind: 'command',
        payload: token.slice('--command='.length),
      };
    }

    if (token.startsWith('--')) {
      if (token.includes('=')) {
        continue;
      }

      if (longOptionsWithValue.has(token)) {
        if (index + 1 >= args.length) {
          return { kind: 'unknown', payload: null };
        }
        index += 1;
      }
      continue;
    }

    if (token.startsWith('-') && !token.startsWith('--')) {
      const parsed = parseShortOptionCluster(token);
      if (!parsed.valid) {
        return { kind: 'unknown', payload: null };
      }

      if (parsed.hasCommandFlag) {
        return {
          kind: 'command',
          payload: asStaticWordText(args[index + 1]),
        };
      }

      if (parsed.hasStdinFlag) {
        readsFromStdin = true;
      }

      if (parsed.consumesNextArg) {
        if (index + 1 >= args.length) {
          return { kind: 'unknown', payload: null };
        }
        index += 1;
      }
      continue;
    }

    return {
      kind: 'script',
      payload: token,
    };
  }

  if (readsFromStdin) {
    return { kind: 'stdin', payload: null };
  }

  return { kind: 'none', payload: null };
}

function getHereDocPayload(
  redirections: Array<{
    target: { type?: string; content?: WordNode };
  }>,
): { hasHereDoc: boolean; payload: string | null } {
  const payloads: string[] = [];

  for (const redirection of redirections) {
    if (redirection.target.type !== 'HereDoc') {
      continue;
    }

    if (!redirection.target.content) {
      payloads.push('');
      continue;
    }

    const payload = asStaticWordText(redirection.target.content);
    if (payload == null) {
      return { hasHereDoc: true, payload: null };
    }

    payloads.push(payload);
  }

  if (payloads.length === 0) {
    return { hasHereDoc: false, payload: null };
  }

  return { hasHereDoc: true, payload: payloads.join('\n') };
}

function joinStaticWords(words: WordNode[]): string | null {
  const tokens: string[] = [];

  for (const word of words) {
    const token = asStaticWordText(word);
    if (token == null) {
      return null;
    }
    tokens.push(token);
  }

  return tokens.join(' ');
}

function resolveEnvWrapperCommand(args: WordNode[]): WrapperCommandResolution {
  let index = 0;

  while (index < args.length) {
    const token = asStaticWordText(args[index]);
    if (token == null) {
      return { kind: 'unknown' };
    }

    if (token === '--') {
      index += 1;
      break;
    }

    if (token === '-u' || token === '--unset' || token === '--chdir') {
      if (index + 1 >= args.length) {
        return { kind: 'unknown' };
      }
      index += 2;
      continue;
    }

    if (token.startsWith('--unset=') || token.startsWith('--chdir=')) {
      index += 1;
      continue;
    }

    if (
      token.startsWith('-') &&
      token !== '-' &&
      !isEnvAssignmentToken(token)
    ) {
      index += 1;
      continue;
    }

    if (isEnvAssignmentToken(token)) {
      index += 1;
      continue;
    }

    break;
  }

  if (index >= args.length) {
    return { kind: 'none' };
  }

  return {
    kind: 'resolved',
    name: args[index],
    args: args.slice(index + 1),
  };
}

function resolveCommandWrapperCommand(
  args: WordNode[],
): WrapperCommandResolution {
  let index = 0;
  let lookupOnly = false;

  while (index < args.length) {
    const token = asStaticWordText(args[index]);
    if (token == null) {
      return { kind: 'unknown' };
    }

    if (token === '--') {
      index += 1;
      break;
    }

    if (token === '-v' || token === '-V') {
      lookupOnly = true;
      index += 1;
      continue;
    }

    if (token.startsWith('-') && token !== '-') {
      index += 1;
      continue;
    }

    break;
  }

  if (lookupOnly || index >= args.length) {
    return { kind: 'none' };
  }

  return {
    kind: 'resolved',
    name: args[index],
    args: args.slice(index + 1),
  };
}

function commandContainsBlockedCommand(
  command: CommandNode,
  context: InspectionContext,
  mode: SqlInspectionMode,
  options: CommandInspectionOptions = { stdinFromPipe: false },
): boolean {
  switch (command.type) {
    case 'SimpleCommand':
      return isBlockedSimpleCommand(command, context, mode, options);
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
  options: CommandInspectionOptions,
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

  const inspectWrappedCommand = (
    resolved: WrapperCommandResolution,
  ): boolean => {
    if (resolved.kind === 'none') {
      return false;
    }

    if (resolved.kind === 'unknown' || !resolved.name || !resolved.args) {
      return true;
    }

    return isBlockedSimpleCommand(
      {
        name: resolved.name,
        args: resolved.args,
        assignments: [],
        redirections: [],
      },
      context,
      'block-all-sql',
      options,
    );
  };

  if (WRAPPER_COMMANDS.has(normalizedName)) {
    if (normalizedName === 'env') {
      return inspectWrappedCommand(resolveEnvWrapperCommand(command.args));
    }

    if (normalizedName === 'command') {
      return inspectWrappedCommand(resolveCommandWrapperCommand(command.args));
    }

    const evalScript = joinStaticWords(command.args);
    if (evalScript == null) {
      return true;
    }
    if (!evalScript.trim()) {
      return false;
    }
    return stringCommandContainsBlockedCommand(
      evalScript,
      context,
      'block-all-sql',
    );
  }

  if (SHELL_INTERPRETER_COMMANDS.has(normalizedName)) {
    const shellInvocation = getShellInvocationDescriptor(command.args);
    if (shellInvocation.kind === 'unknown') {
      return true;
    }

    if (shellInvocation.kind === 'command') {
      if (!shellInvocation.payload) {
        return true;
      }
      if (
        stringCommandContainsBlockedCommand(
          shellInvocation.payload,
          context,
          'block-all-sql',
        )
      ) {
        return true;
      }
      return false;
    }

    const hereDoc = getHereDocPayload(command.redirections);
    if (hereDoc.hasHereDoc) {
      if (hereDoc.payload == null) {
        return true;
      }
      if (
        hereDoc.payload.trim().length > 0 &&
        stringCommandContainsBlockedCommand(
          hereDoc.payload,
          context,
          'block-all-sql',
        )
      ) {
        return true;
      }
    }

    if (shellInvocation.kind === 'script') {
      return true;
    }

    if (options.stdinFromPipe || shellInvocation.kind === 'stdin') {
      return !hereDoc.hasHereDoc;
    }
  }

  if (functionInvocationContainsBlockedCommand(commandName, context, mode)) {
    return true;
  }

  return false;
}

export interface SqlProxyEnforcementMetadata {
  inspected: true;
}

export class SqlProxyEnforcementPlugin implements TransformPlugin<SqlProxyEnforcementMetadata> {
  name = 'sql-proxy-enforcement';

  transform(
    context: TransformContext,
  ): TransformResult<SqlProxyEnforcementMetadata> {
    const blocked = scriptContainsBlockedCommand(context.ast, {
      functionDefinitions: new Map(),
      callStack: new Set(),
    });

    if (blocked) {
      throw new SqlProxyViolationError();
    }

    return {
      ast: context.ast,
      metadata: { inspected: true },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SQL Backtick Rewrite Plugin
// ─────────────────────────────────────────────────────────────────────────────

function wordPartsContainBacktickSubstitution(
  parts: Array<Record<string, unknown>>,
): boolean {
  for (const part of parts) {
    if (
      part.type === 'CommandSubstitution' &&
      (part as Record<string, unknown>).legacy === true
    ) {
      return true;
    }

    if (part.type === 'DoubleQuoted' && Array.isArray(part.parts)) {
      if (
        wordPartsContainBacktickSubstitution(
          part.parts as Array<Record<string, unknown>>,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

export interface SqlBacktickRewriteMetadata {
  rewritten: boolean;
}

function isSqlBacktickCommand(
  cmd: CommandNode,
): cmd is Extract<CommandNode, { type: 'SimpleCommand' }> {
  if (cmd.type !== 'SimpleCommand') return false;
  if (cmd.assignments.length > 0 || cmd.redirections.length > 0) return false;
  if (asStaticWordText(cmd.name) !== 'sql') return false;
  if (cmd.args.length < 2) return false;

  const subcommand = asStaticWordText(cmd.args[0]);
  if (subcommand !== 'validate' && subcommand !== 'run') return false;

  const sqlArgs = cmd.args.slice(1);
  return sqlArgs.some((arg: WordNode) =>
    wordPartsContainBacktickSubstitution(
      arg.parts as unknown as Array<Record<string, unknown>>,
    ),
  );
}

function extractWordPartText(parts: Array<Record<string, unknown>>): string {
  let text = '';
  for (const part of parts) {
    const type = part.type;
    if (type === 'Literal' || type === 'SingleQuoted' || type === 'Escaped') {
      text += part.value as string;
    } else if (type === 'DoubleQuoted' && Array.isArray(part.parts)) {
      text += extractWordPartText(part.parts as Array<Record<string, unknown>>);
    } else if (type === 'CommandSubstitution' && part.legacy === true) {
      text += '`' + serialize(part.body as ScriptNode).trim() + '`';
    }
  }
  return text;
}

function extractSqlText(args: WordNode[]): string {
  return args
    .map((arg) =>
      extractWordPartText(
        arg.parts as unknown as Array<Record<string, unknown>>,
      ),
    )
    .join(' ');
}

function rewriteSqlBacktickCommand(
  cmd: Extract<CommandNode, { type: 'SimpleCommand' }>,
  ast: ScriptNode,
): CommandNode {
  const subcommand = asStaticWordText(cmd.args[0])!;
  const sqlArgs = cmd.args.slice(1);
  const unquotedSql = extractSqlText(sqlArgs);

  const hash = createHash('sha256')
    .update(serialize(ast))
    .digest('hex')
    .slice(0, 12);
  const sqlPath = `/tmp/sql-inline-${subcommand}-${hash}.sql`;
  const heredocTag = `SQL_${hash.toUpperCase()}`;

  const groupScript = [
    `{ cat > ${sqlPath} <<'${heredocTag}'`,
    unquotedSql,
    heredocTag,
    `sql ${subcommand} "$(cat ${sqlPath})"; }`,
  ].join('\n');

  const groupAst = parse(groupScript);
  return groupAst.statements[0].pipelines[0].commands[0];
}

function rewriteBackticksInCommands(
  commands: CommandNode[],
  ast: ScriptNode,
): boolean {
  let rewritten = false;
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    if (isSqlBacktickCommand(cmd)) {
      commands[i] = rewriteSqlBacktickCommand(cmd, ast);
      rewritten = true;
      continue;
    }

    if (cmd.type === 'If') {
      for (const clause of cmd.clauses) {
        if (rewriteBackticksInStatements(clause.condition, ast))
          rewritten = true;
        if (rewriteBackticksInStatements(clause.body, ast)) rewritten = true;
      }
      if (cmd.elseBody && rewriteBackticksInStatements(cmd.elseBody, ast)) {
        rewritten = true;
      }
    } else if (cmd.type === 'While' || cmd.type === 'Until') {
      if (rewriteBackticksInStatements(cmd.condition, ast)) rewritten = true;
      if (rewriteBackticksInStatements(cmd.body, ast)) rewritten = true;
    } else if (cmd.type === 'For' || cmd.type === 'CStyleFor') {
      if (rewriteBackticksInStatements(cmd.body, ast)) rewritten = true;
    } else if (cmd.type === 'Case') {
      for (const item of cmd.items) {
        if (rewriteBackticksInStatements(item.body, ast)) rewritten = true;
      }
    } else if (cmd.type === 'Subshell' || cmd.type === 'Group') {
      if (rewriteBackticksInStatements(cmd.body, ast)) rewritten = true;
    }
  }
  return rewritten;
}

function rewriteBackticksInStatements(
  statements: Array<{ pipelines: Array<{ commands: CommandNode[] }> }>,
  ast: ScriptNode,
): boolean {
  let rewritten = false;
  for (const statement of statements) {
    for (const pipeline of statement.pipelines) {
      if (rewriteBackticksInCommands(pipeline.commands, ast)) {
        rewritten = true;
      }
    }
  }
  return rewritten;
}

export class SqlBacktickRewritePlugin implements TransformPlugin<SqlBacktickRewriteMetadata> {
  name = 'sql-backtick-rewrite';

  transform(
    context: TransformContext,
  ): TransformResult<SqlBacktickRewriteMetadata> {
    const ast = context.ast;
    const rewritten = rewriteBackticksInStatements(ast.statements, ast);
    return { ast, metadata: { rewritten } };
  }
}
