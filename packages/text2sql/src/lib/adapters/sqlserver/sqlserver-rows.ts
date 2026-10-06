import { z } from 'zod';

// Rows of SQL Server catalog queries, as mssql (tedious) returns them:
// nvarchar/sysname are strings, int/smallint/tinyint numbers, bit booleans,
// decimal/numeric numbers, and bigint decimal strings.

/** `INFORMATION_SCHEMA.COLUMNS` name and data type of a table or view column. */
export const columnRow = z.object({
  column_name: z.string().nullable(),
  data_type: z.string().nullable(),
});
