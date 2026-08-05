/**
 * Temporary workaround for a node-sql-parser 5.4.0 PostgreSQL grammar
 * shortcoming: it rejects valid typed string constants such as
 * `TIMESTAMPTZ 'epoch'`. Remove this module and its parser retry once
 * node-sql-parser supports PostgreSQL typed string constants natively.
 */

const TYPE_BEFORE_LITERAL =
  /(?<type>(?:pg_catalog\.)?[A-Za-z_][A-Za-z0-9_$]*(?:\s+(?:varying|precision))?(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\s+(?:with|without)\s+time\s+zone)?)\s*$/i;
const TIME_ZONE_SUFFIX = /^\s+time\s+zone\s+/i;
const TIME_BEFORE_SUFFIX =
  /(?<type>time(?:stamp)?(?:\s*\(\s*\d+\s*\))?)\s+(?<qualifier>with|without)$/i;

export function recoverPostgresTypedLiteralParserGap(
  sql: string,
  error: unknown,
): string | null {
  const errorOffset = parserErrorOffset(error);
  if (errorOffset === null) return null;

  const prefix = sql.slice(0, errorOffset);
  let literalStart = errorOffset;
  let literalEnd = findLiteralEnd(sql, literalStart);
  let typeMatch = TYPE_BEFORE_LITERAL.exec(prefix);
  let type = typeMatch?.groups?.type;

  if (literalEnd === null) {
    const suffixMatch = TIME_ZONE_SUFFIX.exec(sql.slice(errorOffset));
    typeMatch = TIME_BEFORE_SUFFIX.exec(prefix);
    type =
      typeMatch?.groups?.type && typeMatch.groups.qualifier && suffixMatch
        ? `${typeMatch.groups.type} ${typeMatch.groups.qualifier} TIME ZONE`
        : undefined;
    literalStart = errorOffset + (suffixMatch?.[0].length ?? 0);
    literalEnd = findLiteralEnd(sql, literalStart);
  }
  if (!type || typeMatch?.index === undefined || literalEnd === null)
    return null;

  // PostgreSQL defines type 'value' and CAST('value' AS type) as equivalent.
  return (
    prefix.slice(0, typeMatch.index) +
    `CAST(${sql.slice(literalStart, literalEnd)} AS ${parserType(type)})` +
    sql.slice(literalEnd)
  );
}

function parserErrorOffset(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const location = Reflect.get(error, 'location');
  if (typeof location !== 'object' || location === null) return null;
  const start = Reflect.get(location, 'start');
  if (typeof start !== 'object' || start === null) return null;
  const offset = Reflect.get(start, 'offset');
  return typeof offset === 'number' ? offset : null;
}

function findLiteralEnd(sql: string, start: number): number | null {
  if (sql[start] !== "'") {
    const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
      sql.slice(start),
    )?.[0];
    if (!delimiter) return null;
    const end = sql.indexOf(delimiter, start + delimiter.length);
    return end === -1 ? null : end + delimiter.length;
  }

  let offset = start + 1;
  while (offset < sql.length) {
    if (sql[offset] === '\\') {
      offset += 2;
      continue;
    }
    if (sql[offset] !== "'") {
      offset++;
      continue;
    }
    if (sql[offset + 1] === "'") {
      offset += 2;
      continue;
    }
    return offset + 1;
  }
  return null;
}

function parserType(type: string): string {
  const unqualified = type.replace(/^pg_catalog\./i, '');
  const timetz = /^timetz(\s*\([^)]*\))?$/i.exec(unqualified);
  return timetz ? `TIME${timetz[1] ?? ''} WITH TIME ZONE` : unqualified;
}
