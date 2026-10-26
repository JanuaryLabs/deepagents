# Copied SQL Server schema DDL lock

| Source                                                    | Copy                                                          |
| --------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/context/src/lib/store/sqlserver-schema-lock.ts` | `packages/text2sql/src/lib/fs/mssql/sqlserver-schema-lock.ts` |

Copied on 2026-10-21 for backlog #2803, byte-identical.

`withSqlServerSchemaLock` runs schema DDL while holding a transaction-owned
`sp_getapplock` keyed by the schema on its own pooled connection, so concurrent
openers of the same schema run their DDL one at a time. `SqlServerContextStore`
and `MssqlFs` both run `IF ... IS NULL CREATE ...` DDL on open. Without the lock,
concurrent opens can deadlock or fail to create the schema.

The pool needs at least two connections available during initialization: one
holds the lock, and the others execute DDL outside the lock's transaction
because SQL Server full-text DDL cannot run inside a user transaction. The
lock is released when initialization succeeds or fails.

This is the second consumer of the lock, so the implementation remains copied
under the Rule of Three. Mirror every fix in both files and name both in the
commit. Extract shared code when a third consumer needs the same behavior.
