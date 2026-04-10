## Why

`@deepagents/text2sql` currently assumes a single adapter per `Text2Sql` instance, which prevents the agent from answering questions that span multiple related databases even when the caller can provide all of the required connections. Real deployments often split interconnected data across operational, warehouse, and line-of-business databases, so multi-connection querying needs to be a first-class capability instead of something users have to work around outside the library.

## What Changes

- Add first-class multi-connection configuration to `Text2Sql` so one runtime can be initialized with multiple named SQL adapters.
- Make schema indexing and prompt context connection-aware so the model can see all provided schemas while preserving which entities belong to which connection.
- Allow the chat agent and SQL execution tools to choose the correct connection for each query and complete answers that require querying more than one configured database.
- Define coherent multi-connection behavior for core APIs such as `chat`, `toSql`, `index`, and `toPairs` so the package does not keep single-adapter assumptions in adjacent surfaces.
- **BREAKING** Replace the current single-`adapter` contract with an explicit `connections` map. Single-connection callers will use `connections: { default: adapter }` instead of a compatibility shim.

## Capabilities

### New Capabilities

- `multi-connection-querying`: Allow `@deepagents/text2sql` to introspect, reason over, and execute against multiple named SQL connections within a single session.

### Modified Capabilities

## Impact

- Affected code:
  - `packages/text2sql/src/lib/sql.ts`
  - `packages/text2sql/src/lib/agents/sql.agent.ts`
  - `packages/text2sql/src/lib/agents/result-tools.ts`
  - `packages/text2sql/src/lib/adapters/*` where connection identity or execution contracts need to be surfaced consistently
  - `packages/text2sql/test/*.integration.test.ts` for end-to-end multi-connection flows
  - `packages/text2sql/README.md` and package docs
- Affected APIs:
  - `Text2Sql` constructor/configuration
  - query execution tool inputs/outputs for connection selection
  - introspection caching and any helper APIs that currently accept or return a single adapter context
