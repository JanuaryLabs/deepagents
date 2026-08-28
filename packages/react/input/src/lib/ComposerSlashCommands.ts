import type { ComposerItemEntry } from './ComposerTypes.ts';
import { isVisibleInPhase } from './ComposerVisibility.ts';

type RankedSlashCommand = {
  command: ComposerItemEntry;
  rank: number;
  index: number;
};

export function slashCommandMatches(
  query: string,
  slashCommands: ComposerItemEntry[],
  hasInteracted: boolean,
) {
  const normalized = normalizeSlashQuery(query);
  const visibleCommands = slashCommands.filter(
    (command) =>
      isSlashCommandEnabled(command) &&
      isVisibleInPhase(command.visibility, hasInteracted),
  );

  if (!normalized) {
    return visibleCommands.slice(0, 10);
  }

  return visibleCommands
    .map((command, index): RankedSlashCommand | null => {
      const rank = slashCommandMatchRank(normalized, command);
      return rank === null ? null : { command, rank, index };
    })
    .filter((match): match is RankedSlashCommand => Boolean(match))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((match) => match.command)
    .slice(0, 10);
}

export function findSlashCommandByName(
  name: string,
  slashCommands: ComposerItemEntry[],
) {
  const normalized = name.toLowerCase();
  return slashCommands.find(
    (command) =>
      isSlashCommandEnabled(command) &&
      (command.value.toLowerCase() === normalized ||
        slashCommandAliases(command).some((alias) => alias === normalized)),
  );
}

function normalizeSlashQuery(query: string) {
  return query.slice(1).toLowerCase();
}

function isSlashCommandEnabled(command: ComposerItemEntry) {
  return command.availability !== 'disabled';
}

function slashCommandAliases(command: ComposerItemEntry) {
  return (command.aliases ?? []).map((alias) => alias.toLowerCase());
}

function slashCommandMatchRank(normalized: string, command: ComposerItemEntry) {
  const commandName = command.value.toLowerCase();
  const aliases = slashCommandAliases(command);
  const searchTerms = [
    command.label.toLowerCase(),
    ...(command.searchTerms ?? []).map((term) => term.toLowerCase()),
  ];

  if (commandName === normalized) {
    return 0;
  }
  if (aliases.some((alias) => alias === normalized)) {
    return 1;
  }
  if (commandName.startsWith(normalized)) {
    return 2;
  }
  if (aliases.some((alias) => alias.startsWith(normalized))) {
    return 3;
  }
  if (searchTerms.some((term) => term.startsWith(normalized))) {
    return 4;
  }
  return null;
}
