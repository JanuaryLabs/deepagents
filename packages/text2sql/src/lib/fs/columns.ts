import z from 'zod';

/** fs_entries.type: every store writes one of these three. */
export const entryType = z.enum(['file', 'directory', 'symlink']);

/**
 * A BIGINT column. pg and mssql return BIGINT as a decimal string, because it
 * can exceed Number.MAX_SAFE_INTEGER; a pg pool whose int8 type parser returns
 * numbers yields a number instead.
 */
export const bigintColumn = z
  .union([z.number(), z.string().regex(/^-?\d+$/)])
  .transform(Number);
