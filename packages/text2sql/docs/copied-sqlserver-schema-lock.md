# Copied: SQL Server schema DDL lock

| Source                                                    | Copy                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/context/src/lib/store/sqlserver-schema-lock.ts` | `packages/text2sql/src/lib/fs/mssql/sqlserver-schema-lock.ts` |

Copied on 2026-10-21 for backlog #2803, byte-identical.

`withSqlServerSchemaLock` runs schema DDL while holding a transaction-owned
`sp_getapplock` keyed by the schema on its own pooled connection, so concurrent
openers of the same schema run their DDL one at a time. `SqlServerContextStore`
and `MssqlFs` both run
`IF ... IS NULL CREATE ...` DDL on open, and both deadlock or fail to create the
schema when several processes open it at once.

This is the second place that needs the lock (Rule of Three, strike 2), so it
is copied, not shared. Mirror every fix in both files and name both in the
commit. A third consumer extracts it.
