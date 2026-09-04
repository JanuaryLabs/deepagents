# AWS Strands Arbiter pattern: architecture distillation

**Research date:** 2026-09-02

**Article:** [Multi Agent Collaboration with Strands](https://aws.amazon.com/blogs/devops/multi-agent-collaboration-with-strands/) (AWS DevOps & Developer Productivity Blog, 2025-09-25)

**Sample source examined:** [`aws-samples/sample-multi-agent-collaboration-with-strands`](https://github.com/aws-samples/sample-multi-agent-collaboration-with-strands/tree/0387062e8f0c8617e3b36e3028a542264b2f330a) at `0387062e8f0c8617e3b36e3028a542264b2f330a`

**DeepAgents source examined:** local working tree based on `51d18d87e73c45e4ea8e9e5de78134c2f95e5dd2`; Zukhruf references refreshed against the 2026-09-04 Phase 1 working tree

## Conclusion

The article's reusable idea is a **durable, event-driven tool loop**:

1. represent every worker capability as a model-readable tool manifest;
2. let a coordinator model plan and emit one or more tool calls;
3. turn those calls into durable asynchronous jobs;
4. correlate completions with the original tool-call IDs;
5. append all results back to the coordinator conversation and let it plan the
   next wave;
6. if no capability exists, create and register a new one, then run the loop
   again. [1][2][3]

The sample calls this an **Arbiter** with a semantic **blackboard**, but the
implementation is more conventional and more centralized than those names
suggest. Workers do not opportunistically read and write shared hypotheses.
They receive commands through SQS and report completions through EventBridge;
the Arbiter alone reads the capability registry, owns the conversation, waits
at a DynamoDB fan-in barrier, and decides the next step. The closest thing to a
blackboard is therefore a workflow record, not a collaborative shared-memory
substrate. [3][4]

Strands is also a narrower part of the system than the title suggests. It
provides the local agent loops and tools inside the fixed workers and the
Fabricator. The Arbiter itself calls Amazon Bedrock's `converse` API directly,
while Lambda, SQS, EventBridge, DynamoDB, and S3 implement distribution,
durability, routing, and code loading. None of Strands' native Graph, Swarm, or
session-management facilities are used. [3][5][8][9]

For DeepAgents, the useful lesson is **host-owned durable coordination around
independent agent turns**. Zukhruf already has the stronger foundation:
declared subagents, durable conversations, a turn queue, mailbox delivery,
stable identities, and automatic terminal-result projection. It should not
copy runtime code fabrication or add a global blackboard. The first-class
`AgentPluginInstance.agents` directory seam is the right level of dynamism
until a real customer workload proves that live capability mutation is
necessary. [15][16]

## The pattern in one picture

```text
incoming event
    |
    v
EventBridge -> Arbiter Lambda -> Bedrock Converse + capability manifests
                                      |
                                      | 0..N tool calls
                                      v
                          SQS worker/fabricator queues
                              |                 |
                       Strands worker     Strands Fabricator
                              |          code -> S3
                              |      manifest -> DynamoDB
                              +-------- completion --------+
                                                       |
                                                       v
                              EventBridge -> DynamoDB fan-in barrier
                                                       |
                                           all calls complete?
                                                       |
                                                       v
                                      append tool results to conversation
                                      and invoke the Arbiter again
```

This is a distributed form of the ordinary agent loop. A normal harness runs a
tool, appends its result, and samples the model again in one process. The
article externalizes the tool execution and the pause between model calls so a
wave can outlive any one process. Strands documents the same inner loop—model
tool request, validated execution, tool-result message, next model call—for an
individual agent. [9]

## Exact execution semantics

### 1. Capability discovery and planning

The capability registry stores one record per tool/agent. The model-visible
contract is effectively:

```ts
type Capability = {
  name: string;
  description: string;
  schema: JSONSchema;
  action: { type: 'sqs'; target: string };
  filename?: string; // fabricated workers
};
```

On every Arbiter step, the sample scans the DynamoDB table, converts every
record into a Bedrock tool specification, and supplies the complete list to
`bedrock.converse`. There is no embedding index, peer-manifest protocol, or
separate semantic retrieval stage in the source. “Semantic capability
matching” means that the coordinator model reads all tool descriptions and
chooses among them. The scan is not paginated. [4]

The model may return several tool calls. The Arbiter iterates through them and
sends one SQS message per call. Dispatch is sequential in the Lambda code, but
the queue consumers can execute the jobs concurrently. [3]

### 2. Command and completion protocol

The command envelope is small and worth preserving:

```json
{
  "orchestration_id": "conversation/workflow correlation",
  "tool_use_id": "the model tool call being answered",
  "node": "capability name",
  "tool_input": {}
}
```

Completion carries the same correlation fields plus `data`. This is the key
protocol boundary: infrastructure routes on `node`, while the coordinator
conversation reconnects a result to the exact model call through
`tool_use_id`. The Generic Wrapper owns completion publication for fabricated
workers, keeping generated code unaware of EventBridge. Fixed workers do not
follow that rule consistently; their model must call a worker-specific
completion tool such as `deliver_meal`. [3][6][8]

### 3. Fan-out, fan-in, and continuation

For each wave, the Arbiter creates a DynamoDB record whose dynamic fields are
capability names set to `false`, with a sibling `data` map. Each completion
updates the corresponding field to `true`. When no `false` fields remain, the
Arbiter converts the accumulated data to Bedrock `toolResult` blocks, appends
one user message to the stored conversation, and invokes itself again. The
loop ends when Bedrock returns text without tool calls; the sample saves that
message in the orchestration record. [3]

This makes the synchronization policy a strict **wave barrier**. Early results
are persisted but are not shown to the Arbiter until every call in that wave
has completed. The model cannot react incrementally, cancel now-irrelevant
siblings, or let one worker build on another worker's partial result.

### 4. Just-in-time capability creation

The Fabricator is a Strands agent with `file_write`, `http_request`, `shell`,
S3 upload, DynamoDB registration, and completion tools. Its prompt asks the
model to write a Python module exposing a `handler`, upload the module to S3,
and register its schema, description, filename, and generic-queue route in
DynamoDB. It explicitly says not to write tests, and tool consent is bypassed
for the process. [5]

The Fabricator's completion is returned to the Arbiter as an ordinary tool
result. On the next Arbiter step the capability table is scanned again, so the
new manifest becomes another available tool. A Generic Wrapper later loads
the manifest, downloads the S3 object to `/tmp/loaded_module.py`, imports it,
and invokes `handler(**tool_input)`. [4][5][6]

This is not “spawning an agent” in the sense of starting a durable child
conversation. It is **publishing executable code plus a tool manifest**, then
hot-loading that code for future jobs.

## State and memory

| State                    | Store in the sample           | Meaning                                                           |
| ------------------------ | ----------------------------- | ----------------------------------------------------------------- |
| Arbiter conversation     | DynamoDB orchestration table  | Bedrock messages across planning waves                            |
| Current fan-in barrier   | DynamoDB workflow-state table | Which capability names have completed and their latest result     |
| Capability catalog       | DynamoDB tool-config table    | Tool name, description, schema, route, and optional code filename |
| Generated implementation | S3                            | Python source loaded by the Generic Wrapper                       |
| Worker queue             | SQS                           | Durable pending execution request                                 |
| Completion notification  | EventBridge                   | Event delivery to the Arbiter; not itself the source of truth     |
| Strands worker history   | Process memory only           | One worker invocation; no Strands session manager is configured   |

The article accurately calls DynamoDB workflow state “short-term memory,” but
it also describes reflection, performance-informed adaptation, and retirement
of underperforming agents. No performance store, evaluator, adaptation rule,
or deprecation path exists in the sample source. Generated code and its
manifest persist; learning from execution quality does not. [1][2][5]

Current Strands releases can persist agent and multi-agent sessions, including
orchestrator state, shared context, and node-transition history. That is a
framework capability, not a mechanism demonstrated by this sample. The
official documentation also cautions that multi-agent session persistence
tracks the Graph/Swarm execution, not each child agent's individual
conversation history. [11]

## Prior art and established patterns

**Clearest conclusion:** the AWS design composes established ideas, but neither
the article's **Arbiter pattern** nor its complete **Fabricator pattern** is an
established multi-agent standard or canonical pattern name. The article
introduces “Arbiter” as the name for its composition and cites no prior
definition of that pattern. A search of the primary literature and standards
below found established names for its parts, not for the combination. The
older terms _Agent Factory_ and _Agent Fabricator_ also show that the
fabrication role name predates this article; what is new here is the particular
LLM-driven generate → register manifest → hot-load pipeline. [1][25][26]

| Established lineage                     | What the primary source defines                                                                                                                                                                                                                 | Relationship to the AWS sample                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Blackboard coordination                 | HEARSAY-II and Hayes-Roth describe independent knowledge sources that read and modify shared hypotheses/partial solutions, with opportunistic activation and control. [20][21]                                                                  | The sample has centralized fan-out/fan-in and durable workflow/config records. Its DynamoDB tables are not a shared hypothesis space on which workers collaborate, so “blackboard” is an analogy rather than the implemented coordination protocol. |
| Capability registry / service discovery | FIPA's Directory Facilitator is a standardized yellow-pages service through which agents register service descriptions and search for agents that provide them. [22]                                                                            | The capability-manifest table is recognizable directory/service-discovery prior art. FIPA does not specify generating implementation code or dynamically loading it.                                                                                |
| Contract Net / task allocation          | Smith's Contract Net and the FIPA interaction protocol allocate tasks through announcements or calls for proposals, bids, acceptance/rejection, and result reporting. [23][24]                                                                  | The sample does not run a bidding or award protocol. The model selects a declared tool—or asks the Fabricator to create one—then the host dispatches it. That is routing/delegation, not Contract Net allocation.                                   |
| Agent factories and fabricators         | Earlier agent systems used _Agent Factory_ for automated construction from reusable components and capability descriptions; the PABADIS project explicitly implemented an _Agent Fabricator_ that generated agents. [25][26]                    | These are direct precedents for dynamic agent construction and for the role's name, but they do not establish a general “Fabricator pattern” matching the sample's LLM-written Python, DynamoDB manifest, S3 artifact, and in-process loader.       |
| LLM tool and skill creation             | CREATOR has an LLM design and implement executable tools; LATM separates tool making from tool use and caches created tools as reusable APIs; Voyager grows a retrievable library of executable skills using environment feedback. [27][28][29] | This is the closest technical family for the Fabricator. The AWS sample adds a distributed registry and runtime loader, but omits the evaluation, repair, or promotion gates needed to turn generation into a reliable capability lifecycle.        |

Accordingly, use **Arbiter** as this article's local architectural label, not
as a term readers can be expected to know from multi-agent literature. Use
**Fabricator** as an implementation role whose ingredients have substantial
prior art, not as a standardized protocol.

## What is generic, Strands-specific, and AWS-specific

| Concern                | Generic architecture                                                 | Binding in the sample                          |
| ---------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| Planning and routing   | Model sees typed capability manifests and emits tool calls           | Raw Bedrock `converse` in the Arbiter          |
| Worker cognition       | Agent loop around a model and tools                                  | Strands `Agent`, `@tool`, and `BedrockModel`   |
| Asynchronous execution | Durable job queue and independently scaled workers                   | SQS-triggered Lambda functions                 |
| Completion transport   | Correlated terminal event                                            | EventBridge `task.completion` event            |
| Workflow state         | Durable conversation plus fan-in state machine                       | Two DynamoDB tables                            |
| Capability registry    | Name, description, input schema, execution address, artifact version | DynamoDB record and SQS URL                    |
| Executable artifact    | Versioned worker implementation                                      | Unversioned Python file in S3                  |
| Dynamic loading        | Trusted runner resolves and executes the artifact                    | Python `importlib` in a Generic Wrapper Lambda |

The pattern does not require AWS or Strands. Kafka, a database-backed queue,
or an actor runtime could carry commands; a transactional database could own
state; containers or WASM could execute workers; any model tool-call protocol
could plan. Strands contributes a convenient local agent/tool harness, but the
distributed protocol belongs to the application. Strands itself already
offers different built-in multi-agent patterns—deterministic Graphs,
autonomous Swarms, and agents-as-tools—which should not be conflated with this
custom Arbiter architecture. [10]

## Failure modes the article underplays

The sample is useful as a pattern demonstration, not as a production reference
implementation.

| Failure                                  | Current behavior                                                                                                                                                                                                                                                                        | Required production invariant                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Completion wins a setup race             | The Arbiter sends SQS jobs **before** creating the workflow barrier and saving the orchestration. A fast completion can arrive while its records do not exist; the handler catches a missing orchestration and returns successfully, losing that completion. [3]                        | Persist workflow intent before dispatch; make dispatch recoverable through an outbox/reconciler.                                           |
| Duplicate delivery                       | Standard SQS and Lambda event-source mappings are at-least-once; EventBridge can also invoke a target more than once. The completion update is unconditional, and a duplicate arriving after all flags are true can re-invoke the Arbiter again. [3][12][13]                            | Give every attempt and completion a stable idempotency key; condition the transition on `pending`; make continuation single-winner.        |
| Same capability called twice in one wave | Barrier fields are keyed by `node`/tool name, not `tool_use_id`. Two calls to the same worker collapse into one Boolean and one data slot, causing premature continuation and result overwrite. [3]                                                                                     | Key fan-out state by invocation ID, with capability name as metadata.                                                                      |
| One record in an SQS batch fails         | Handlers iterate a batch and return no partial-batch response. By default, one exception retries already processed records too. No source-queue DLQ is configured in the CDK. [6][7][12]                                                                                                | Idempotent handlers, partial-batch failure reporting, bounded retries, and a DLQ/replay path.                                              |
| Worker cannot load code/config           | Generic Wrapper failures before the `try`—DynamoDB lookup, S3 download, and Python import—emit no completion and rely on SQS retry. [6]                                                                                                                                                 | Terminal failure after retry exhaustion must be projected into workflow state.                                                             |
| Worker logic throws                      | Exceptions from the fabricated `handler` are converted to “please ignore for now” and published as successful completion. [6]                                                                                                                                                           | Separate transport completion from semantic status: `succeeded`, `failed`, `cancelled`, `timed_out`.                                       |
| Model ends without signaling             | Fixed workers and the Fabricator depend on the model calling `deliver_meal`/`complete_task`. A normal model end without that tool makes the Lambda succeed but leaves the workflow waiting forever. [5][8]                                                                              | The host, not the model, must always emit one terminal result from the invocation outcome.                                                 |
| Capability catalog grows                 | A non-paginated DynamoDB scan is inserted wholesale into every model request. DynamoDB scans cap one response at 1 MB, and model context/cost grows with every capability. [4]                                                                                                          | Paginate storage and retrieve a bounded candidate set before model selection.                                                              |
| Generated code is unsafe or incompatible | The Fabricator has shell, HTTP, file-write, broad Bedrock access, no validation gate, no artifact signature, and no test. The Generic Wrapper imports generated Python in-process with its Lambda role. Strands warns that tools run with the host process's permissions. [5][6][7][10] | Generate in a restricted build sandbox; validate and test; approve/promote; sign and version; execute with per-capability least privilege. |
| Workflow never converges                 | There is no workflow deadline, maximum planning-wave count, cancellation protocol, stuck-job reconciler, or explicit retry/attempt model.                                                                                                                                               | Persist deadlines and attempts; define cancellation, timeout, retry, and terminal aggregation semantics.                                   |
| Concurrent updates conflict semantically | DynamoDB `UpdateItem` is atomic, but the sample does not use a condition or version. Atomic writes alone do not make the read/decide/reinvoke sequence single-winner. AWS recommends conditional writes or transactions when conflicts matter. [3][14]                                  | Use conditional transitions or a transaction around the state-machine decision.                                                            |

The article's claim that the wrapper “maintains execution isolation” should be
read narrowly as Lambda invocation/container isolation. The wrapper directly
imports arbitrary generated code into its own interpreter. It is not a
language sandbox or a security boundary. [6][10]

## Implications for DeepAgents

### What Zukhruf already has

The Arbiter's durable coordination goal maps to Zukhruf more closely than to
the legacy in-process `@deepagents/agent` swarm:

- `defineAgent` provides stable, typed declaration identity and explicit
  permitted subagents. [15]
- `AgentPluginInstance.agents` discovers and validates Markdown specialist
  declarations, then composes them into the root declaration at startup. This
  is already a safe capability-catalog boundary: code owns executable
  dependencies; Markdown owns identity, description, and instructions. [16]
- `AgentRuntime.spawn` creates an independent child conversation, forks the
  requested parent history, enqueues a durable first turn, and returns before
  execution. [17]
- `MailboxCoordinator` durably stores inter-agent messages before scheduling a
  wake, while queue-only mail and trigger-turn mail retain distinct semantics.
  [18]
- Terminal child state is projected by the host as idempotent `FINAL_ANSWER`
  mail rather than relying on a child model to remember a completion tool.
  The existing durable-turns and research-bot demos exercise this model. [19]

That is already the important part of the article: durable, correlated,
asynchronous cooperation with an external source of truth.

### What to borrow

1. **Keep capabilities model-readable.** The current declaration `name` and
   `description` are the equivalent of the article's tool manifest. If the
   catalog becomes too large, add bounded capability retrieval before adding
   more kinds of orchestration.
2. **Keep planning waves explicit when a barrier is genuinely required.** A
   parent can spawn independent children, wait for specific terminal mail, and
   synthesize. Represent each child turn by its durable turn identity, never
   only by agent name.
3. **Preserve the command envelope's correlation.** Conversation, parent,
   child, turn, attempt, and originating tool-call IDs should remain distinct
   wherever their cardinalities differ.
4. **Treat terminal projection as runtime policy.** Zukhruf already does this;
   do not move completion signaling into agent prompts.
5. **Keep state typed by purpose.** Conversation history, queue state, mailbox
   mail, agent declarations, and executable artifacts have different
   lifetimes. Do not collapse them into a vaguely named blackboard.

### What not to copy

- **Do not add a global blackboard now.** Mailboxes plus durable conversation
  and turn state cover the demonstrated coordination. Add shared artifact state
  only when agents need concurrent, queryable collaboration that messages
  cannot express cleanly.
- **Do not fabricate and hot-load production code.**
  `AgentPluginInstance.agents` gives DeepAgents dynamic specialist
  configuration without turning model output into trusted executable code. If
  live fabrication becomes a proven product requirement, make it an
  approval-based software delivery pipeline, not a tool-call shortcut.
- **Do not scan every capability into every prompt.** Preserve the explicit
  declaration graph for ordinary systems; introduce indexed retrieval only
  after catalog size makes it necessary.
- **Do not build Strands-shaped abstractions.** The durable protocol is generic,
  and Zukhruf already owns its runtime boundaries. Strands' `Agent`, Graph, and
  Swarm APIs are implementation choices, not missing DeepAgents domain types.

## Sources

1. [AWS article: Multi Agent Collaboration with Strands](https://aws.amazon.com/blogs/devops/multi-agent-collaboration-with-strands/)
2. [AWS sample README at the examined commit](https://github.com/aws-samples/sample-multi-agent-collaboration-with-strands/blob/0387062e8f0c8617e3b36e3028a542264b2f330a/README.md)
3. [AWS sample Arbiter/orchestrator source](https://github.com/aws-samples/sample-multi-agent-collaboration-with-strands/blob/0387062e8f0c8617e3b36e3028a542264b2f330a/src/orchestrator/index.py#L29-L235)
4. [AWS sample capability-table adapter](https://github.com/aws-samples/sample-multi-agent-collaboration-with-strands/blob/0387062e8f0c8617e3b36e3028a542264b2f330a/src/orchestrator/tool_config.py#L23-L42)
5. [AWS sample Fabricator source](https://github.com/aws-samples/sample-multi-agent-collaboration-with-strands/blob/0387062e8f0c8617e3b36e3028a542264b2f330a/src/fabricator/index.py#L9-L255)
6. [AWS sample Generic Wrapper source](https://github.com/aws-samples/sample-multi-agent-collaboration-with-strands/blob/0387062e8f0c8617e3b36e3028a542264b2f330a/src/generic-agent-wrapper/index.py#L11-L91)
7. [AWS sample CDK orchestration stack](https://github.com/aws-samples/sample-multi-agent-collaboration-with-strands/blob/0387062e8f0c8617e3b36e3028a542264b2f330a/infra/lib/orchestrator-stack.ts#L21-L160)
8. [AWS sample fixed Strands worker](https://github.com/aws-samples/sample-multi-agent-collaboration-with-strands/blob/0387062e8f0c8617e3b36e3028a542264b2f330a/src/agents/burger-cook/index.py#L49-L101)
9. [Strands Agent Loop documentation](https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/)
10. [Strands Tools documentation and security boundary](https://strandsagents.com/docs/user-guide/concepts/tools/)
11. [Strands Session Management documentation](https://strandsagents.com/docs/user-guide/concepts/agents/session-management/)
12. [AWS Lambda: Using Lambda with Amazon SQS](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html)
13. [AWS EventBridge troubleshooting: duplicate target invocation](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-troubleshooting.html#eb-rule-triggered-more-than-once)
14. [AWS DynamoDB concurrent-update guidance](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/BestPractices_ImplementingVersionControl.html)
15. [DeepAgents Zukhruf declaration API](../../packages/experimental/src/zukhruf/agent.ts)
16. [DeepAgents plugin-agent loader](../../packages/experimental/src/zukhruf/runtime/plugin/plugin-agents.ts)
17. [DeepAgents agent control plane](../../packages/experimental/src/zukhruf/control-plane/agent-control-plane.ts)
18. [DeepAgents mailbox coordinator](../../packages/experimental/src/zukhruf/mailbox/coordinator.ts)
19. [DeepAgents durable-turns demo](../../demo/zukhruf-durable-turns/README.md) and [research-bot demo](../../demo/zukhruf-research-bot/README.md)
20. Barbara Hayes-Roth, [“A Blackboard Architecture for Control”](https://www.sciencedirect.com/science/article/pii/0004370285900633), _Artificial Intelligence_ 26(3), 1985.
21. Lee D. Erman et al., [“The HEARSAY-II Speech-Understanding System: Integrating Knowledge to Resolve Uncertainty”](https://mas.cs.umass.edu/Documents/Erman_Hearsay80.pdf), _ACM Computing Surveys_ 12(2), 1980.
22. Foundation for Intelligent Physical Agents, [FIPA Agent Management Specification](https://www.fipa.org/specs/fipa00023/SC00023J.html), specification SC00023J, 2002.
23. Reid G. Smith, [“The Contract Net Protocol: High-Level Communication and Control in a Distributed Problem Solver”](https://cse-robotics.engr.tamu.edu/dshell/cs631/papers/smith80contract.pdf), _IEEE Transactions on Computers_ C-29(12), 1980.
24. Foundation for Intelligent Physical Agents, [FIPA Contract Net Interaction Protocol Specification](https://www.fipa.org/specs/fipa00029/SC00029H.html), specification SC00029H, 2002.
25. Niek J. E. Wijngaards et al., [“Agent Factory: Generative Migration of Mobile Agents in Heterogeneous Environments”](https://www.njewijngaards.dds.nl/pubs/aims_sac2002.pdf), _ACM Symposium on Applied Computing_, 2002.
26. PABADIS consortium, [project report describing the Agent Fabricator](https://www.ims.org/wp-content/uploads/2024/03/8d0a75_44b7e1e097d5424a8d29f53051d8718f.pdf), 2004.
27. Cheng Qian et al., [“CREATOR: Tool Creation for Disentangling Abstract and Concrete Reasoning of Large Language Models”](https://aclanthology.org/2023.findings-emnlp.462/), _Findings of EMNLP_, 2023.
28. Tianle Cai et al., [“Large Language Models as Tool Makers”](https://openreview.net/pdf?id=qV83K9d5WB), _ICLR_, 2024.
29. Guanzhi Wang et al., [“Voyager: An Open-Ended Embodied Agent with Large Language Models”](https://arxiv.org/abs/2305.16291), 2023.
