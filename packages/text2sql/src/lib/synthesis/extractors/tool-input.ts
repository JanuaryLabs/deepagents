import z from 'zod';

// The tool is the caller's, so only the field the extractors read is checked.
const sqlToolInput = z.object({ sql: z.string() });

/**
 * The SQL a tool call ran, read from its input, or undefined when the input
 * carries no SQL string.
 */
export function toolInputSql(input: unknown): string | undefined {
  const parsed = sqlToolInput.safeParse(input);
  return parsed.success ? parsed.data.sql : undefined;
}
