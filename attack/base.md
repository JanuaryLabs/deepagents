Your theory is valid, but the objective is slightly wrong.

**Do not train Drill to ask many questions. Train it to reduce decision-relevant uncertainty with the fewest possible questions.**

[
q^* =
\arg\max_q
\left(
\mathbb{E}_{a}[V(h \cup {q,a})]
-------------------------------

## V(h)

C(q)
\right)
]

Where:

* (h) is everything currently known.
* (q) is a possible question.
* (a) is the user’s possible answer.
* (V) is the expected quality of the eventual execution.
* (C(q)) is the cost of bothering the user.

Ask only when the expected improvement exceeds the interaction cost.

Recent research increasingly treats clarification this way: as a sequential policy that must decide **whether to ask, what to ask, and when to stop**, rather than merely generating plausible questions. ([arXiv][1])

## What Drill should actually be

```text
User request
    ↓
Inspect available context
    ↓
Generate materially different interpretations
    ↓
Find the unknown that separates those interpretations
    ↓
Inspect further OR ask one targeted question
    ↓
Repeat until another question is not worth its cost
    ↓
Produce TaskContract
    ↓
Planner / Executor
```

I disagree with “ask before starting.”

Drill should be allowed to perform **cheap, reversible investigation** first. A coding agent should inspect the repository instead of asking:

> What framework are you using?

It should ask the user only when the answer cannot be obtained from tools, files, memory, or environment.

The actual policy has three actions:

```ts
type DrillAction =
  | {
      type: "inspect";
      query: string;
      resolves: string[];
    }
  | {
      type: "ask";
      question: string;
      resolves: string[];
      decisionsAffected: string[];
    }
  | {
      type: "execute";
      contract: TaskContract;
    };
```

```ts
interface TaskContract {
  objective: string;
  scope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  assumptions: string[];
  unresolvedLowImpactDetails: string[];
}
```

This should sit inside Zukhruf as a controller before planning:

```text
                ┌─────────────┐
Request ───────►│    Drill    │
                └──────┬──────┘
                       │
                  TaskContract
                       │
                ┌──────▼──────┐
                │   Planner   │
                └──────┬──────┘
                       │
                ┌──────▼──────┐
                │  Executor   │
                └─────────────┘
```

## Define “principal scenario” precisely

A scenario is principal only when choosing it changes at least one of:

* The implementation or execution plan.
* An irreversible or risky action.
* The acceptance criteria.
* Material cost, latency, security, or user-visible behaviour.

Everything else is noise.

For example:

> Add CSV export to reports.

Possible branches:

```text
A. Export visible page only
B. Export every filtered row
C. Generate CSV in browser
D. Generate CSV on server
E. Include private/internal columns
F. Include only currently displayed columns
```

Drill inspects the repository and discovers that exports are already generated client-side. That eliminates C/D without speaking to the user.

The highest-impact remaining question might be:

> Should the CSV contain every row matching the current filters, or only the visible page?

That is Drill. Not:

> Please provide more information about what you want.

## How to build the first dataset

Start with one narrow domain. For you, I would use **software-change requests**, because execution can be verified using tests.

Create examples containing a fully specified hidden task:

```json
{
  "request": "Add CSV export to reports",
  "hiddenSpec": {
    "rowScope": "all_filtered_rows",
    "generation": "client",
    "maximumRows": 50000,
    "columns": "visible_columns",
    "preserveFilters": true
  },
  "criticalUnknowns": [
    {
      "key": "rowScope",
      "impact": "Changes data loading and memory requirements",
      "source": "user"
    }
  ],
  "inspectableFacts": [
    {
      "key": "generation",
      "source": "repository"
    }
  ],
  "acceptanceTests": [
    "Exports every filtered row",
    "Does not export hidden columns",
    "Preserves active filters"
  ]
}
```

Then produce an ambiguous version by masking one or more facts:

```json
{
  "request": "Add CSV export to reports"
}
```

The agent receives only the ambiguous request. The simulated user retains the complete hidden specification.

Its rollout becomes:

```text
inspect repository
→ discover client-side architecture
→ ask about row scope
→ receive "all filtered rows"
→ produce TaskContract
→ implement
→ run tests
```

## Do not fine-tune first

Build it as an explicit harness policy first.

Otherwise, when results improve or deteriorate, you will not know whether the cause was:

* The dataset.
* The clarification policy.
* The executor.
* The user simulator.
* The reward.
* General model degradation.

Use this progression:

### 1. Prompted baseline

Make the model output structured Drill actions.

The prompt should enforce:

```text
1. Identify interpretations that lead to materially different actions.
2. Eliminate interpretations using available tools and context.
3. Never ask for information obtainable through inspection.
4. Ask only the highest-impact unresolved question.
5. Stop when remaining uncertainty would not materially change execution.
6. Explicitly record assumptions before executing.
```

### 2. Supervised fine-tuning

Train on good trajectories:

```text
request
→ inspection
→ targeted question
→ answer
→ correct stopping point
→ TaskContract
```

Include many fully specified tasks where the correct behaviour is:

```json
{
  "type": "execute"
}
```

Without these examples, you will train an irritating agent that interrogates users even when nothing is missing.

### 3. Preference training

Construct positive/negative pairs:

```text
Preferred:
"Should exports include all filtered rows or only the visible page?"

Rejected:
"Could you provide more details about the export feature?"
```

Other useful pairs:

```text
inspect repository > ask user about repository fact

one discriminating question > five generic questions

execute after intent resolved > continue asking

clarify risky ambiguity > silently assume
```

### 4. Online RL or GRPO

Once the simulator and evaluator are trustworthy, optimize:

[
R =
S_{\text{task}}
---------------

## \lambda_q N_{\text{questions}}

## \lambda_r N_{\text{redundant}}

## \lambda_i N_{\text{inspectable questions}}

\lambda_p N_{\text{premature actions}}
]

Where (S_{\text{task}}) comes from tests, execution results, or a structured rubric.

Recent work has trained this behaviour with GRPO and simulated users. SpeakRL separates clarification from ordinary responses and trains both when and what to ask, although the authors explicitly note that their reward does not directly penalize excessive clarification. Your reward absolutely should. ([arXiv][2])

For tool-calling agents, structured uncertainty over tool parameters is especially relevant. One recent approach uses value-of-information reasoning to choose which parameter to clarify and reports better ambiguous-task coverage while asking substantially fewer questions. ([arXiv][3])

IntentRL applies essentially this idea before deep research: build possible latent intents, interact to narrow them, and then run the expensive research agent. It reports that clarification improved downstream alignment rather than merely making the dialogue look better. ([arXiv][4])

## Your strongest source of training data

Use your existing agent traces.

Search for moments where you later said things such as:

```text
"No, I meant..."
"That's not what I asked."
"Use the existing implementation."
"Don't change that."
"I thought this was obvious."
"Why did you assume..."
```

Each correction contains:

```text
hidden requirement
+ bad assumption
+ resulting wasted work
```

Transform it into:

```text
Ambiguous request:
Original user message

Hidden fact:
The information revealed by the later correction

Bad policy:
The agent's incorrect assumption or premature action

Better Drill action:
The question or inspection that would have prevented the failure
```

That dataset is more valuable than generic synthetic clarification conversations because it reflects **the actual ambiguity distribution of agents doing real work**.

## The first experiment

Take roughly 100 completed coding tasks from your traces.

For each task:

1. Recover the final, complete specification.
2. Mask one decision-critical requirement.
3. Mark whether the missing fact is inspectable or user-only.
4. Run the executor without Drill.
5. Run the same executor with prompted Drill.
6. Compare:

```text
task success
questions per task
unnecessary-question rate
questions answerable by tools
premature-execution rate
critical-constraint coverage
total tokens and tool calls
```

The hypothesis is not:

> Drill asks more questions.

It is:

> Drill achieves higher downstream success on underspecified tasks while minimizing user turns and avoiding questions answerable from the environment.

Build that benchmark first. Then the fine-tuning target becomes obvious rather than philosophical.

[1]: https://arxiv.org/html/2607.21143v2 "One More Turn, Less Regret:A Regret-Based Multi-Turn Benchmark for LLMs’ Clarification Policies"
[2]: https://arxiv.org/html/2512.13159v1 "SpeakRL: Synergizing Reasoning, Speaking, and Acting in Language Models with Reinforcement Learning"
[3]: https://arxiv.org/html/2511.08798v2 "Structured Uncertainty guided Clarification for LLM Agents"
[4]: https://arxiv.org/html/2602.03468v1 "IntentRL: Training Proactive User-intent Agents for Open-ended Deep Research via Reinforcement Learning"
