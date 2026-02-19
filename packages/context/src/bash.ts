import {
  type SimpleCommandNode,
  type WordNode,
  parse as parseBash,
} from 'just-bash';

type WordPart = WordNode['parts'][number];

function wordPartToString(part: WordPart): string | null {
  switch (part.type) {
    case 'Literal':
    case 'SingleQuoted':
    case 'Escaped':
      return part.value;
    case 'ParameterExpansion':
      if (part.operation !== null) return null;
      return `$${part.parameter}`;
    case 'Glob':
      return part.pattern;
    case 'DoubleQuoted': {
      let value = '';
      for (const nestedPart of part.parts) {
        const nestedValue = wordPartToString(nestedPart);
        if (nestedValue === null) return null;
        value += nestedValue;
      }
      return value;
    }
    default:
      return null;
  }
}

function wordToString(word: WordNode): string | null {
  let value = '';
  for (const part of word.parts) {
    const partValue = wordPartToString(part);
    if (partValue === null) return null;
    value += partValue;
  }
  return value;
}

function parseSingleSimpleCommand(command: string): SimpleCommandNode | null {
  const normalized = command.trim();
  if (!normalized) return null;

  try {
    const script = parseBash(normalized);
    if (script.statements.length !== 1) return null;

    const statement = script.statements[0];
    if (
      statement.background ||
      statement.operators.length > 0 ||
      statement.pipelines.length !== 1
    ) {
      return null;
    }

    const pipeline = statement.pipelines[0];
    if (pipeline.negated || pipeline.timed || pipeline.commands.length !== 1) {
      return null;
    }

    const commandNode = pipeline.commands[0];
    if (commandNode.type !== 'SimpleCommand') return null;
    if (
      commandNode.assignments.length > 0 ||
      commandNode.redirections.length > 0 ||
      !commandNode.name
    ) {
      return null;
    }

    return commandNode;
  } catch {
    return null;
  }
}

export function extractBashCommand(
  command: string,
  commandPath: readonly [string, ...string[]],
): string[] | null {
  const commandNode = parseSingleSimpleCommand(command);
  if (!commandNode || !commandNode.name) return null;

  const words: WordNode[] = [commandNode.name, ...commandNode.args];
  if (words.length < commandPath.length) return null;

  const values: string[] = [];
  for (const word of words) {
    const value = wordToString(word);
    if (value === null) return null;
    values.push(value);
  }

  for (let index = 0; index < commandPath.length; index++) {
    if (values[index] !== commandPath[index]) {
      return null;
    }
  }

  return values.slice(commandPath.length);
}

console.log(extractBashCommand('fetch "Hello, world!"', ['fetch']));
