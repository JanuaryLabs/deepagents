import { z } from 'zod';

/**
 * A BIGINT column. pg and mssql return BIGINT as a decimal string, because it
 * can exceed Number.MAX_SAFE_INTEGER; a pool whose pg type parser turns int8
 * into a number returns a number instead.
 */
export const bigintColumn = z
  .union([z.number(), z.string().regex(/^-?\d+$/)])
  .transform(Number);

/** A JSON object column, such as chat metadata. */
export const jsonObject = z.record(z.string(), z.unknown());

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** Parses a TEXT column that stores a JSON object. */
export function parseJsonObject(text: string): Record<string, unknown> {
  return jsonObject.parse(parseJson(text));
}
