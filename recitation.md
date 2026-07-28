# Recitation and Plan Review

## Status

This document defines one production-quality plan-review solution built in
phases. The phases are not separate product versions and no phase is a
throwaway implementation.

The current design scope is the agent exported by `@deepagents/context`.
Legacy `@deepagents/agent`, legacy `@deepagents/orchestrator`, and the old
DeepPlan experiment are outside the design.

Phases 1 through 4 are implemented. The remaining open concern is optional
coordination for simultaneous writers; it is not part of the single-writer
contract implemented here.

## Core idea

Recitation is attention control. It brings the current plan back to the end of
the model's context and asks:

> Is the current plan still valid given the latest evidence?

The plan, its storage, and its dependency graph are separate concerns.
Recitation should consume their compact public projection without depending on
their physical representation.

The conceptual split is:

```text
Plan
├── Objective
├── Success criteria
├── Constraints
├── Assumptions
└── Executable task DAG

Review
├── Current plan projection
├── Evidence gathered since the previous review
├── "Is the current plan still valid given the latest evidence?"
└── Continue, revise, replace, complete, or blocked
```

## Established implementation facts

- `@deepagents/context` agents require an `AgentSandbox`.
- The agent automatically merges the sandbox's `bash`, `readFile`, and
  `writeFile` tools into its tool set.
- Every `AgentSandbox` also exposes the portable underlying sandbox `readFile`
  operation to host-side context features.
- `reminder(..., { target: 'steer' })` is the existing mid-loop recitation
  mechanism. It injects a synthetic message at a safe model boundary and
  persists the same assistant/steer/assistant sequence the model saw.
- `WhenContext` does not currently expose a model step number.
- `everyNTurns()` is not a useful cadence for a long agent loop occurring
  inside one user turn.
- `everyNToolCalls()` fires once after the configured number of completed tool
  outcomes in the assistant segment. It is stateless and counts
  `output-available`, `output-error`, and `output-denied`. A firing reminder is
  persisted with a fresh assistant segment before delivery, so the count resets
  durably before the model can continue.
- The current sandbox subcommand helper is specific to virtual Bash. It is not
  a portable command mechanism for every sandbox backend.

## Phase 1: Recitation contract

### Goal

Define when review occurs, what the model sees, and what the model must do,
using the reminder primitives that already exist.

### Cadence

Use completed tool operations as the evidence cadence:

```ts
context.set(
  plan.review({
    when: everyNToolCalls(5),
  }),
);
```

This intentionally means:

> After approximately five completed tool operations since the previous
> recitation, redirect the agent's attention to the current plan.

This is preferable to counting arbitrary model steps. Tools are where the agent
usually acquires evidence or changes the workspace. Pure reasoning without new
evidence does not need to trigger a plan review.

Parallel tool calls count individually. That is consistent with the
evidence-cadence definition.

The cadence is a stateless level predicate over the current assistant segment.
The context engine persists the reminder boundary before delivery, so the next
evaluation sees a fresh segment instead of repeating the same threshold.
`plan.review()` remains a simple consumer of any caller-supplied predicate.

### Model-visible payload

The recurring payload contains a compact projection of the current sandbox
plan and ends with the fixed review question:

```text
Current plan (revision 4)
Objective: ...
Success criteria: ...
Active tasks: ...
Ready tasks: ...
Waiting tasks: ...

Re-read the current plan and consider the evidence gathered since the previous
review.

Is the current plan still valid given the latest evidence?

If yes, continue. If not, revise it before taking another action.
Before claiming completion, verify the success criteria against evidence.
```

The payload should not repeat the complete planning instructions. Its purpose
is to move the plan and the review question back into the model's immediate
attention.

### Behavioral contract

When recitation fires, the agent must:

1. Obtain the current compact plan projection through the plan-state boundary.
2. Compare it with evidence gathered since the previous review.
3. Decide `continue`, `revise`, `replace`, `complete`, or `blocked`.
4. Record the decision and its evidence in the plan file.
5. Apply any required revision before continuing work.
6. Verify success criteria before claiming completion.

### API boundary

`plan.review()` should compose the existing steer reminder. It should not
create a second reminder engine or a general recitation abstraction.

The reminder callback receives the same `AgentSandbox` used by the agent. It
reads the current plan file when the reminder fires, validates it, derives the
dependency projection, and returns the compact payload.

### Phase exit criteria

- The cadence is defined as completed tool operations.
- The exact recurring model-visible question is fixed.
- Review decisions and required behavior are defined.
- Recitation remains a composition of the current steer reminder.
- The projection is loaded at fire time rather than frozen when the agent loop
  begins.
- A still-true cadence predicate cannot duplicate the same threshold crossing.

## Phase 2: Plan instructions

### Goal

Teach the agent to create and maintain a useful plan without requiring the user
to provide a structured objective, success criteria, or constraints.

These are stable plan instructions. They are not repeated in every recitation.

### Information sources

The agent derives plan content from, in priority order:

1. The user's request and later corrections.
2. Higher-priority system, developer, and workspace instructions.
3. Workspace guidance such as `AGENTS.md`.
4. Existing source, public contracts, tests, documentation, issues, and
   generated artifacts.
5. The current branch, working-tree diff, and pre-existing work.
6. Runtime observations, reproduction results, errors, logs, and tool output.
7. Sandbox, permission, and available-tool constraints.
8. Existing plan state when resuming.
9. Dependencies and risks discovered during execution.

### Provenance

Every important plan statement must retain its basis:

- **Explicit requirement:** stated by the user or a higher-priority
  instruction.
- **Discovered constraint:** demonstrated by source, a public contract, a test,
  or runtime evidence.
- **Inference:** a conclusion supported by available evidence but not directly
  stated.
- **Assumption:** an unresolved belief that may require confirmation.

An assumption must not silently become a requirement or constraint.

### Objective

The objective is a concise restatement of the outcome the user is trying to
achieve. It should describe the result, not merely the requested activity.

### Success criteria

The agent derives verifiable success criteria from the requested outcome and
the workspace's actual validation mechanisms. Examples include:

- The reported behavior is reproduced before a bug fix.
- The root cause is demonstrated.
- The final behavior is exercised through the public API.
- The relevant integration test passes.
- Required type checks or builds pass.
- The result respects explicit compatibility or product constraints.

The user does not need to author these criteria.

### Constraints and assumptions

Constraints are included only when explicitly stated or demonstrated by
evidence. Possible concerns such as “changing this public API may be
undesirable” remain assumptions until supported.

### Asking the user

The agent asks only when an unresolved choice:

- materially changes the product outcome;
- cannot be answered from the workspace or runtime;
- or would require authority beyond the user's request.

Lack of a user-authored plan schema is not a reason to ask.

### Completion rule

Task statuses alone never prove completion. Before claiming completion, the
agent must review the success criteria and associate each satisfied criterion
with concrete evidence.

### Phase exit criteria

- The agent can infer a plan from an ordinary user request and workspace
  evidence.
- Requirements, constraints, inferences, and assumptions remain distinct.
- User questions are reserved for material unresolved choices.
- Completion is evidence-based.
- The recurring recitation payload remains compact.

## Phase 3: Authoritative state and dependency DAG

### Goal

Keep one authoritative plan file in the agent's sandbox, validate it whenever
it is recited, and derive its dependency graph without adding another model
tool.

The fixed path is:

```text
/workspace/.deepagents/plan.json
```

The agent edits this file directly using the sandbox tools already present on
every `@deepagents/context` agent.

### DAG representation

`blockedBy` is the canonical edge direction. `blocks` is derived:

```text
T3.blockedBy = [T1, T2]

therefore:

T1.blocks includes T3
T2.blocks includes T3
```

Storing both representations as independent writable fields would allow them
to disagree.

### Read-time invariants

Every recitation validates:

- every blocker references an existing task;
- a task cannot block itself;
- dependency cycles are rejected;
- reverse `blocks` edges are derived consistently;
- a task is ready only when every blocker is completed;
- an active task must be ready;
- review decisions refer to the plan revision they evaluated;
- completed tasks include evidence;
- completion requires success-criteria evidence.

The file schema also rejects duplicate task and success-criterion identifiers,
duplicate blocker edges, invalid statuses, empty required text, and unknown
fields.

### Direct mutation boundary

The model may edit the authoritative file directly. Validation is deliberately
detective rather than preventative: an invalid edit produces an actionable
steer reminder directing the agent to repair the file before continuing.

The plan stores only canonical fields. `blocks`, ready work, and waiting work
are derived on every read, so direct edits cannot create conflicting copies of
those values.

This design assumes one writer per plan. Direct file writes do not provide
compare-and-swap semantics, so simultaneous agents writing the same path may
overwrite one another.

### Chosen representation

Use one JSON file containing the plan metadata, criteria, constraints,
assumptions, tasks, evidence, and last review.

The revision changes when objective, criteria, constraints, assumptions, tasks,
or dependencies change. Recording a review decision without changing the plan
does not itself increment the revision.

One file keeps the dependency graph and revision together. One writable file
per task remains rejected because graph-wide validation would span multiple
independently written files.

### No additional tool

No `plan` AI SDK tool or sandbox subcommand is added. The existing `bash`,
`readFile`, and `writeFile` tools are sufficient now that bypassable direct
edits are accepted.

### Persistence ownership

DeepAgents owns the schema, read-time validation, and compact projection while
the sandbox exists. The caller owns sandbox durability.

If state must survive disposal, the caller supplies a persistent volume, bind
mount, or backend-specific persistence mechanism. The plan system documents
this requirement but does not manage sandbox lifecycle.

### Phase exit criteria

- One sandbox-owned file works across supported sandboxes.
- The agent can edit the file using its existing tools.
- Invalid JSON, schema violations, and invalid DAGs produce an actionable
  recitation instead of being silently accepted.
- Recitation receives a compact projection with derived readiness and reverse
  edges.
- Persistence responsibilities are documented at the sandbox boundary.

## Phase 4: End-to-end integration

### Goal

Connect inferred plans, authoritative state, and steer recitation into one
observable agent flow.

### Flow

```text
ordinary user request
        │
        ▼
plan instructions infer objective, criteria, constraints, and assumptions
        │
        ▼
sandbox plan file is initialized
        │
        ▼
agent executes work and gathers evidence through tools
        │
        ▼
tool-call cadence triggers plan.review()
        │
        ▼
compact plan and review question are recited through target: "steer"
        │
        ▼
agent records continue/revise/replace/complete/blocked
        │
        ├── revise/replace ──► rewrite and revalidate plan ──► continue
        └── complete ────────► success-criteria evidence check
```

### Integration requirements

- The model-visible steer message and the persisted transcript must match.
- A review decision must identify the plan revision it evaluated.
- Evidence gathered since the previous review must be available to the review.
- A revised plan must become authoritative before further execution.
- Resume must load the latest authoritative plan rather than reconstructing it
  from transcript prose.
- The dependency graph must expose ready work without requiring the model to
  calculate reverse edges.
- The final response must not claim completion until the success criteria are
  supported by evidence.

### Verification

Exercise the public `@deepagents/context` agent flow with integration tests:

1. Start from an ordinary unstructured user request.
2. Confirm that plan instructions derive the required planning fields.
3. Execute five completed tool operations.
4. Confirm that a steer recitation is injected and persisted.
5. Introduce evidence that invalidates the current plan.
6. Confirm that the agent records a revision in the plan file before
   continuing.
7. Confirm that dependency readiness reflects the revised DAG.
8. Confirm that completion is refused without success-criteria evidence.
9. Confirm that a fresh context engine sharing the sandbox resumes the latest
   plan. Durability after sandbox disposal remains the caller/backend contract.

### Phase exit criteria

- The full flow works through public APIs.
- Recitation reliably redirects attention after the defined evidence cadence.
- Replanning is evidence-driven and durable.
- DAG invariants remain valid throughout execution.
- Completion is evidence-backed.

### Implemented verification

The public agent-flow integration test now proves that an agent:

1. creates the sandbox plan from an ordinary request;
2. encounters tool evidence that invalidates an assumption;
3. receives the persisted steer review after the evidence cadence;
4. records the evaluated revision and revises the plan before continuing;
5. attempts an unsupported completion and receives an actionable repair
   recitation;
6. adds criterion evidence, completes the plan, and resumes that exact plan
   from a fresh context engine sharing the sandbox.

## Decisions

- Build one proper solution in phases, not multiple disposable versions.
- Keep recitation separate from storage representation.
- Use the existing steer reminder as the recitation mechanism.
- Use completed tool calls as the current review cadence.
- Persist the reminder boundary before delivery so one threshold crossing
  produces one recitation.
- Keep planning intelligence in stable instructions, not the recurring
  reminder.
- Infer plan fields from the request, workspace, and evidence.
- Store `blockedBy` canonically and derive `blocks`.
- Store the plan in one sandbox-owned JSON file.
- Allow direct model edits and validate the resulting state when it is read.
- Do not add another model tool for plan maintenance.
- Do not use the virtual-Bash-only subcommand mechanism as the universal
  mutation interface.
- Make sandbox durability the caller's responsibility.

## Open questions

- Should simultaneous writers ever be supported through an optional
  compare-and-swap mutation path?

---

# Appendix A: Verbatim initiating questions and comments

> I am reading manus article
> they mentioned
>
> manipulate attention
> recitation
>
> very intreestin
> https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

> I love this
> "Is the current plan still valid given the latest evidence?"
>
> I want to add this as first class in deepagents but not sure about it is form. what are our options?

> Can you find the research we did for the agent "tasks" like claude and codex?

> Codex cli source code is open source. Clone it in tmp folder and do deepresearch on it to understand every bit of their "agent tasks/todo" whether they do recitation and where they store the tasks and all other aspects that we need to know about. stuff they do better, what not with thear reasining if documented

> do not use openspec. let us talk inline here

# Appendix B: Verbatim response annotations

## Annotation 1

Selected response:

> The repository already has the necessary delivery mechanism: reminder(..., { target: 'steer' }) injects content during the agent loop, and the engine persists the same assistant/steer/assistant sequence the model saw.

User annotation:

> yup. regarding storage. our agents mandate sandbox. can we use a file path as plan storage? also only one file or multiple ones?

## Annotation 2

Selected response:

> objective: 'Investigate and fix the authentication failure',
> successCriteria: [
> 'Failure reproduced',
> 'Root cause demonstrated',
> 'Fix verified by an integration test',
> ],
> constraints: ['Do not change the public authentication contract'],

User annotation:

> the problem with this is that user doesn't specify them unless the user acutally knows them but user typical deosn't and the agent should infer those from user prompt, work space, ...etc "you tell me what else"

## Annotation 3

Selected response:

> context.set(
> plan.review({
> when: everyNSteps(5),
> }),
> );

User annotation:

> I like it

## Annotation 4

Selected response:

> tools: {
> ...plan.tools,
> // other tools
> },

User annotation:

> what tools? do we need tools? why if we are using sandbox that auto adds bash tool. keep in mind I am referning to the agnet from @deepagents/context

## Annotation 5

Selected response:

> @deepagents/agent

User annotation:

> this is legacy. we do not use it anymore

## Annotation 6

Selected response:

> @deepagents/orchestrator

User annotation:

> this is legacy too

## Annotation 7

Selected response:

> DeepPlan already implements the heavyweight version: structured replanning after every executed step, with should_continue, remaining_steps, and new_insights. See replanner-agent.ts (line 26) and plan-and-solve.ts (line 196). That should remain opt-in orchestration, not become the default cost for every agent.

User annotation:

> that was an old expriment

## Annotation 8

Selected response:

> Persistent agent tasks surviving context compaction.TaskCreate, TaskUpdate, TaskList, and TaskGet.Compact TaskList output with TaskGet for full details, saving context tokens.blockedBy/blocks dependency DAG.Session isolation through listId, based on Claude Code’s CLAUDE_CODE_TASK_LIST_ID.SQLite persistence instead of Claude Code’s JSON files.Task fragments for injecting current work back into context.Ready-made AI SDK tools.

User annotation:

> is the approched I outlined close to this? or far from it

## Annotation 9

Selected response:

> blockedBy/blocks dependency DAG.

User annotation:

> This is very important

## Annotation 10

Selected response:

> It provides opportunistic recitation when the model updates it

User annotation:

> I do not understand this

## Annotation 11

Selected response:

> persisted proposal artifact, deliberately separate from execution tasks

User annotation:

> you mean they have "plan" and "task" tasks will be derived from the plan, correct?

## Annotation 12

Selected response:

> A possible first version:json

User annotation:

> no first or seond. we need proper solution and great one from the start

## Annotation 13

Selected response:

> The DAG is first-class, but I would store only blockedBy canonically and derive blocks. Storing both creates two representations that can disagree.

User annotation:

> I agree but that also means the agent cannot update the file diredctly.

## Annotation 14

Selected response:

> The agent should infer the planYou are correct: users should not have to write objective, successCriteria, or constraints.The agent derives them from:The user’s request and subsequent corrections.System and workspace instructions such as AGENTS.md.Existing source, public contracts, tests, documentation, and issue context.Current branch, diff, and pre-existing work.Runtime observations, errors, logs, and reproduction evidence.Sandbox, permission, and tool limitations.Existing plan state when resuming.Dependencies discovered while investigating.The important part is provenance:“The user explicitly requested X” is a requirement.“A public test demonstrates X” is a discovered constraint.“Changing this API might be undesirable” is only an assumption.The agent asks the user only when an unresolved choice materially changes the product outcome. It should not silently promote guesses into constraints.

User annotation:

> is this going to be part of the plan instructions? look I said above no verions and I stand with it but we should do phases

## Annotation 15

Selected response:

> For a first-class implementation, I would provide a plan command inside the sandbox:bashplan show
> plan task add
> plan task start T2
> plan task block T3 --on T2
> plan task complete T2 --evidence ...
> plan reviewThat is not another AI SDK tool. It is a sandbox command invoked through Bash, enforcing atomic revisions and DAG invariants. The repository already has a reusable subcommand pattern for this kind of interface (subcommand.ts (line 29)).

User annotation:

> nice idea but too much trouble. subcommands only for virtual bash. it doesn't work with any other sandbox. maybe the storage format is leading to this design needs a brain storming

## Annotation 16

Selected response:

> One concrete missing primitive remains: everyNSteps() does not exist yet. The current WhenContext has turns, messages, usage, and tool outcomes, but no step number (types.ts (line 66)). Adding step metadata is the small engine-level capability gap.

User annotation:

> can we use the closests other predictor? I want this sessoin to focus on recitation

## Annotation 17

Selected response:

> The remaining architectural decision is whether plans must survive sandbox disposal and be shared among concurrent agents. If yes, we should design persistent mounting and transactional revisions from day one; if no, the single JSON file is enough.

User annotation:

> that is on the user. they should use volumes or something to have it persisted

---

# Appendix C: Verbatim storage clarification

> I do not mind if the agent can "Bypassable"
