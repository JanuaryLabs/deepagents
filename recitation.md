# Recitation and Plan Review

## Status

This document defines one production-quality plan-review solution built in
phases. The phases are not separate product versions and no phase is a
throwaway implementation.

The current design scope is the agent exported by `@deepagents/context`.
Legacy `@deepagents/agent`, legacy `@deepagents/orchestrator`, and the old
DeepPlan experiment are outside the design.

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
- `reminder(..., { target: 'steer' })` is the existing mid-loop recitation
  mechanism. It injects a synthetic message at a safe model boundary and
  persists the same assistant/steer/assistant sequence the model saw.
- `WhenContext` does not currently expose a model step number.
- `everyNTurns()` is not a useful cadence for a long agent loop occurring
  inside one user turn.
- `toolCallCount()` can count completed tool calls in the assistant segment
  since the previous steer reminder. A firing steer reminder carves the
  assistant chain, so the count effectively restarts after recitation.
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
    when: toolCallCount(() => true, { gte: 5 }),
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

### Model-visible payload

The recurring payload should be short:

```text
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
4. Record the decision and its evidence through validated plan-state
   operations.
5. Apply any required revision before continuing work.
6. Verify success criteria before claiming completion.

### API boundary

`plan.review()` should compose the existing steer reminder. It should not
create a second reminder engine or a general recitation abstraction.

The eventual plan-state provider may supply dynamic content to the reminder,
but `plan.review()` must not know whether the state is stored as files, SQLite,
or another backend.

### Phase exit criteria

- The cadence is defined as completed tool operations.
- The exact recurring model-visible question is fixed.
- Review decisions and required behavior are defined.
- Recitation remains a composition of the current steer reminder.
- No storage representation is embedded into the recitation contract.

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

Choose a portable authoritative state boundary that supports validated plan
mutations and a dependency DAG across every supported sandbox.

This phase requires a dedicated storage brainstorm. The recitation design must
not prejudge its result.

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

### Required invariants

The authoritative state boundary must enforce:

- every blocker references an existing task;
- a task cannot block itself;
- dependency cycles are rejected;
- reverse `blocks` edges are derived consistently;
- a task is ready only when every blocker is completed;
- an active task must be ready;
- status transitions are valid;
- concurrent updates cannot silently overwrite a newer revision;
- review decisions refer to the plan revision they evaluated;
- completion requires success-criteria evidence.

### Mutation boundary

The agent must not edit authoritative plan state directly. Direct file editing
cannot reliably preserve the DAG, revision, and lifecycle invariants.

All mutations must pass through one validated boundary, regardless of the
physical storage format.

### Rejected approaches

#### Direct model edits to JSON

Rejected because the model could introduce invalid references, cycles, stale
reverse edges, or lost updates.

#### One writable file per task

Rejected because cross-task dependency changes would not be atomic and graph
validation would span multiple independently editable files.

#### A sandbox `plan` subcommand as the universal interface

Rejected as the general solution because the current custom-subcommand
mechanism only works with virtual Bash. Other sandbox backends do not share
that command-registration surface.

### Storage brainstorm questions

The storage phase must compare at least these boundaries:

1. A sandbox-backed store accessed through a portable host-side validated
   operation.
2. A single database file inside the sandbox with transactional mutations.
3. An existing `@deepagents/context` persistence primitive adapted to plan
   state.
4. Engine-mediated mutations that do not expose another model tool.

The comparison must answer:

- How does the model request a validated mutation?
- Does the approach work with every `AgentSandbox` implementation?
- Can the state remain physically owned by the sandbox?
- Are graph updates and plan revisions atomic?
- Can recitation obtain a compact projection without loading all task detail?
- Can multiple agents coordinate without lost updates?
- Does the design add another AI SDK tool, and if so, is that tool necessary?
- Can the same public contract support ephemeral and volume-backed sandboxes?

### Persistence ownership

DeepAgents owns correctness while the sandbox exists. The caller owns sandbox
durability.

If state must survive disposal, the caller supplies a persistent volume, bind
mount, or backend-specific persistence mechanism. The plan system documents
this requirement but does not manage sandbox lifecycle.

### Phase exit criteria

- One storage and mutation boundary works across supported sandboxes.
- The agent cannot bypass validation.
- DAG and revision invariants are enforced atomically.
- Recitation receives a compact storage-independent projection.
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
validated plan state is initialized
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
        ├── revise/replace ──► validated plan mutation ──► continue
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
6. Confirm that the agent records a revision through the validated state
   boundary before continuing.
7. Confirm that dependency readiness reflects the revised DAG.
8. Confirm that completion is refused without success-criteria evidence.
9. Confirm that volume-backed state can be resumed while ephemeral state
   follows the sandbox lifecycle selected by the caller.

### Phase exit criteria

- The full flow works through public APIs.
- Recitation reliably redirects attention after the defined evidence cadence.
- Replanning is evidence-driven and durable.
- DAG invariants remain valid throughout execution.
- Completion is evidence-backed.

## Decisions

- Build one proper solution in phases, not multiple disposable versions.
- Keep recitation separate from storage representation.
- Use the existing steer reminder as the recitation mechanism.
- Use completed tool calls as the current review cadence.
- Keep planning intelligence in stable instructions, not the recurring
  reminder.
- Infer plan fields from the request, workspace, and evidence.
- Store `blockedBy` canonically and derive `blocks`.
- Do not allow direct model edits to authoritative plan state.
- Do not use the virtual-Bash-only subcommand mechanism as the universal
  mutation interface.
- Make sandbox durability the caller's responsibility.

## Open questions

- What portable validated mutation boundary should authoritative plan state
  use?
- How should a review receive evidence gathered since the previous review
  without coupling recitation to transcript parsing?
- Should all completed tools count toward cadence, or should plan-maintenance
  operations be excluded?
- How should multiple agents share and revise one plan without losing updates?
- What is the smallest compact plan projection that still supports a sound
  review decision?

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
