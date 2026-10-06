import { z } from 'zod';

// Rows of PostgreSQL catalog queries, as node-postgres returns them with its
// default type parsers: name, text and information_schema identifier columns
// are strings.

/** `SELECT column_name, data_type FROM information_schema.columns`. */
export const columnRow = z.object({
  column_name: z.string().nullable(),
  data_type: z.string().nullable(),
});
