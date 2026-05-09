import {
  type SubcommandDefinition,
  buildSubcommandRepair,
  repairQuotedArg,
} from '@deepagents/context';

function repairDbNameAndQuery(rawArgs: string): string | null {
  const trimmed = rawArgs.trim();
  if (!trimmed) return null;

  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) return null;

  const dbName = trimmed.slice(0, firstSpace);
  const rest = trimmed.slice(firstSpace + 1);
  const repaired = repairQuotedArg(rest);
  if (repaired == null) return null;

  return `${dbName} ${repaired}`;
}

const inertHandler = () => ({ stdout: '', stderr: '', exitCode: 0 });

const repair = buildSubcommandRepair('sql', {
  run: {
    usage: 'run <db> "SELECT ..."',
    description: 'Execute query against <db> and store results',
    repair: repairDbNameAndQuery,
    handler: inertHandler,
  },
  validate: {
    usage: 'validate <db> "SELECT ..."',
    description: 'Validate query syntax against <db>',
    repair: repairDbNameAndQuery,
    handler: inertHandler,
  },
} satisfies Record<string, SubcommandDefinition>);

export function repairSqlCommand(command: string): string {
  return repair(command);
}
