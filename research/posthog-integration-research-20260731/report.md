# PostHog as a SQL Data Source: Integration Options and Recommended Architecture

Generated: 2026-07-31  
Scope: PostHog Cloud, self-hosted considerations, and integration with `@deepagents/text2sql`

## Executive Summary

- **Yes, PostHog can now behave like a normal SQL database—but only through its new Managed Warehouse beta.** The managed warehouse exposes a TLS-secured PostgreSQL wire endpoint on port 5432, works with ordinary Postgres drivers and tools, and contains continuously replicated PostHog events, persons, and connected-source data. It is a dedicated DuckDB/DuckLake analytical system, not the same database used by PostHog Product Analytics. Access is waitlisted and the documented credential model is a single organization-level `root` user. [3][4][5]

- **The classic PostHog SQL path remains HogQL over HTTP.** `POST /api/projects/:project_id/query/` accepts `HogQLQuery` requests and returns columns plus row arrays. This is proper for interactive, ad-hoc, and embedded analytics, but PostHog explicitly says it is not an export mechanism and discourages it for production applications. Current project-level limits include 2,400 requests/hour, 240/minute, three concurrent queries, and ten seconds of query execution. [1][2]

- **PostHog has split production workloads from free-form queries.** Saved SQL and insights should become Endpoints for production or customer-facing traffic. Bulk or recurring data movement should use batch exports. [7][8][9][23]

- **For `@deepagents/text2sql`, the shortest correct path is not one new adapter.** Reuse the existing Postgres adapter for Managed Warehouse. Add a dedicated PostHog/HogQL adapter only for customers without managed-warehouse access or where Product Analytics freshness is required. Do not disguise HogQL as Postgres or reuse the ClickHouse adapter: HogQL has an HTTP response contract, PostHog-specific virtual schema, and no documented ClickHouse-native validation surface. [1][4][19][20][22]

- **Authentication must follow the workload.** Personal API keys are suitable only for an owner's scripts or internal service and must not reach a frontend. OAuth is the supported choice for an installable multi-customer product. Project secret keys currently support only `endpoint:read`, which makes them ideal for fixed production Endpoints but not free-form Query API execution. [10][11][12][13]

**Primary recommendation:** Implement a three-lane PostHog integration: Managed Warehouse through the existing Postgres adapter as the preferred direct-SQL lane; a narrow HogQL Query API adapter for exploratory live analytics; and Endpoints or batch exports as explicit promotion paths for production and bulk workloads.

**Confidence:** High for the product-surface conclusions because they are based on current official documentation and official source. Medium for exact Managed Warehouse driver compatibility inside this repository until a beta tenant is connected and the existing Postgres grounding and `EXPLAIN` paths are probed end to end.

## Introduction

The research question is whether PostHog can be treated as a SQL database rather than merely a REST API, which of its current integration surfaces are appropriate for production, and how each surface fits the existing `@deepagents/text2sql` contracts. The analysis includes PostHog Cloud, current beta products, agent access, bulk data movement, and the technical limits of direct self-hosted database access.

### The Direct Answer

PostHog is not one database surface:

| Question | Answer |
|---|---|
| Can I connect `psql`, `node-postgres`, DBeaver, Metabase, or another Postgres client directly? | **Yes, if your organization has Managed Warehouse beta access.** It exposes a PostgreSQL wire endpoint over TLS. [4] |
| Can I connect directly to normal PostHog Cloud Product Analytics as if it were Postgres or ClickHouse? | **No.** The supported free-form surface is HogQL through the HTTP Query API. [1][2] |
| Can I run arbitrary SQL through PostHog's API? | **Yes, within HogQL's supported ClickHouse-derived dialect and Query API operational limits.** [1][2] |
| Can I use the Query API as ETL or continuously export raw events? | **No.** PostHog may rate-limit or reject export-like traffic; use batch exports. [2][9] |
| Can I serve fixed production analytics from PostHog? | **Yes.** Publish saved SQL or an insight as an Endpoint, optionally materialized. [7][8] |
| Can an AI agent query PostHog without building this adapter? | **Yes.** PostHog's hosted MCP exposes SQL and schema capabilities, but it is an agent-tool integration rather than a database adapter. [14][15] |
| Can I connect to underlying ClickHouse on self-hosted PostHog? | **Technically an operator controls those services, but that is an internal-storage integration, not the supported HogQL contract.** It couples the client to PostHog's physical schema, tenant filtering, and upgrades; it should not be the product integration.

### Decision Matrix

| Option | SQL experience | Freshness | Production posture | Auth model | Best use | Recommendation |
|---|---|---:|---|---|---|---|
| Managed Warehouse | PostgreSQL wire; standard Postgres plus DuckDB analytics | Continuously synced, not the Product Analytics query engine | Beta; isolated analytical database | Host/user/password, documented as organization `root` | BI, notebooks, scheduled jobs, `text2sql`, direct SQL | **Preferred direct-SQL path when available** |
| HogQL Query API | Free-form HogQL over HTTP | Queries live PostHog tables and warehouse catalog | Ad-hoc/embedded only; discouraged for production | Personal key or OAuth with query read | Interactive NL-to-SQL and investigation | **Supported fallback/live lane with hard guardrails** |
| Endpoints | Parameterized fixed query over HTTP | Direct, cached, or materialized | Designed for production/customer-facing use | Project secret `endpoint:read`, personal key, or OAuth | Stable application metrics and dashboards | **Promotion target for repeated queries** |
| Batch exports | SQL only after data lands in destination | Scheduled; five-minute to weekly intervals depending on configuration | Reliable ETL with retries/backfills | Destination credentials managed in PostHog | Bulk history, warehouse ownership, large recurring jobs | **Required for bulk/recurring export** |
| PostHog MCP | Agent tool calls, including SQL | Live | Hosted MCP; tool-level integration | OAuth or personal key | Coding agents, investigations, PostHog administration | **Optional agent-layer integration** |
| Self-hosted internal ClickHouse/Postgres | Native database protocols | Internal/live | Unsupported physical-schema coupling | Infrastructure credentials | Operators debugging their own deployment | **Do not ship as a product adapter** |
| Capture SDK/API or real-time destinations | Not SQL | Near-real-time | Supported ingestion/event delivery | Project token or destination auth | Writing events or reacting to events | **Separate write/stream plane, not a query substitute** |

## Main Analysis

### Option 1: Managed Warehouse — The Real Direct-SQL Path

#### What it is

Managed Warehouse is a new analytical database that PostHog provisions per organization. PostHog backfills historical events and persons, continually applies new PostHog data, and synchronizes connected sources into the same warehouse. Its compute is isolated per organization, its engine is DuckDB, and durable data is stored through DuckLake in columnar object storage. It supplements rather than replaces the ClickHouse-backed Product Analytics engine. [3]

The external connection is genuinely PostgreSQL-compatible: a regional hostname under `dw.us.postwh.com` or `dw.eu.postwh.com`, port `5432`, database `ducklake`, user `root`, password, and mandatory TLS. PostHog documents compatibility with `psql`, pgAdmin, DBeaver, BI tools, JDBC, `node-postgres`, SQLAlchemy, and other standard drivers. Standard selects, joins, CTEs, window functions, prepared statements, transactions, and `COPY ... TO STDOUT` work; DuckDB-specific analytical features such as `DESCRIBE`, `SUMMARIZE`, and `QUALIFY` are also available. [4]

The warehouse is not a read-only mirror. It permits `CREATE TABLE`, `CREATE VIEW`, `INSERT`, `UPDATE`, and `DELETE` for customer-owned derived data. PostHog warns that writes to PostHog-managed synchronized tables may be overwritten. It also documents that server-side PL/pgSQL functions, triggers, sequences, `LISTEN`/`NOTIFY`, and `CREATE ROLE` are unavailable. [4]

#### Fit with `@deepagents/text2sql`

This option should reuse `@deepagents/text2sql/postgres`, not create a `posthog` adapter. The existing `Postgres` adapter already accepts an injected `execute(sql)` transport, formats PostgreSQL, queries standard `information_schema`, enforces read-only and allowed-entity policy before execution, and uses `EXPLAIN` as its default server validator. [19][20][21]

That reuse has three advantages:

1. The wire protocol and standard PostgreSQL query subset are the advertised contract, so the existing adapter represents the actual interface rather than an approximation. [4]
2. The integration application can keep using its current Postgres client and return `result.rows` through the adapter's callback. `@deepagents/text2sql` does not need a new database dependency. [19][21]
3. The adapter's policy blocks generated writes even though the warehouse credential itself is powerful. [20]

The first live beta-tenant probe must verify four items before this is declared production-ready:

- The exact schema names returned by `information_schema.tables`; PostHog says event/person tables are named using the chosen project schema, for example `events_prod` and `persons_prod`, while imports live under a schema such as `posthog_data_imports_prod`. [3][4][5]
- `EXPLAIN <generated SELECT>` behavior through the PostgreSQL compatibility layer.
- Which existing grounding modules work without PostgreSQL system catalogs. `tables()`, `views()`, and ordinary `information_schema` queries are the safest starting set; index grounding uses `pg_catalog` and should remain disabled until proven against the beta endpoint. [19]
- Whether the current PostgreSQL parser accepts every query the model will generate. The generator should target conservative PostgreSQL, not DuckDB-only `FROM`-first syntax, `ASOF JOIN`, or other extensions. [4][20]

#### Security and operational limits

The documented credential model is materially weaker than a mature Postgres deployment: one warehouse covers the organization, the documented user is `root`, password reset immediately invalidates the prior password, and `CREATE ROLE` is absent. [4][5] This means:

- Keep the connection in a trusted backend or Electron main process with OS-backed secret storage; never expose it to a renderer, browser, or customer-supplied script.
- Do not use one root credential as a multi-tenant application authorization mechanism. Application authorization must still decide which organization, project schema, tables, and columns a caller may access.
- Restrict adapter grounding to explicit project and import schemas after discovery. Do not expose every organization's project schema merely because the wire credential can see it.
- Use a small connection pool and timeouts appropriate to workers that spin up on demand. Treat cold-start latency and sync lag as analytical-system characteristics, not transactional database behavior.

Managed Warehouse is currently beta and waitlisted, and its layout is explicitly described as still settling. [3][5] It is therefore the cleanest long-term interface but cannot be the only integration lane today.

PostHog currently advertises one million managed-warehouse rows per month free and `$0.000015` per row afterward, with lower rates at volume. Pricing is time-sensitive and should be read from PostHog at deployment time rather than hard-coded. [24]

### Option 2: HogQL Query API — Live, Dynamic, but Not a Database Protocol

#### Contract

HogQL is PostHog's wrapper over ClickHouse SQL with PostHog-specific property access, null behavior, relationships, and visualization integration. A query is sent as JSON to `POST /api/projects/:project_id/query/` with `kind: "HogQLQuery"`; the response includes a `columns` array, `types`, and `results` as arrays of values. The specific HogQL response remains public beta. [1]

The adapter transport must convert the column-oriented wire shape into the row-object array required by `@deepagents/text2sql`:

```ts
const rows = results.map((values) =>
  Object.fromEntries(columns.map((column, index) => [column, values[index]])),
);
```

Duplicate output aliases must be rejected or normalized before this conversion because object keys would otherwise overwrite each other. Empty results also require the adapter to retain `columns` separately if downstream presentation needs headers; the current `Text2Sql.run()` derives output columns from the first returned object. [1][21]

#### Schema discovery

PostHog now exposes a particularly useful SQL-native catalog. The access-controlled `system.information_schema` namespace provides virtual `tables`, `columns`, `relationships`, and `data_types` tables. It describes PostHog base tables, system tables, warehouse sources, and saved views without exposing inaccessible objects. [6] A HogQL grounding implementation should use that catalog instead of hard-coding only `events` and `persons`.

Dynamic product taxonomy is a second layer. Event names and arbitrary event/person properties cannot be fully inferred from static columns because they live in property objects. PostHog documents REST event-definition and property-definition APIs, while its own MCP uses a structured `read_taxonomy` tool for events, event properties, entity properties, action properties, and sampled values. [10][17][18] A proper grounding design therefore combines:

1. `system.information_schema.tables` and `.columns` for relational structure.
2. `.relationships` for PostHog lazy joins and traversers.
3. Event/property definitions for the project's semantic vocabulary.
4. Sample values only on demand, with strict caps, because they may contain personal data.

#### Why it needs a dedicated adapter

It should not use the existing ClickHouse adapter. That adapter's security policy asks a native ClickHouse server for settings and uses `EXPLAIN AST`, `EXPLAIN QUERY TREE`, and `system.functions`; none of those operations is the documented HogQL Query API contract. [22] It should not use the Postgres adapter either: the grammar, property access, virtual relationships, HTTP transport, and response shape are not PostgreSQL. [1][6]

The repository's parser policy has no ClickHouse or HogQL dialect; its supported parser dialects are BigQuery, MySQL, PostgreSQL, SQLite, and Transact-SQL. Falling back to first-keyword checks is insufficient for allowed-table scope enforcement because complex CTEs and subqueries still need reliable relation extraction. [20]

The minimum dedicated adapter should preserve the repository's existing pattern:

- Accept injected `execute` and `validate` callbacks rather than owning OAuth, token refresh, or application storage.
- Provide PostHog-specific grounding using the virtual information schema and taxonomy endpoints.
- Use `sql-formatter`'s ClickHouse formatting only for display; formatting does not establish semantic safety.
- Map API errors into stable syntax, permission, rate-limit, timeout, and unknown categories.
- Require one statement, read-only intent, explicit table allowlists, a bounded `LIMIT`, and time filters for event scans.

#### Validation gap

No current public documentation found a parse-only or dry-run HogQL endpoint. The published Query API executes queries; unlike the Postgres and ClickHouse adapters, there is no documented safe server `EXPLAIN` contract for adapter validation. [1][2][19][22]

This matters because the base adapter validates before execution. A naive HogQL validator would execute the query once to validate it and then execute it again to return rows. The smallest compatible design is a one-entry, exact-SQL result cache inside the PostHog adapter: `validateImpl()` makes the blocking Query API call, maps and stores a successful response, and the immediately following `executeImpl()` drains that response. This avoids duplicate execution without changing the shared adapter contract. If generation asks only for validated SQL without execution, the call still incurs a real query; that limitation must be explicit.

A larger parser dependency should not be added until a real HogQL grammar is found and tested against PostHog extensions. A parser that accepts generic ClickHouse but misinterprets PostHog field traversers would create a false security boundary. The actual data boundary is the project-scoped PostHog API credential; local parsing is defense in depth and product-level table restriction, not a replacement for tenant authorization.

#### Hard runtime limits

The Query API defaults to 100 rows and allows an explicit `LIMIT` up to 50,000. It disallows `OFFSET` for programmatic requests and directs clients to keyset pagination on `events.timestamp` or `persons.id`. It may reject export-like usage without notice. [2]

Current project-level limits are 2,400 requests/hour, 240/minute, three running queries, 60 threads per query, and ten seconds of execution time; queued requests may wait up to 30 seconds. Higher limits are not currently offered for this surface. [2] Therefore the adapter should:

- Default to blocking cached execution for interactive requests.
- Use meaningful `name` and `client_query_id` values for `query_log` traceability.
- Set a client timeout slightly above PostHog's queue plus execution envelope and propagate cancellation.
- Never automatically retry arbitrary timeouts; only retry 429 or transient transport failures when the response indicates it is safe, with bounded backoff.
- Require a recent time predicate for `events` unless the user explicitly approves a broader scan. PostHog itself says custom queries should almost always use short time ranges. [2]
- Treat asynchronous query polling and DELETE cancellation as a later capability only if real workloads exceed the blocking request flow; async modes exist, but they add state and do not raise the documented execution ceiling. [2]

### Option 3: Endpoints — Productionize Known Queries

Endpoints turn a saved insight or SQL query into a named HTTP route with versioning, execution logs, OpenAPI, variables, caching, and optional materialization. [8] This is not a replacement for dynamic NL-to-SQL because the query is defined ahead of time. It is the correct target after a generated metric becomes stable and repeatedly consumed.

PostHog's own comparison is unambiguous: Query API for ad-hoc exploration; Endpoints for production applications, customer-facing analytics, and high traffic; batch exports for third-party data export. It says it strongly discourages Query API usage and expects future pricing. [7]

For this product, “promote to endpoint” should be a deliberate workflow rather than automatic behavior:

1. A user explores with direct SQL or HogQL.
2. The query is reviewed for semantics, cost, parameters, and data exposure.
3. The user saves and versions it in PostHog.
4. The application calls the stable route with a project secret carrying only `endpoint:read`. [8][12]

Materialized endpoints currently support 1,200 requests/minute burst, 12,000/hour sustained, and ten concurrent requests; direct endpoints use standard API limits. [23] This is a meaningful production improvement over the Query API's three-query concurrency, but materialization trades freshness for predictable latency and cost.

### Option 4: Batch Exports — Own and Query the Data Elsewhere

Batch exports are the supported path for recurring or bulk movement of events, persons, or sessions. They are built on Temporal, support automated and manual retries, and target Azure Blob Storage, BigQuery, Databricks, S3-compatible storage, Snowflake, Postgres, and Redshift. [9]

This is often the strongest `text2sql` production architecture because it moves the query workload onto a database whose semantics, access controls, indexes, cost controls, and availability the application owns. The package can then use an existing Postgres, BigQuery, or other supported adapter without any HogQL grammar or API-limit special cases.

Tradeoffs are data latency, duplicate handling, backfill operations, and schema evolution. PostHog warns that new model fields may be added over time and that database destinations do not automatically add those columns. [9] Export consumers must use stable event UUIDs for deduplication and treat schema changes as managed migrations.

Choose batch exports when any of these become true:

- More than a few thousand rows are pulled on a schedule.
- Queries routinely approach ten seconds or require broad historical scans.
- Application SLAs cannot depend on Query API concurrency.
- Data must join with operational or customer data outside PostHog.
- The organization requires database-native users, roles, row-level security, or network controls unavailable in Managed Warehouse beta.

### Option 5: MCP — Best for Agents, Not the Database Layer

PostHog hosts an MCP endpoint at `https://mcp.posthog.com/mcp` that supports compatible agents, regional routing, OAuth, SQL execution, data schema exploration, and many PostHog management operations. [14] Its official source exposes allowlists such as `?features=data_schema,sql` or `?tools=execute-sql`, which can narrow the agent surface. [15]

The SQL tool forwards text to PostHog's `execute_sql` native tool and returns textual content. The schema tool forwards structured requests to `read_taxonomy`. [16][17][18] That is useful for a general DeepAgents PostHog toolset, but weaker as the `@deepagents/text2sql` execution substrate because:

- Results are agent-oriented text rather than the adapter's typed row-object contract.
- MCP introduces a protocol and SDK where the Query API is already a direct HTTP call.
- PostHog's SQL generation and taxonomy context overlap with this package's own NL-to-SQL and grounding responsibilities.
- The MCP can write across PostHog products unless tools/features and OAuth scopes are deliberately restricted. [14][15]

Use MCP for broad agent workflows—inspect analytics, manage flags, investigate errors, or administer PostHog. Use the SQL adapter for deterministic application data access.

### Option 6: Self-Hosted Internal Databases — Technically Possible, Strategically Wrong

A self-hosted operator controls PostHog's ClickHouse and PostgreSQL services. That makes direct connection physically possible, but those databases are implementation details: ClickHouse stores high-volume analytics data while PostgreSQL stores users, projects, saved insights, and other metadata. HogQL is the tenant-aware semantic layer over those internals.

A direct internal connection would require the integration to reproduce PostHog's project filtering, person and property semantics, lazy relationships, schema migrations, and read-safety rules. It also bypasses PostHog API authorization and query logs. The surface will differ by PostHog version and deployment topology. This path is acceptable only for an operator-owned diagnostic tool pinned to a specific self-hosted release—not for a reusable `@deepagents/text2sql/posthog` package.

## Authentication Architecture

| Scenario | Credential | Storage and boundary |
|---|---|---|
| One organization, Managed Warehouse | Warehouse `root` password | Backend secret manager or OS keychain; never renderer/browser |
| One owner's internal Query API integration | Personal API key with minimum project and `query:read` scope | Backend only; rotate and audit owner lifecycle |
| Installable product for many PostHog customers | OAuth 2.0 with CIMD and least scopes | Authorization code flow; encrypted refresh-token storage; bind token to discovered region/project |
| Production fixed Endpoint | Project secret key with `endpoint:read` | Server-side per project; preferred because it is not tied to an employee |
| Agent/MCP | OAuth preferred; personal key only for private use | Restrict MCP tools/features and OAuth scope ceiling |

Personal keys are tied to a user, can enable account-level access, are deleted when the user is deleted, and must not be used in a frontend. [11] OAuth is specifically documented for third-party apps, supports a region-agnostic authorization domain, CIMD, loopback redirects for native apps, scope ceilings, and short-lived access tokens plus refresh tokens. [13] Project secret keys are not user-bound but currently document only `endpoint:read`, so they cannot replace OAuth or personal keys for free-form Query API access. [12]

For a desktop application, keep all PostHog and warehouse requests in the privileged main process. The renderer should send a connection identifier and a user request, never a token or arbitrary destination URL. Bind each stored secret to the approved PostHog origin and project ID to prevent an attacker from redirecting a valid bearer token to an arbitrary host.

## Synthesis

The evidence shows two different meanings of “PostHog as SQL.” Managed Warehouse is a synchronized analytical database with a standard wire protocol; HogQL is a live semantic query service over Product Analytics. They should be separate connection types because they differ in freshness, SQL dialect, authentication, data layout, and operational limits. Endpoints and batch exports are not secondary conveniences: they are the supported escalation paths when exploratory queries become production APIs or bulk pipelines. [2][3][4][7][8][9]

### Recommended Product Architecture

```text
User question
    |
    v
Connection capability check
    |
    +-- Managed Warehouse available? --> existing Postgres adapter --> PG wire/TLS
    |
    +-- Live exploratory analytics? ---> dedicated PostHog adapter --> HogQL Query API
    |                                         |
    |                                         +--> schema: system.information_schema
    |                                         +--> taxonomy: event/property definitions
    |
    +-- Stable repeated query? --------> reviewed PostHog Endpoint
    |
    +-- Bulk/recurring data? ----------> Batch Export --> existing DB adapter
    |
    +-- Broad agent operations? -------> PostHog MCP (restricted tools)
```

The connection record should model a capability, not merely a brand:

- `posthog-managed-warehouse`: ordinary PostgreSQL transport, beta capability flag, explicit accessible schemas.
- `posthog-hogql`: region, project ID, injected authenticated transport, query limits, and grounding cache.
- `posthog-endpoint`: endpoint name/version and variables, not arbitrary SQL.
- `posthog-mcp`: agent tool connection, separate from database connections.

This avoids presenting two incompatible engines as one “PostHog SQL” connection. A user should see whether they are querying a synchronized warehouse with PostgreSQL or live Product Analytics with HogQL.

## Recommendations

### Implementation Plan for `@deepagents/text2sql`

#### Phase 0 — Capability probe, no production code

Use a real Managed Warehouse beta tenant and a PostHog project test fixture to capture:

1. `SELECT version()`, `SELECT current_database()`, `information_schema.tables`, and `DESCRIBE events_<schema>` from the managed endpoint.
2. Existing Postgres `tables()`, `views()`, and default `EXPLAIN` validation through the package public API.
3. Query API responses for empty results, duplicate aliases, nested property values, API errors, timeout, 429, and the four `system.information_schema` tables.
4. OAuth `query:read` and project-secret `endpoint:read` against the correct regional hosts.

These probes decide compatibility; they should become sanitized integration fixtures. No new abstraction is justified before them.

#### Phase 1 — Managed Warehouse support through existing Postgres

No package code may be necessary. Add documentation and an integration test using an injected Postgres executor. Start grounding with `info()`, `tables()`, and `views()` only. Add row counts, values, constraints, or indexes individually after the live endpoint proves the underlying catalog query.

Product defaults:

- TLS required.
- Explicit schema/table allowlist after discovery.
- Read-only `@deepagents/text2sql` policy despite root credentials.
- PostgreSQL generation profile, excluding DuckDB-only syntax.
- Clear “synchronized analytical copy” freshness label.

#### Phase 2 — Dedicated HogQL adapter

Add a public `@deepagents/text2sql/posthog` export only if Managed Warehouse access is insufficient for actual users. Keep the surface minimal:

```ts
type PostHogAdapterOptions = {
  execute: (sql: string) => Promise<PostHogQueryResponse>;
  grounding: GroundingFn[];
};
```

The application owns fetch, OAuth, regions, retries, and token refresh; the adapter owns policy, grounding, response mapping, and error normalization. Use native `fetch` in the application—no PostHog SDK or MCP SDK is needed for a single JSON endpoint.

Required integration checks:

- Public `Text2Sql.run()` flow, not internal-class tests.
- One API execution per successful `run()` despite validation.
- Scope violations are rejected before transport.
- Columns/results mapping, empty results, and duplicate aliases.
- Event/property grounding and information-schema relationship grounding.
- 401/403/429/timeout/query-error classification without leaking tokens.
- `LIMIT`, time-range, and no-`OFFSET` guardrails.

#### Phase 3 — Production promotion

Do not make arbitrary Query API calls the production dashboard backend. Add an explicit user workflow to save/review a stable query and publish an Endpoint. Use project secret keys for runtime execution. For bulk use, guide the operator to batch export and reconnect through the resulting database.

### Failure Modes and Controls

| Failure | Consequence | Control |
|---|---|---|
| Treating HogQL as Postgres | Invalid syntax, wrong properties, broken grounding | Separate engine identity and adapter |
| Reusing ClickHouse adapter | Native settings/AST queries fail; false policy assumptions | Dedicated HogQL policy and transport |
| Query API used as ETL | Rejection, rate limits, pipeline breakage | Batch exports |
| Root warehouse credential exposed | Organization-wide analytical data and write access compromised | Backend-only storage, app authorization, schema allowlist |
| Personal key tied to departed user | Integration stops when user is deleted | OAuth for products; project secret for Endpoints |
| Validation executes twice | Double rate usage and cost | Drain a one-entry validated-result cache |
| No event time predicate | Slow/costly event scans, ten-second failures | Mandatory bounded time window by default |
| Schema grounding samples PII | Sensitive values enter model context | Metadata first; sampled values opt-in and redacted |
| Managed Warehouse sync mistaken for transactional state | Stale operational decisions | Freshness display and Product Analytics lane for live investigation |
| Endpoint created automatically from generated SQL | Stable route publishes unreviewed semantics/data | Human review and explicit promotion |

### Recommendation by User Goal

| Goal | Choose |
|---|---|
| “Treat PostHog exactly like another database in `text2sql`” | Managed Warehouse + existing Postgres adapter |
| “Ask live, changing questions over current PostHog analytics” | Dedicated HogQL Query API adapter |
| “Power a customer-facing dashboard/API” | Endpoints, preferably materialized where freshness permits |
| “Analyze all history or join in our warehouse” | Batch export to Postgres/BigQuery/Snowflake/etc. |
| “Let Codex/Claude manage and investigate PostHog” | Restricted PostHog MCP |
| “We self-host and can reach ClickHouse” | Still use HogQL API unless building a version-pinned operator tool |

## Limitations and Open Questions

1. No Managed Warehouse credentials were available in this research run, so `EXPLAIN`, `information_schema`, pool behavior, and grounding compatibility were not executed against a live beta tenant.
2. PostHog calls both Managed Warehouse and Endpoints beta products, and Managed Warehouse table layout is explicitly still settling. [3][5][8]
3. No documented parse-only HogQL validation endpoint was found. A PostHog team confirmation or live probe may reveal an internal capability, but the public integration should not depend on it until documented.
4. Managed Warehouse's advertised row pricing is current as of 2026-07-31 and can change. [24]
5. The self-hosted direct-database conclusion is an architectural judgment: physical access is possible for the operator, but current supported user documentation points integrations to HogQL/API rather than promising the internal ClickHouse schema as a public contract.

### Counterevidence Register

- **“PostHog is not directly queryable” is no longer universally true.** Managed Warehouse now supplies a real PostgreSQL endpoint. The conclusion is narrowed by its waitlisted beta status and by the fact that it is a synchronized analytical addition rather than the live Product Analytics database. [3][4][5]
- **The Query API is documented for embedded analytics but discouraged for production.** These statements are not mutually exclusive: small interactive embedding remains supported, while stable customer-facing or high-traffic workloads are directed to Endpoints. [2][7]
- **Managed Warehouse advertises PostgreSQL compatibility but is not PostgreSQL internally.** Standard queries and drivers are supported, while DuckDB extensions are added and PostgreSQL features such as PL/pgSQL, triggers, sequences, and roles are absent. [4]

## Appendix: Methodology

This deep research run inspected 20 current official PostHog documentation/source pages and four local `@deepagents/text2sql` implementation files. Product claims were taken from first-party documentation. Behavioral integration conclusions were checked against the repository's public adapter, execution, grounding, and SQL-policy contracts. No third-party tutorials were needed for the main conclusions.

The search covered direct database protocols, HogQL Query API, Managed Warehouse, Endpoints, batch exports, OAuth and API keys, MCP, schema discovery, rate limits, response formats, and self-hosted architecture. Claims were stored against stable source IDs in `sources.jsonl` and `evidence.jsonl`. The report distinguishes documented facts from implementation recommendations and flags every conclusion that still requires a live tenant probe.

### Claims-Evidence Table

| Claim | Evidence | Confidence |
|---|---|---|
| Managed Warehouse is a real PostgreSQL-wire analytical database | [3][4][5] | High |
| Query API is free-form HogQL but not a production/export substitute | [1][2][7] | High |
| Endpoints and batch exports are PostHog's production and bulk paths | [7][8][9][23] | High |
| Existing Postgres adapter is the correct Managed Warehouse integration | [4][19][20][21] | Medium pending live probe |
| HogQL needs a dedicated adapter rather than ClickHouse/Postgres reuse | [1][6][20][22] | High |
| OAuth is required for an installable third-party product | [10][11][12][13] | High |
| MCP is suitable at the agent layer but not the row-oriented adapter layer | [14][15][16][17][18][21] | High |

### Research Metadata

- Mode: Deep
- Sources registered: 24
- Primary/official PostHog sources: 20
- Local implementation sources: 4
- Retrieval date: 2026-07-31
- Live credentialed PostHog probe: Not performed; credentials were not provided

## Bibliography

[1] PostHog (2026). “SQL access in PostHog.” https://posthog.com/docs/sql (Retrieved 2026-07-31).

[2] PostHog (2026). “API queries.” https://posthog.com/docs/api/queries (Retrieved 2026-07-31).

[3] PostHog (2026). “Managed warehouse.” https://posthog.com/docs/data-warehouse/managed-warehouse (Retrieved 2026-07-31).

[4] PostHog (2026). “Connecting to the managed warehouse.” https://posthog.com/docs/data-warehouse/managed-warehouse/connect (Retrieved 2026-07-31).

[5] PostHog (2026). “Setting up the managed warehouse.” https://posthog.com/docs/data-warehouse/managed-warehouse/setup (Retrieved 2026-07-31).

[6] PostHog (2026). “Linking PostHog as a data warehouse source.” https://posthog.com/docs/data-warehouse/sources/posthog (Retrieved 2026-07-31).

[7] PostHog (2026). “Endpoints vs Query API.” https://posthog.com/docs/endpoints/endpoints-vs-query-api (Retrieved 2026-07-31).

[8] PostHog (2026). “Endpoints.” https://posthog.com/docs/endpoints (Retrieved 2026-07-31).

[9] PostHog (2026). “Batch exports.” https://posthog.com/docs/cdp/batch-exports (Retrieved 2026-07-31).

[10] PostHog (2026). “API overview.” https://posthog.com/docs/api (Retrieved 2026-07-31).

[11] PostHog (2026). “Personal API keys.” https://posthog.com/docs/api/personal-api-keys (Retrieved 2026-07-31).

[12] PostHog (2026). “Project secret API keys.” https://posthog.com/docs/api/project-secret-api-keys (Retrieved 2026-07-31).

[13] PostHog (2026). “OAuth integration.” https://posthog.com/docs/api/oauth (Retrieved 2026-07-31).

[14] PostHog (2026). “Model Context Protocol (MCP).” https://posthog.com/docs/model-context-protocol (Retrieved 2026-07-31).

[15] PostHog (2026). “PostHog MCP source and README.” https://github.com/PostHog/posthog/tree/master/services/mcp (Retrieved 2026-07-31).

[16] PostHog (2026). “MCP executeSql tool source.” https://raw.githubusercontent.com/PostHog/posthog/master/services/mcp/src/tools/posthogAiTools/executeSql.ts (Retrieved 2026-07-31).

[17] PostHog (2026). “MCP readDataSchema tool source.” https://raw.githubusercontent.com/PostHog/posthog/master/services/mcp/src/tools/posthogAiTools/readDataSchema.ts (Retrieved 2026-07-31).

[18] PostHog (2026). “MCP tool input schemas.” https://raw.githubusercontent.com/PostHog/posthog/master/services/mcp/src/schema/tool-inputs.ts (Retrieved 2026-07-31).

[19] DeepAgents (2026). “Postgres adapter implementation.” `packages/text2sql/src/lib/adapters/postgres/postgres.ts` (Inspected 2026-07-31).

[20] DeepAgents (2026). “Parser-backed SQL policy.” `packages/text2sql/src/lib/adapters/parser-sql-policy.ts` (Inspected 2026-07-31).

[21] DeepAgents (2026). “Adapter contract.” `packages/text2sql/src/lib/adapters/adapter.ts` (Inspected 2026-07-31).

[22] DeepAgents (2026). “ClickHouse SQL policy.” `packages/text2sql/src/lib/adapters/clickhouse/clickhouse.sql-policy.ts` (Inspected 2026-07-31).

[23] PostHog (2026). “Endpoints rate limits.” https://posthog.com/docs/endpoints/rate-limits (Retrieved 2026-07-31).

[24] PostHog (2026). “Product and pricing overview.” https://posthog.com/ (Retrieved 2026-07-31).
