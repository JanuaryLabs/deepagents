# PostgreSQL Stream Store Plan

## Caveman Review

`packages/context/src/lib/stream/stream-manager.ts:L51`: separation is correct: `StreamManager` composes `StreamStore` and `StreamChangeSource`. Keep notify out of `StreamStore`.

`packages/context/src/lib/stream/stream-manager.ts:L201`: cancel watcher swallows all source failures. Add a visible telemetry/error policy before relying on `LISTEN` for cancellation.

`packages/context/src/lib/stream/polling-change-source.ts:L122`: timer helper swallows every delay error. Only swallow abort errors.

`packages/test/src/postgres-container.ts:L102`: default test image is PostgreSQL 17. PG stream tests must explicitly use `postgres:18-alpine`, or the helper default must move to 18.

`packages/context/src/lib/stream/change-source.ts:L1`: `StreamChange` is intentionally payload-light. Keep notification payload parsing inside `PostgresNotifyChangeSource`; `StreamManager` should only receive `chunks`, `status`, or `tick`.

## Locked Decisions

- PostgreSQL baseline is 18.
- `PostgresStreamStore` is persistence-only.
- Users can combine `PostgresStreamStore` with either `PollingChangeSource` or `PostgresNotifyChangeSource`.
- `PostgresNotifyChangeSource.initialize()` installs only notification trigger/function plumbing.
- `PostgresStreamStore.initialize()` installs only base stream tables and indexes.
- No `pg_notify` call lives inside `PostgresStreamStore.appendChunks()` or `PostgresStreamStore.updateStreamStatus()`.
- Notification payloads are wakeups only. Chunks and final status are always read from tables.
- Do not force `uuidv7()` in the core store. Current `StreamStore` accepts caller-owned string IDs.

## PostgreSQL Features Used

- `JSONB` for chunk payload storage.
- `LISTEN` and `pg_notify` for native wakeups.
- PostgreSQL triggers for transaction-correct notification publishing.
- PostgreSQL 18 test/runtime baseline.

Official references:

- PostgreSQL 18 release notes: https://www.postgresql.org/docs/current/release-18.html
- `NOTIFY`: https://www.postgresql.org/docs/current/sql-notify.html
- `LISTEN`: https://www.postgresql.org/docs/current/sql-listen.html
- `CREATE TRIGGER`: https://www.postgresql.org/docs/current/sql-createtrigger.html
- `JSONB`: https://www.postgresql.org/docs/current/datatype-json.html

## Target Code Shape

### Polling with PostgreSQL

```ts
const store = new PostgresStreamStore({
  pool: process.env.DATABASE_URL!,
  schema: 'deepagents',
});
await store.initialize();

const manager = new StreamManager({
  store,
  changeSource: new PollingChangeSource({
    reads: store,
  }),
});
```

### Native PostgreSQL notify

```ts
const store = new PostgresStreamStore({
  pool: process.env.DATABASE_URL!,
  schema: 'deepagents',
});
await store.initialize();

const changeSource = new PostgresNotifyChangeSource({
  pool: process.env.DATABASE_URL!,
  schema: 'deepagents',
});
await changeSource.initialize();

const manager = new StreamManager({
  store,
  changeSource,
});
```

## Files To Add

- `packages/context/src/lib/stream/ddl.stream.postgres.ts`
- `packages/context/src/lib/stream/ddl.stream.postgres-notify.ts`
- `packages/context/src/lib/stream/postgres.stream-store.ts`
- `packages/context/src/lib/stream/postgres-notify-change-source.ts`
- `packages/context/test/postgres/stream-store.integration.test.ts`
- `packages/context/test/postgres/stream-notify.integration.test.ts`

## Files To Update

- `packages/context/src/index.ts`
- `packages/context/src/lib/stream/stream-manager.ts`
- `packages/context/src/lib/stream/polling-change-source.ts`
- `packages/test/src/postgres-container.ts` only if we decide to move the shared default to PG18. Otherwise pass `{ image: 'postgres:18-alpine' }` in the new stream tests.

## Base Store Schema

Use lower_snake_case SQL names. Map to the existing TypeScript `StreamData` and `StreamChunkData` shapes at the boundary.

```sql
CREATE SCHEMA IF NOT EXISTS "{schema}";

CREATE TABLE IF NOT EXISTS "{schema}"."streams" (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  cancel_requested_at BIGINT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS "{schema}"."stream_chunks" (
  stream_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  data JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (stream_id, seq),
  FOREIGN KEY (stream_id) REFERENCES "{schema}"."streams"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "idx_{schema}_streams_created_at_id"
  ON "{schema}"."streams"(created_at, id);

CREATE INDEX IF NOT EXISTS "idx_{schema}_streams_status_created_at_id"
  ON "{schema}"."streams"(status, created_at, id);
```

No GIN index on `stream_chunks.data` in v1. We do not query chunk payloads.

## PostgresStreamStore Contract

Constructor should mirror `PostgresContextStore`:

```ts
export interface PostgresStreamStoreOptions {
  pool: Pool | PoolConfig | string;
  schema?: string;
}
```

Implementation requirements:

- Validate schema names with the existing identifier rule.
- Lazily `require('pg')` via `createRequire`, same as `PostgresContextStore`.
- Track `#ownsPool` and close only owned pools.
- Require `await store.initialize()` before queries.
- `createStream` inserts exactly the provided stream.
- `upsertStream` uses `ON CONFLICT DO NOTHING RETURNING *`, then fetches existing.
- `appendChunks([])` is a no-op.
- `appendChunks(chunks)` bulk inserts through one SQL statement using `jsonb_to_recordset($1::jsonb)` or equivalent batched parameters.
- `appendChunks` must support chunks for multiple stream IDs in one call.
- `getChunks(streamId, fromSeq, limit)` returns ordered chunks by `seq`.
- `deleteStream` relies on `ON DELETE CASCADE`.
- `reopenStream` runs in a transaction, locks the stream row, rejects non-terminal streams, deletes the old stream, and inserts a fresh queued stream with the same ID.

## Notify Source Schema

`PostgresNotifyChangeSource.initialize()` installs only this layer. If base tables are missing, it should fail with PostgreSQL's table-not-found error, not silently create store tables.

Use one shared channel and filter by schema plus stream ID in TypeScript:

```sql
deepagents_stream_changes
```

Payload shape:

```json
{ "schema": "deepagents", "streamId": "abc", "kind": "chunks" }
```

Keep payload small because `NOTIFY` payloads are not the data plane.

Chunk notifications should avoid one notification per row. Use a statement-level trigger with a transition table and notify once per distinct stream ID touched by the insert statement.

```sql
CREATE OR REPLACE FUNCTION "{schema}"."notify_stream_chunks_insert"()
RETURNS TRIGGER AS $$
DECLARE
  changed_stream_id TEXT;
BEGIN
  FOR changed_stream_id IN
    SELECT DISTINCT stream_id FROM new_rows
  LOOP
    PERFORM pg_notify(
      'deepagents_stream_changes',
      json_build_object(
        'schema', TG_TABLE_SCHEMA,
        'streamId', changed_stream_id,
        'kind', 'chunks'
      )::text
    );
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "stream_chunks_notify_insert"
AFTER INSERT ON "{schema}"."stream_chunks"
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT
EXECUTE FUNCTION "{schema}"."notify_stream_chunks_insert"();
```

Status notifications can be row-level because status changes are one stream at a time through the store.

```sql
CREATE OR REPLACE FUNCTION "{schema}"."notify_stream_status_update"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM pg_notify(
      'deepagents_stream_changes',
      json_build_object(
        'schema', TG_TABLE_SCHEMA,
        'streamId', NEW.id,
        'kind', 'status'
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER "streams_notify_status_update"
AFTER UPDATE OF status ON "{schema}"."streams"
FOR EACH ROW
EXECUTE FUNCTION "{schema}"."notify_stream_status_update"();
```

## PostgresNotifyChangeSource Contract

Constructor:

```ts
export interface PostgresNotifyChangeSourceOptions {
  pool: Pool | PoolConfig | string;
  schema?: string;
  channel?: string;
}
```

Implementation requirements:

- Own a dedicated `pg` client for `LISTEN`; do not use ordinary pooled queries for the listener connection.
- `initialize()` installs only notify functions/triggers.
- `subscribe(streamId, signal)` registers the subscriber before ensuring `LISTEN` is active.
- `subscribe()` must yield an initial `{ kind: 'tick' }` after `LISTEN` is active so `StreamManager` drains any chunks written before subscription readiness.
- Parse notifications defensively. Ignore invalid JSON, wrong schema, wrong stream ID, and unknown kind.
- Convert `kind: 'chunks'` to `{ kind: 'chunks' }`.
- Convert `kind: 'status'` to `{ kind: 'status' }`.
- On listener connection failure, do not leave watchers hanging. Either propagate an error to subscribers or reconnect and yield `{ kind: 'tick' }` after re-listening.
- Expose `close(): Promise<void>` to unlisten, release the dedicated client, and close an owned pool.

## StreamManager Cleanup Before Native Notify

Keep the current store/change-source split, but fix these before merging native notify:

- Add telemetry for cancel-source failures, or rethrow them through a clear policy. Current `#runCancelWatcher` silently disables cancellation detection.
- Keep `changeSource` explicit in `StreamManagerOptions`; do not add a `watchPolling` compatibility shim.
- Preserve `chunkPageSize` on `StreamManager`, not on `WatchPollingConfig`. Page size is drain behavior, not wakeup behavior.
- Add tests proving a `PostgresStreamStore` works with `PollingChangeSource`.
- Add tests proving a `PostgresStreamStore` works with `PostgresNotifyChangeSource`.

## Integration Tests

Use Node test runner only.

```sh
node --test --no-warnings packages/context/test/postgres/stream-store.integration.test.ts
node --test --no-warnings packages/context/test/postgres/stream-notify.integration.test.ts
nx run @deepagents/context:typecheck
```

Test cases:

- Store CRUD parity with the SQLite stream-store suite.
- `appendChunks` preserves order and JSONB payload fidelity.
- `appendChunks` supports multi-stream batches.
- `getChunks` respects `fromSeq` and `limit`.
- `deleteStream` cascades chunks.
- `reopenStream` rejects queued/running streams and resets terminal streams.
- Polling change source tails a PostgreSQL-backed stream.
- Notify change source receives chunk wakeups without polling.
- Notify change source receives terminal status wakeups.
- Notify change source filters unrelated stream IDs.
- Notify change source filters unrelated schemas.
- Notify source initial tick drains chunks written before subscription.
- Notify source cleans up listener connection on abort and close.
- Notify trigger setup is optional; polling tests must pass without `PostgresNotifyChangeSource.initialize()`.

## Non-Goals

- No public docs update in this phase.
- No backward compatibility shim for old `StreamManager({ store, watchPolling })`.
- No `uuidv7()`-generated stream IDs in the store.
- No payload search/indexing over chunk JSONB.
- No chunk data in notification payloads.
