import { quotedIdentifier } from '@duckdb/node-api';

export type DuckDBRelationName = {
  catalog?: string;
  schema?: string;
  table: string;
};

export function formatDuckDBIdentifierPath(parts: readonly string[]): string {
  return parts.map(quotedIdentifier).join('.');
}

export function parseDuckDBRelationName(name: string): DuckDBRelationName {
  const parts = splitIdentifierPath(name);
  if (parts.length === 1) return { table: parts[0]! };
  if (parts.length === 2) {
    return { schema: parts[0]!, table: parts[1]! };
  }
  if (parts.length === 3) {
    return { catalog: parts[0]!, schema: parts[1]!, table: parts[2]! };
  }
  throw new Error(`DuckDB relation must have at most three parts: ${name}`);
}

function splitIdentifierPath(input: string): string[] {
  const parts: string[] = [];
  let part = '';
  let quoted = false;

  for (let index = 0; index < input.length; index++) {
    const character = input[index]!;
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        part += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === '.' && !quoted) {
      if (!part) throw new Error(`Invalid DuckDB relation: ${input}`);
      parts.push(part);
      part = '';
    } else {
      part += character;
    }
  }

  if (quoted || !part) throw new Error(`Invalid DuckDB relation: ${input}`);
  parts.push(part);
  return parts;
}
