<!-- slide 1: why do we call them "evals" -->
<!-- slide 2: evals is another type of test along the current ones -->
<!-- slide 3: traditional tests verify deterministic outputs wheres evals focuses on the model behavior across a spectrum -->
<!-- slide 4: show examples of each (evals requires grading logic.) -->
<!-- slide 6: how we measure success -->

# Why Evals?

Working with LLMs creates a feedback loop that's fundamentally different from traditional software.

Consider a simple example: I add a button to an admin panel that fetches a list of orders. The flow is predictable. User clicks, API responds, data displays. The user can't stray from this path.

With LLMs, everything changes. Users can say anything. They can ask the same question ten times and get ten different responses. The model is non-deterministic by nature. The worse is that they can ask anything, not just what you expected.

This raises a challenge: how do you ensure the model behaves as expected across many inputs, edge cases, and over time as you iterate?

A new model drops with better pricing. A new prompting technique claims to boost performance. You want to try them. But how do you know if these changes actually improve your agent, or quietly break what was already working?

Let's take a real scenario from my work building a text2sql agent.

## The Problem: Prompt Sensitivity

While building the text2sql agent, I discovered that simple prompt changes drastically affected output quality, sometimes for better, sometimes for worse.

### Example: Window Functions

- **Initial prompt**: "make use of window functions"
- **Result**: The model used window functions everywhere, even when unnecessary
- **Fixed prompt**: "use window functions only when user mentions rank, trend, or similar analytical operations"
- **Result**: The model now behaved appropriately

## The Multi-Model Challenge

I use two models in development:

- **Local**: `qwen/qwen3-4b-2507` (non-reasoning)
- **Cloud**: `openai/gpt-oss-20b` via Groq (reasoning)

Both super fast, but with different capabilities: one reason and the other doesn't.

Switching between them revealed inconsistent behavior, so I kept working with openai oss 20b till it was "good enough" and then I thought it is time to make sure it works on the other one, I also needed guarantees that future prompt changes won't break existing behavior.

1. **Cross-model consistency**: It works the same on both models.
2. **Regression prevention**: Prompt or logic changes don't degrade performance.

## The Ambiguity Problem

But here's the catch: even my "fixed" prompt has a hidden issue.

I wrote: _"use window functions when user mentions rank, trend, or **similar analytical operations**"_

The phrase "similar analytical operations" is vague. It gives the model interpretive freedom. What counts as "similar"? The model decided that "moving average" qualifies. Is that correct? Maybe. Maybe not.

**This is exactly what evals help answer.** They let you systematically test whether the model's interpretation matches your intent: across many examples, across multiple models, and over time as you iterate on prompts.

# What are Evals?

Evals are used to evaluate the performance of models, agents, or applications built on top of them. It is different from traditional testing (unit, integration, e2e) in that it focuses on evaluating the output quality of the model or application rather than just correctness.

- Traditional software tests verify that code produces deterministic, expected outputs (pass/fail).
- Evals on the other hand assess probabilistic systems where outputs can vary and there may not be a single "correct" answer; they measure quality, capability, and behavior across a spectrum.

In traditional software, tests are often binary: either the output is correct or it isn't. However, with models, outputs can be more subjective and nuanced. Evals help capture this complexity by allowing for graded assessments, human reviews, and other qualitative measures.

> For example, a translation eval might score outputs on a spectrum: 0.3 (wrong meaning), 0.6 (correct but awkward), 0.85 (natural and accurate), 1.0 (perfect). A binary test would only tell you "pass" or "fail".

## Autonomy of Evals

- Evaluation suite: is a collection of tasks designed to measure specific capabilities or behaviors.
- Task: is a specific scenario or prompt designed to **elicit** a particular behavior from the model. Each task has defined inputs, expected outputs, and evaluation criteria.
- Trial: An attempt of running a task. Multiple trials can be run for a task to gather more data and ensure reliability.
- Grader: The logic or mechanism used to assess the model's output against the expected output and criteria. Graders can be automated (using another model) or manual (human review).
- Transcript: Is the complete record of a trial, including outputs, tool calls, reasoning, intermediate results, and any other interactions. i.e the message history of an agent during a trial.

> Task is ran multiple times because the model output can vary each time due to its probabilistic nature so running multiple trials helps get a more accurate assessment of performance.

```ts
suite('Translation Eval Suite', () => {
  test({
    report: 'French Translation Task',
    trials: 5,
    data: [
      {
        input: 'Translate "Hello, world!" to French.',
        expected: 'Bonjour le monde!',
        models: [groq('openai/gpt-oss-20b'), lmstudio('qwen/qwen3-4b-2507')],
      },
    ],
    task: (prompt, model) => generateText({ model, prompt }),
    graders: [
      (output, expected) => exactMatch(output, expected),
      (output, expected) => levenshtein(output, expected),
      (output, expected) => answerSimilarity(output, expected),
    ],
  });
});
```

Notice we pass multiple graders here. Different graders capture different aspects of quality:

- **Exact match**: Checks if the output is identical to the expected result.
- **Levenshtein distance**: Measures how close the output is, even if wording differs slightly.
- **Answer similarity**: Uses embeddings to measure semantic equivalence. "Paris is the capital of France" and "The capital of France is Paris" would score high even though the wording differs.

By combining graders, we evaluate from multiple angles. Each grader can have its own threshold, and together they determine what counts as passing.

## Graders (aka Scorers)

> Different frameworks use different names: OpenAI calls them "graders", Evalite calls them "scorers", LangSmith calls them "evaluators". They all do the same thing: assess the model's output and return a score.

### Deterministic Scorers

Predictable, fast, and don't require API calls. Same input always produces the same score.

| Scorer             | Description                                                 |
| ------------------ | ----------------------------------------------------------- |
| `exactMatch`       | Exact string comparison                                     |
| `contains`         | Checks if output contains expected substring                |
| `levenshtein`      | Fuzzy matching using edit distance                          |
| `toolCallAccuracy` | Checks if correct tools were called with correct parameters |

### AI-based Scorers

Require AI models (LLMs or embeddings). More flexible but slower and costlier.

| Scorer              | Description                                                 |
| ------------------- | ----------------------------------------------------------- |
| `answerSimilarity`  | Semantic similarity using embeddings                        |
| `answerCorrectness` | Combines factual accuracy with semantic similarity          |
| `answerRelevancy`   | Did the AI actually answer the question?                    |
| `faithfulness`      | Detects hallucinations by checking against provided context |
| `contextRecall`     | Did the retrieval system find the right documents?          |
| `noiseSensitivity`  | Does irrelevant context confuse the model?                  |

> **Note**: LLM-as-judge introduces its own biases. The judge model may prefer verbose answers, favor certain phrasing, or have blind spots. Consider:
>
> - Using a stronger model as judge than the one being evaluated
> - Running multiple judge models and averaging scores
> - Calibrating with human-labeled examples first

## Establishing a Baseline

Before iterating on prompts or swapping models, you need a reference point to measure against. This is your **baseline** - a snapshot of your agent's current performance.

**Why baselines matter:**

1. **Before/after comparison**: Without a baseline, you can't tell if changes improve or degrade performance
2. **Regression detection**: Catch when "improvements" in one area break another
3. **Model comparison**: Objectively compare performance across different models

**Creating your baseline:**

1. Define your agent's goals (what should it do well?)
2. Build an initial eval suite covering those goals
3. Run evals and record scores - this is your baseline
4. Document specific failures or missing context for targeted improvement

**Iterating against the baseline:**

- Make **small, isolated changes** (one prompt tweak, one tool addition)
- Re-run evals after each change
- Compare to baseline: improved? regressed? no change?
- If improved, this becomes your new baseline

> **Tip**: Version your prompts and eval results together. When something breaks, you can trace back to exactly which change caused the regression.

## The Dataset

The most challenging part of evaluating agents is creating a good dataset. There's been a lot of progress in synthetic data generation using LLMs, which helps, but it still requires careful curation.

**Seed Data Sources**

1. **Stakeholder input**: Talk to users and domain experts to understand key use cases and edge cases.
2. **Real interactions**: Collect prompts from actual usage.
   - From your team while testing
   - From beta users
   - From production logs
3. **Reasoning traces**: Capture chain-of-thought outputs from reasoning models (o1, o3, etc.) as examples.
4. **Agent-to-agent conversations**: Build an agent that simulates user behavior to generate diverse prompts.
5. **Synthetic generation**: Use LLMs to generate prompts, then human-review and curate.

**Data Augmentation**

Once you have seed prompts, expand them:

1. **Paraphrasing**: Same intent, different wording.
   - "Show me all orders" → "List every order" → "Get the orders" → "What orders do we have?"

2. **Back-translation**: Translate to another language and back.
   - "Show top customers" → (Spanish) "Mostrar mejores clientes" → "Display the best clients"

3. **Noise injection**: Add typos, abbreviations, or informal phrasing.
   - "Show me the ordres from last mnth" (typos)
   - "Get me sales numbers for q4" (informal)

**Coverage Strategy (Evol-Instruct)**

Microsoft's Evol-Instruct paper describes two dimensions for dataset coverage:

- **Breadth**: Cover different tables and domains.
  - Orders, customers, products, inventory, employees, shipping, returns...

- **Depth**: For one domain, increase complexity progressively.
  - Simple: "How many orders do we have?"
  - Medium: "Show orders by month for 2024"
  - Complex: "Show month-over-month growth rate with running total"
  - Expert: "Rank customers by revenue, show their percentile, and flag those above the 90th percentile"

The goal is a dataset that reflects real-world diversity while targeting specific behaviors you want to evaluate.

Your evals should answer questions like:

- How well does the model handle ambiguous prompts?
- Does it maintain consistency across different contexts?
- How does it perform on edge cases or rare scenarios?

## Start Big, Then Shrink

A tip I picked up from the OpenAI forum: build your agent with the best model first.

1. **Develop with a strong model** until your evals score well.
2. **Run the same evals on smaller models** to see if they can match.
3. **Observe where they fall short** and tweak prompts or logic to close the gap.

Why this order matters: it gives you a focused set of failures to fix. You're only debugging the cases where the small model fails but the large one passes.

If you build on a small model first and then port to a larger one, you lose this insight. The small model would have failed on far more cases, making it harder to isolate what actually needs fixing.

## Conclusion

- Shifting mindset from traditional testing to evaluation when working with AI models and agents.
- Evals focus on measuring quality, capability, and behavior across a spectrum rather than binary correctness.
- Structure evals with suites, tasks, trials, graders, and transcripts to capture complexity.
