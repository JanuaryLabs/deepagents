# DeepAgents release readiness — 2026-10-02

Validation continued on October 3 after a network interruption.

The packaging audit covers all **16 public packages**. Reproduced packaging and
release-command defects are repaired. A reproduced runtime subscription cleanup
race is fixed; the complete 25-file local runtime batch now passes with 284
passing tests and one pre-existing TODO. Local npm identity and package write
permissions are verified. Docker is responsive again, and all **732 selected
Docker-enabled tests pass**, including the repaired managed-volume cleanup race.
The remaining publication blocker is renewal of the GitHub Actions npm credential.
Nothing was published, versioned, staged, committed, tagged, or pushed during this
audit. Consumer repositories were read without changing their checkouts or links.

## Release state

- Started from clean `main` at `9a641eeb`, three commits ahead of recorded
  `origin/main`. Local tools: Node 26.8.1, npm 11.19.0, Nx 23.1.0.
- All public manifests currently say **6.2.0**. Local tag `release/6.2.0` is at
  `2f85ee24` (August 20), 86 commits behind the starting checkout.
- Live npm metadata: eight established packages are still **6.1.2**, published
  August 4. The other eight packages have never been published. No published
  6.2.0 was found.
- `nx release --dry-run --skip-publish` succeeds and proposes **7.0.0**, updating
  all 16 versions and their internal dependencies together. The major bump
  follows the accumulated breaking conventional commits. Do not reuse the old
  6.2.0 tag for the current source.
- `nx release publish --dry-run` succeeds for all 16. Dry runs do **not** prove
  npm write permissions.

## Repairs

1. Removed `development` export conditions pointing to excluded `src` files in
   text2sql, retrieval, evals, devtool/traces, and devtool-history. An extracted
   retrieval tarball previously failed with `ERR_MODULE_NOT_FOUND` under
   `node --conditions=development`.
2. Declared retrieval's missing `@langchain/core` dependency. Fresh tarball
   imports of retrieval and toolbox failed without the workspace masking it.
   Added SDK provider/provider-utils dependencies referenced by public emitted
   declarations in agent, toolbox, and experimental.
3. Built the JavaScript files promised by toolbox/orchestrator wildcard exports.
   Previously `@deepagents/toolbox/filesystem.js` advertised an absent file.
   Made orchestrator's intentionally empty root an explicit module (`export {}`)
   so its declaration can be imported.
4. Restricted Nx releases and release builds to `tag:scope:public`. The previous
   all-project selection included private apps and failed on `docs:build`.
5. Replaced the obsolete seven-package plugin verifier with
   `npm run verify:packages`. The old verifier omitted the unpublished compaction
   dependency and used the removed runtime-constructor API. CI, pre-version,
   and release workflows now use the same verifier. Release CI checks npm
   authentication before building.
6. Added Node **>=24.0.0** to experimental. Its packed Zukhruf entry point fails
   to parse native `await using` on Node 22.18.0. Packed consumer flows pass on
   Node 24.18.0 and 26.8.1.
7. Updated the pinned test-only Happy DOM dependency from 20.10.6 to 20.11.2.
   Its orphaned weak callback stopped observing editor mutations after garbage
   collection. A standalone GC reproduction failed before and passed after;
   all 175 Composer and 164 GenAI tests pass without production editor changes.
   [Upstream fix](https://github.com/capricorn86/happy-dom/releases/tag/v20.11.2).
8. Fixed generic native `Error` formatting in Context: JSON serialization yielded
   `{}`, breaking the existing failed-child notification contract. Native errors
   now produce `An error occurred.`; structured/string errors retain their
   existing representation so recovery guardrails still recognize provider
   errors. The public chat reproduction and runtime regression tests cover this.
9. Fixed conversation-status subscription teardown: the last subscriber now
   awaits the remote consumer and its database listener closure. Previously an
   aborted subscription reported completion while `UNLISTEN` was still pending,
   allowing its caller to close the database too soon. A public-API scratch
   reproduction and a deterministic integration test fail before and pass after
   the fix. No dependency patch, retry, sleep, or forced test exit was added.
10. Deleted the tracked `.npmrc` override of the registry token with
    `${NPM_ACCESS_TOKEN}`. It masked a successful user login when that variable
    was unset and conflicted with CI's `NODE_AUTH_TOKEN` configuration generated
    by `actions/setup-node`. Reproduced E401 inside the repo versus successful
    authentication outside it; repo authentication succeeds after removal.
11. Fixed managed Docker volume disposal. Docker's automatic container removal
    releases volume references after `docker stop` returns; a busy root filesystem
    reproduced `VolumeRemoveError` on the first public-API attempt. The engine
    adapter now waits up to 30 seconds while volume removal reports `volume is
in use`, preserving other errors and the final busy error on timeout. The
    existing integration test now creates 5,000 temporary root-filesystem entries
    to exercise this teardown window; it failed before and passed after the fix.
    Nx Context typecheck passes. Evidence: `/tmp/deepagents-volume-dispose-repro.log`
    and `test-results/release-volume-{red,green}.xml`.

## What the repeatable verifier proves

`tools/src/verify-packages.ts` builds on real npm tarballs, installed in a temporary
consumer **outside the monorepo**, with no symlinks to workspace packages:

- Every explicit export/bin exists; wildcard declarations have matching JS.
- No test/build-state files ship. Emitted imports have declared dependencies.
- Internal package versions agree, including first-time publications.
- 56 entry points import under normal and `development` conditions.
- Public declaration imports resolve under Bundler, and server entries under
  NodeNext. UI declarations are checked in the Bundler mode used by Factory.
- Browser-facing entry points bundle without Node-only imports.
- A real SQLite/PGlite/pg-boss consumer initializes two isolated agent hosts,
  composes plugin capabilities, traces and scheduling, serves HTTP and DevTool,
  executes a durable streamed turn, persists history, and disposes its resources.
- React server rendering and the installed SQL CLI work.

Model responses are mocked; this does not spend provider credits or claim live
provider, sandbox-service, or production application validation.

## Package coverage

All rows pass fresh build, packed export/import checks, and Nx typecheck.
`new` means the package returned npm 404 before this release.

| Package (`@deepagents/…`) | npm latest | Additional verification                                                                               |
| ------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| agent                     | 6.1.2      | 4 tests                                                                                               |
| context                   | 6.1.2      | 1,001 local tests plus 402 Docker-enabled tests; storage, streaming, sandbox, chat, reminders         |
| compaction                | new        | 22 tests; composed in packed runtime                                                                  |
| elements                  | new        | 61 tests; browser bundle                                                                              |
| evals                     | 6.1.2      | 63 tests                                                                                              |
| experimental              | 6.1.2      | 284 local tests plus 105 PostgreSQL-enabled tests; 1 existing local TODO; cleanup regression included |
| devtool                   | new        | 9 tests; packed UI assets served over HTTP                                                            |
| devtool-history           | new        | 1 test; browser bundle                                                                                |
| react-formatters          | new        | 62 tests; browser bundle                                                                              |
| react-genai               | new        | 164 tests; browser bundle                                                                             |
| react-input               | new        | 175 tests; browser bundle                                                                             |
| react-shadcn              | new        | 1 test; packed SSR and browser bundle                                                                 |
| retrieval                 | 6.1.2      | Root/connectors imports and declared-dependency audit                                                 |
| toolbox                   | 6.1.2      | Root import; wildcard files; filesystem deep import                                                   |
| orchestrator              | 6.1.2      | Root import; wildcard files; safe plan-and-solve deep import                                          |
| text2sql                  | 6.1.2      | 320 local tests plus 225 Docker-enabled tests; adapter subpaths and installed CLI                     |

Private `@deepagents/test` is build/test infrastructure, excluded from publication.
Private DevTool UI is built as a dependency and has 11 passing UI tests. No new
public packages are inferred from the private apps.

Final checks: cache-free build of all 16 public packages passed; Nx typechecks
passed for all 16 plus DevTool UI (38 tasks including dependencies); `npm ci
--dry-run --ignore-scripts` accepted the lockfile. The completed patch passed
`npm run verify:packages` on Node 26 and the same tarball verifier on Node 24.
Both Nx version and publication dry runs passed. After the subscription cleanup
fix, `npm run verify:packages` passed again on Node 26, including all 16 fresh
package installs, 56 entry points and the packed runtime flow. Runtime verification and the remaining CI credential gate are detailed below.

After the managed-volume cleanup fix, `npm run verify:packages` passed again
for all 16 packages and 56 entry points, and Context's Nx typecheck passed.
Evidence: `/tmp/deepagents-final-package-verification.log` and
`/tmp/deepagents-volume-typecheck.log`.

## Actual consumers and migration work

Discovery covered manifests, source imports, and installed links under
Desktop/January, Desktop/experiments, and Desktop/Projects. **250 distinct named
imports across seven repositories** resolve against isolated packed declarations.
The counts below are per repository, not globally unique symbols. This is an
API import audit, not a claim that all seven applications were fully built or
end-to-end tested.

| Repository                                                   | Usage found                                                                                 | Required release migration                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Desktop/experiments/factory` (36 imports)                   | Zukhruf ready host, HTTP/uploads, traces/DevTool, GenAI and Composer; React packages linked | Replace API/web `file:` dependencies with the released version. Delete obsolete `@deepagents/devtool-traces`: source already imports `@deepagents/devtool/traces`. Remove its broken entry from `tools/link-deepagents.mjs`. |
| `Desktop/experiments/finetuning` (36)                        | Teacher/task-author hosts, MCP, HTTP, traces and datasets                                   | Replace context/experimental/devtool local paths **and** dependency paths into DeepAgents `node_modules`.                                                                                                                    |
| `Desktop/January/dynamic-subagents` (17)                     | Agent trees, `defineStack`, initialized hosts and turn queues                               | Replace local context/experimental and pg-boss/just-bash paths. Existing Node >=24.11 requirement is compatible.                                                                                                             |
| `Desktop/Projects/april` (22)                                | Lower-level agent/context, file telemetry, reminders and plans                              | Replace harness local agent/context paths; align dashboard/bridge/root ^6.1.0 ranges to the chosen release.                                                                                                                  |
| `Desktop/January/text2sql` (76)                              | Context chat/browser types, SQL adapters, grounding, synthesis, sandbox tracing             | Currently registry-installed 6.1.2, not linked. Upgrade all workspace context/text2sql ranges together; run its application checks.                                                                                          |
| `Desktop/experiments/blackboard` (49)                        | Group/WhatsApp runtime, conversation scheduling, HTTP and telemetry                         | Upgrade pinned 6.1.2 and raise Node >=22.22 to >=24. Runtime call sites already use `initialize(stack)`.                                                                                                                     |
| `Desktop/January/agent-plugin/hooks/ezzs-way-of-coding` (14) | Coding-agent reminders                                                                      | Explicitly upgrade its pinned experimental 4.3.0; used reminder exports still resolve.                                                                                                                                       |

Older consumers also exist: applets (context 0.31), study
(agent/context/retrieval 0.36), thing (0.1.2), and January/evals (text2sql 0.17.1).
Treat these as separate major-version migrations rather than bulk upgrades.

Factory's link helper also links its pg/microsandbox/Hono/React copies back into
DeepAgents for module identity. After publication, align shared versions and
inspect `npm ls`; do not carry these source-link workarounds into deployment.
Its Tailwind directives scan package roots, not unpublished `src` directories,
so packed `dist` assets remain within the configured scan paths.

For finetuning's paths into DeepAgents `node_modules`, the observed replacement
versions are: `@ai-sdk/mcp` 2.0.41, `@hono/node-server` 2.1.1, esbuild 0.28.1,
hono 4.12.33, just-bash 3.2.0, pg-boss 12.29.0, run 2.0.0, zod 4.4.3, and ai
7.0.85. These are installed-version observations, not blanket upgrade advice.

## Publication gate and runtime verification

- **Registry authorization:** after login and the configuration repair, local
  `npm whoami` succeeded as `ezzabuzaid`.
  `npm access list packages ezzabuzaid` confirms read/write access to all eight
  established packages, and `npm org ls deepagents` confirms the account is an
  organization owner, covering creation of the eight new names. The last recorded
  [Release workflow](https://github.com/JanuaryLabs/deepagents/actions/runs/30718929133)
  failed publishing release/6.1.1 with npm PUT 404/permission errors for agent,
  evals and retrieval. GitHub's `NPM_ACCESS_TOKEN` was last updated February 20, unchanged on the
  final October 3 metadata check.
  npm token metadata shows the previous DeepAgents automation tokens expired or
  revoked. A replacement scoped to `@deepagents` package read/write is required
  for CI; no organization-management permission is needed. The user was asked to
  create and save it directly with `gh secret set`, without sharing it in chat.
  Secret values were not printed or modified by this audit. The workflow checks
  `npm whoami` before building; no live publish has been attempted.
- **Docker/service coverage — passed:** **732 selected tests pass**, with zero
  failures, cancellations, skips or TODOs in the counted suites. Coverage is
  summarized below. The user-authorized Docker Desktop restart restored daemon
  responsiveness (Engine 29.8.0). The two interrupted Context Compiler services
  were restarted; the existing artifact and text2sql services are running.
  Final process/container inspection confirms no test runners or containers
  started by this audit remain. Unrelated containers were preserved.

  | Suite                                                              | Passed | Evidence under `test-results/`             |
  | ------------------------------------------------------------------ | -----: | ------------------------------------------ |
  | Runtime PostgreSQL queues, recovery, scheduling and notifications  |    105 | `release-docker-experimental.xml`          |
  | Context PostgreSQL storage                                         |    138 | `release-docker-context-postgres.xml`      |
  | text2sql PostgreSQL grounding, filesystem and readiness            |     64 | `release-docker-text2sql-postgres.xml`     |
  | Context SQL Server storage                                         |    119 | `release-docker-context-sqlserver.xml`     |
  | text2sql SQL Server filesystem                                     |     60 | `release-docker-text2sql-sqlserver.xml`    |
  | SQL Server full-text search                                        |     10 | `release-docker-context-fts.xml`           |
  | SQL policy: SQLite, PostgreSQL, MySQL, SQL Server and spreadsheet  |     65 | `release-docker-sql-policy.xml`            |
  | ClickHouse 25.8                                                    |     18 | `release-docker-clickhouse25.xml`          |
  | ClickHouse 26.6                                                    |     18 | `release-docker-clickhouse26.xml`          |
  | Docker sandbox and file-change tracking, final run                 |    118 | `release-docker-context-sandbox-final.xml` |
  | Bin installer and Docker spawn, successful suites from initial run |     17 | `release-docker-context-sandbox.xml`       |

  An earlier network interruption caused Docker Hub, Alpine and Debian
  DNS/download failures. That sandbox attempt had 101 passes, 22 failures and
  12 cancellations; only its two wholly successful installer/spawn suites
  contribute the 17 tests above. After DNS recovered and images were prepared,
  the affected sandbox files passed 117/118 tests and exposed the managed-volume
  race in repair 11. Following the fix, all 118 passed in 410 seconds, including
  native and emulated-architecture strace checks. The scratch reproduction and
  strengthened regression establish red/green evidence for the cleanup fix.
  Completed database batches were unaffected and were not needlessly repeated.
  Newly downloaded database images were selectively removed after verification
  when disk space was tight. Initial cold-download batches that were stopped
  are not counted as passes. Live BigQuery is excluded from this validation.

- **Known runtime TODO:** the existing pg-boss retention test remains marked TODO
  because a deleted queue job held the only payload needed for re-execution.
  Existing backlog #682 tracks the intended orphan-terminal behavior. This is
  a known runtime limitation, not a packaging failure or a new green test.
- **Runtime hang investigation and verification:** the original child-activity
  hang's profile showed repeated WebAssembly error creation. The installed
  PGlite 0.5.4 has an [upstream close/query race](https://github.com/electric-sql/pglite/issues/1084)
  that can block the event loop and prevent timeouts. The public-API reproduction
  confirmed that our status subscription finished before its database listener
  closed; the implementation now awaits that cleanup. The regression failed
  before and passed after. The complete 25-file batch passed without diagnostic
  instrumentation: **284 passed, 0 failed, 0 cancelled, 0 skipped, 1 existing TODO**,
  in 175 seconds. The focused child-activity/runtime run also passed (55 passed,
  1 TODO), and Nx experimental typecheck passed. Three further child-activity
  repetitions passed without instrumentation (39 seconds total). This fixes a demonstrated
  shutdown race consistent with the original profile; the original frozen
  process did not provide a JavaScript stack proving that exact call path.
  One subsequent runtime run was stopped too early during investigation;
  high CPU was normal PGlite work, not independent evidence of another hang.
  Evidence: `test-results/release-runtime-fixed.xml`,
  `/tmp/deepagents-cleanup-red.log`, `/tmp/deepagents-cleanup-green.log`,
  `/tmp/deepagents-status-cleanup-repro.mjs`,
  `/tmp/deepagents-close-trace.log`, and `/tmp/deepagents-child-repeat-fixed.log`.
- **Environment coverage:** all 1,001 selected Context tests passed in the final
  run, including the disk-full case after allowing its macOS APFS disk image.
  Live provider/API tests and agent-os sandbox downloads were outside this pass.

Captured follow-ups: backlog **#2170** (deprecated cron-parser 5.6.2 tarball;
verify scheduling behavior when upgrading), **#2173** (diagnose the unrelated
docs-site build failure), and **#2175** (bound the Docker availability probe so
an unresponsive daemon cannot hang test setup), and **#2179** (move release CI
to trusted publishing after the new package names exist, before
[npm removes direct token publishing in January 2027](https://docs.npmjs.com/about-access-tokens/)).
These were kept separate from the required daemon recovery and release validation.

## Release procedure

Do not run `nx release` to repair authentication. Local login and account/package
write permissions are verified; renew and verify the CI credential separately.
Review/commit the preparation changes first. On a clean checkout with working
Docker and registry access:

```sh
npm ci
npx nx run-many -t typecheck --projects=tag:scope:public,@deepagents/devtool-ui
npx nx run-many -t test --projects=tag:scope:public
npm run verify:packages
npx nx release --dry-run --skip-publish
npx nx release publish --dry-run
```

After checking the generated version/changelog, an authorized release operator
can run `npx nx release --skip-publish`, then push the resulting release commit
and its new tag. The tag triggers GitHub's publishing workflow. Keep publication
in one place; do not also publish locally. Confirm all 16 registry versions
before switching consumer manifests and regenerating their lockfiles. Use a
clean consumer install and its normal typecheck/build/tests without npm links.

Scratch command logs live under `/tmp/deepagents-*.log`; this report preserves
the conclusions. The verifier is the repeatable packaging gate. Re-run dry runs
if commits or package versions change before release.
