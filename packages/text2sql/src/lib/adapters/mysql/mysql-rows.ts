import { z } from 'zod';

// Rows of the INFORMATION_SCHEMA queries shared by the MySQL/MariaDB
// groundings. MySQL 8 names INFORMATION_SCHEMA columns in upper case, so the
// keys are upper case where the SQL does not alias them. Text columns arrive
// as strings and NULL as null with mysql2, the mariadb connector and the
// mysql CLI alike.

/** `SELECT DATABASE() AS db`: NULL when the connection has no default database. */
export const currentDatabaseRow = z.object({ db: z.string().nullable() });

/** `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS`. */
export const columnRow = z.object({
  COLUMN_NAME: z.string().nullable(),
  DATA_TYPE: z.string().nullable(),
});
