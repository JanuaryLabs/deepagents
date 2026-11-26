---
name: aisdk-parity
description: Compare what the AI SDK and the vercel / vercel-labs GitHub orgs ship with the code deepagents owns, and file the code we can stop owning. Use when asked whether AI SDK or Vercel "does this now", to audit deepagents against upstream, after bumping `ai` or `@ai-sdk/*`, or when a new Vercel agent package or repository appears.
---

# AI SDK parity

deepagents exists to fill AI SDK gaps. Once upstream covers a concept, we stop owning its code. [docs/aisdk-parity.md](../../../docs/aisdk-parity.md) holds one row per concept we own, with a verdict. [docs/aisdk-parity.snapshot.json](../../../docs/aisdk-parity.snapshot.json) records the upstream state the ledger was checked against, and its `watch` list names the npm packages outside vercel/ai that the ledger follows.

## Steps

1. **Delta.** `npx nx run tools:aisdk-delta > <scratchpad>/delta.md`. Since the snapshot it lists each moved package's changelog entries and export changes, new `@ai-sdk/*` packages, and new or removed vercel / vercel-labs repositories. Packages that only bumped dependencies are one line. Under "Ledger rows citing missing files" it lists each row whose `Ours` file under `packages/` no longer exists.
2. **Match.** Map each delta entry to the ledger rows of the concept it touches. Most entries touch none. For a new package or repository, read its README and its source exports before deciding.
3. **Verify against source.** Before a verdict changes, read the published code: `npm pack <pkg>@<version>` or the repository at a commit. Cite it pinned (a tarball path with its version, or a GitHub permalink at a SHA). A behavioural claim gets a scratchpad probe against the real package first.
4. **Update the ledger.** Change the row's verdict, upstream evidence and action. Add a row for a concept we own that the ledger lacks. For each row that cites a missing file, find where the code went and cite it, or delete the row when the code is gone.
5. **File.** Each row that becomes `covered` or `partial` gets `agent-backlog add --kind debt --work-type change`, and its id goes in the row. Deletions run through `/coding:remove-code`. text2sql rows are file-only.
6. **Move the baseline.** `npx nx run tools:aisdk-delta --args=--write`, then commit the ledger and the snapshot together.

## Verdicts

- `covered`: upstream does what the row does. Delete ours.
- `partial`: upstream owns part of it. Compose that part, keep the rest, and name the rest.
- `blocked`: upstream covers the concept but breaks a named rule. Keep ours, and recheck when upstream changes. The rules:
  - AGENTS.md "Force the deployment into the design": several processes on any number of hosts, with ownership in the shared store.
  - Self-hosted deploy target: a service that runs only on Vercel's platform cannot replace self-hosted code.
  - Postgres-backed stores take a host-supplied `pg.Pool` only.
  - Owner decision, 2026-11-26: no Vercel Workflow (`workflow`, `@workflow/*`, `@ai-sdk/workflow`, `@ai-sdk/workflow-harness`, eve). pg-boss stays.
- `gap`: nothing upstream does it. Keep ours.
- `domain`: not an AI SDK concern.

## Gotchas

- A matching name is not a matching capability. Compare behaviour per type and per wire contract, and cite both sides.
- An `experimental_` prefix, a version pin or an extra install is a cost to report, not a reason to keep our copy.
- A gap that only a demo, eval or test exercises is not a gap. Name the `packages/` call site.
- To follow a package outside vercel/ai, add its npm name to the snapshot's `watch` list; the next `--write` records its version.
- Each ledger table sits behind a `<!-- prettier-ignore -->` line. Keep it there: without it Prettier pads every column, and the file triples in size for every agent that reads it.
