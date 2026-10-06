import { z } from 'zod';

// Rows of ClickHouse's system tables as its JSON output formats return them:
// String columns are strings.

/** `SELECT name, type FROM system.columns`. */
export const columnRow = z.object({ name: z.string(), type: z.string() });
