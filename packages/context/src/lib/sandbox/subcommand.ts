import type { CommandResult } from 'bash-tool';
import { type CommandContext, defineCommand, parse } from 'just-bash';

/**
 * Describes one subcommand inside a subcommand group (e.g. `sql run`,
 * `sql validate`). Each subcommand has usage/description strings used to
 * generate the group's usage message, an optional arg-repair function that
 * fixes common LLM over-escaping, and the handler that implements it.
 */
export interface SubcommandDefinition {
  usage: string;
  description: string;
  /**
   * Optional repair pass applied to the subcommand's raw arg string before
   * the shell parser sees it. Return `null` to leave the raw args unchanged.
   */
  repair?: (rawArgs: string) => string | null;
  handler: (
    args: string[],
    ctx: CommandContext,
  ) => CommandResult | Promise<CommandResult>;
}

/**
 * Creates a custom bash command that dispatches to one of several subcommand
 * handlers based on the first positional arg. Unknown or missing subcommands
 * print an auto-generated usage message to stderr with exit code 1.
 *
 * @example
 * const sqlCommand = defineSubcommandGroup('sql', {
 *   run:      { usage: 'run "SELECT ..."',      description: 'Execute query',  handler: ... },
 *   validate: { usage: 'validate "SELECT ..."', description: 'Validate only', handler: ... },
 * });
 * new Bash({ customCommands: [sqlCommand] });
 */
export function defineSubcommandGroup(
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

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds a pre-parse repair function for a subcommand group. If the raw
 * command matches `<name> <sub> <args...>` and fails to parse, the matching
 * subcommand's `repair` function is invoked on the args string. The repaired
 * command is only returned if it itself parses — otherwise the original is
 * returned unchanged. Typically wired into `onBeforeBashCall`.
 */
/**
 * Strips a single layer of matching outer `"` or `'` quotes from a string,
 * trimming surrounding whitespace. If the input is not wrapped in a matching
 * pair, returns it trimmed but otherwise unchanged.
 *
 * @example
 * stripQuoteArtifacts('"SELECT 1"')   // 'SELECT 1'
 * stripQuoteArtifacts("'SELECT 1'")   // 'SELECT 1'
 * stripQuoteArtifacts('SELECT 1')     // 'SELECT 1'
 * stripQuoteArtifacts('"unclosed')    // 'unclosed'  (leading " stripped, no matching closer)
 */
export function stripQuoteArtifacts(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('"')) {
    s = s.slice(1);
    if (s.endsWith('"')) s = s.slice(0, -1);
  } else if (s.startsWith("'")) {
    s = s.slice(1);
    if (s.endsWith("'")) s = s.slice(0, -1);
  }
  return s.trim();
}

/**
 * Pre-parse repair for a subcommand's raw arg string. Fires when the
 * surrounding command fails to parse (via `buildSubcommandRepair`). Strips
 * any leading/trailing quote, escapes inner single quotes with the POSIX
 * `'\''` idiom, and wraps the result in single quotes so the shell parser
 * will treat the payload as an opaque literal on the next pass.
 *
 * Returns `null` when the repaired arg string would be empty.
 *
 * NOTE: this solves only the *malformed-quoting* failure mode. If the
 * handler also needs to undo literal escape sequences (`\n`, `\(`, etc.)
 * inside successfully-parsed args, that is a separate post-parse decode
 * step owned by the caller.
 */
export function repairQuotedArg(rawArgs: string): string | null {
  const inner = stripQuoteArtifacts(rawArgs);
  if (!inner) return null;
  const escaped = inner.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

export function buildSubcommandRepair(
  name: string,
  subcommands: Record<string, SubcommandDefinition>,
) {
  const subNames = Object.keys(subcommands).map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `^(\\s*${escapeRegExp(name)}\\s+(?:${subNames}))\\s+([\\s\\S]+)$`,
  );

  return function repair(raw: string): string {
    const match = raw.match(pattern);
    if (!match) return raw;

    try {
      parse(raw);
      return raw;
    } catch {
      // fall through to repair
    }

    const [, prefix, argsPart] = match;
    const sub = prefix.trim().split(/\s+/).pop()!;
    const repairFn = subcommands[sub]?.repair;
    if (!repairFn) return raw;

    const repairedArgs = repairFn(argsPart);
    if (repairedArgs == null) return raw;

    const repaired = `${prefix} ${repairedArgs}`;
    try {
      parse(repaired);
      return repaired;
    } catch {
      return raw;
    }
  };
}
