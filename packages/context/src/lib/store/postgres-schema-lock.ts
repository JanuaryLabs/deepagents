/**
 * Prefixes schema DDL with a transaction-scoped advisory lock keyed by the
 * schema, so openers that race on the same schema run it one at a time.
 * `IF NOT EXISTS` is not atomic across sessions: without the lock, concurrent
 * openers fail with a duplicate `pg_namespace` key or a deadlock.
 *
 * Run the result as one parameterless query. Postgres runs it as a single
 * implicit transaction, which holds the lock until the DDL commits or rolls
 * back. Without `schema`, the lock is keyed by the session's `current_schema()`.
 */
export function lockSchemaDDL(ddl: string, schema?: string): string {
  if (schema !== undefined && !/^[a-zA-Z_]\w*$/.test(schema)) {
    throw new Error(`Invalid schema name: "${schema}"`);
  }
  const key =
    schema === undefined ? `coalesce(current_schema(), '')` : `'${schema}'`;
  return `SELECT pg_advisory_xact_lock(hashtextextended('deepagents:schema-ddl:' || ${key}, 0));\n${ddl}`;
}
