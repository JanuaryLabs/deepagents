---
title: Why Evals?
sub_title: From Traditional Testing to AI Evaluation
author: ezzabuzaid
theme:
  name: dark
---

<!-- font_size: 7 -->

# The Traditional World

<!-- column_layout: [1, 2] -->

<!-- column: 0 -->

**User clicks button**

↓

**API responds**

↓

**Data displays**

<!-- column: 1 -->

```ts
// Predictable. Deterministic.
app.get('/orders', async (req, res) => {
  const orders = await db.query('SELECT * FROM orders');
  res.json(orders);
});
```

<!-- reset_layout -->

<!-- pause -->

The user can't stray from this path.

<!--
speaker_note: |
  Emphasize: "This is comfortable. We know exactly what will happen."
-->

<!-- end_slide -->

# Then LLMs Happened

<!-- incremental_lists: true -->

- Users can say **anything**
- Same question, **10 different responses**
- Non-deterministic by nature

<!-- pause -->

**The worst part?**

They can ask things you never expected.

<!-- speaker_note: Let this sink in. This is the inciting incident. -->

<!-- end_slide -->

# The Challenge

> How do you ensure the model behaves as expected across many inputs, edge cases, and over time as you iterate?

<!-- pause -->

<!-- newlines: 2 -->

A new model drops with better pricing.

A new prompting technique claims to boost performance.

<!-- pause -->

**How do you know if these changes improve your agent... or quietly break what was working?**

<!-- speaker_note: Rhetorical questions build tension. Don't answer yet. -->

<!-- end_slide -->

# Let Me Show You What Happened

<!-- jump_to_middle -->

Building a **text2sql** agent

_A real scenario from my work_

<!--
speaker_note: |
  Transition: "Let me tell you a story about building text2sql..."
-->

<!-- end_slide -->

# The Prompt Sensitivity Problem

## Attempt 1

```
"Make use of window functions"
```

<!-- pause -->

**Result:** Window functions **everywhere**, even when unnecessary

<!-- pause -->

## Attempt 2

```
"Use window functions only when user mentions
rank, trend, or similar analytical operations"
```

<!-- pause -->

**Result:** Better! Model behaved appropriately...

<!-- speaker_note: "This seems like a win. But wait..." -->

<!-- end_slide -->

# The Multi-Model Challenge

<!-- column_layout: [1, 1] -->

<!-- column: 0 -->

## Local Dev

```
qwen/qwen3-4b-2507
```

- Fast
- Non-reasoning
- Different behavior

<!-- column: 1 -->

## Production

```
openai/gpt-oss-20b
```

- Fast
- Reasoning model
- Different behavior

<!-- reset_layout -->

<!-- pause -->

**Same prompt. Different results.**

<!-- speaker_note: "Both fast, but with completely different capabilities." -->

<!-- end_slide -->

# Cross-Model Chaos

Works on one model.

**Breaks on the other.**

<!-- pause -->

<!-- newlines: 2 -->

I needed two guarantees:

<!-- incremental_lists: true -->

1. **Cross-model consistency** — Works the same on both
2. **Regression prevention** — Changes don't degrade performance

<!-- speaker_note: "I kept working with the better model until 'good enough', then tried the other... disaster." -->

<!-- end_slide -->

# The Hidden Trap

Remember my "fixed" prompt?

```
"use window functions when user mentions
rank, trend, or similar analytical operations"
```

<!-- pause -->

<!-- newline -->

**"similar analytical operations"** — what does that even mean?

<!-- pause -->

The model decided **"moving average"** qualifies.

<!-- speaker_note: Pause here. Let them realize the problem. -->

<!-- end_slide -->

# Is That Correct?

<!-- jump_to_middle -->

Maybe.

<!-- pause -->

Maybe not.

<!-- pause -->

**How do we know?**

<!-- speaker_note: This is the low point of the story. Maximum tension. -->

<!-- end_slide -->

# The Breakthrough

<!-- jump_to_middle -->

<!-- pause -->

This is exactly what **evals** help answer.

<!-- speaker_note: The breakthrough moment. Say it slowly. -->

<!-- end_slide -->

# What Are Evals?

> Evals evaluate the performance of models, agents, or applications — **across a spectrum**, not just pass/fail.

<!-- pause -->

<!-- newlines: 2 -->

They measure:

<!-- incremental_lists: true -->

- **Quality** — How good is the output?
- **Capability** — Can it handle this type of task?
- **Behavior** — Does it act as intended?

<!-- speaker_note: "Evals are not tests. They're evaluations." -->

<!-- end_slide -->

# Evals vs Traditional Tests

<!-- column_layout: [1, 1] -->

<!-- column: 0 -->

## Traditional Tests

```
assert output === expected
// Pass or Fail
// Binary
```

Deterministic correctness

<!-- column: 1 -->

## Evals

```
score = grade(output, expected)
// 0.3 → wrong meaning
// 0.6 → correct but awkward
// 0.85 → natural, accurate
// 1.0 → perfect
```

Probabilistic quality

<!-- reset_layout -->

<!-- speaker_note: "A translation might be 'correct' but still awkward. Evals capture nuance." -->

<!-- end_slide -->

# Anatomy of Evals

```
┌─────────────────┐
│ Evaluation Suite│
└────────┬────────┘
         │
    ┌────┴────┬────────┐
    ▼         ▼        ▼
┌───────┐ ┌───────┐ ┌───────┐
│Task 1 │ │Task 2 │ │Task N │
└───┬───┘ └───────┘ └───────┘
    │
┌───┴───┬────────┐
▼       ▼        ▼
Trial 1 Trial 2  Trial N
    │
    ▼
┌─────────┐
│ Graders │
└────┬────┘
     ▼
┌─────────┐
│  Score  │
└─────────┘
```

<!-- pause -->

- **Suite**: Collection of tasks measuring specific capabilities
- **Task**: Scenario with inputs, expected outputs, criteria
- **Trial**: One attempt (run multiple for reliability)
- **Grader**: Logic to assess output → score

<!-- speaker_note: "Multiple trials because output varies each time." -->

<!-- end_slide -->

# Code Example: Translation Eval

```ts {1-5|6-10|11-15}
suite('Translation Eval Suite', () => {
  test({
    report: 'French Translation Task',
    trials: 5,
    data: [
      {
        input: 'Translate "Hello, world!" to French.',
        expected: 'Bonjour le monde!',
        models: [groq('gpt-oss-20b'), lmstudio('qwen3-4b')],
      },
    ],
    graders: [
      exactMatch,      // Identical?
      levenshtein,     // Close enough?
      answerSimilarity // Semantically same?
    ],
  });
});
```

<!-- speaker_note: Walk through each section. Multiple graders = multiple angles. -->

<!-- end_slide -->

# Graders (aka Scorers)

<!-- column_layout: [1, 1] -->

<!-- column: 0 -->

## String Scorers

_No AI required_

| Scorer | Use |
|--------|-----|
| `exactMatch` | Identical strings |
| `contains` | Substring check |
| `levenshtein` | Fuzzy matching |

<!-- column: 1 -->

## AI Scorers

_Embeddings/LLM required_

| Scorer | Use |
|--------|-----|
| `answerSimilarity` | Semantic match |
| `faithfulness` | Hallucination check |
| `toolCallAccuracy` | Agent tools |

<!-- reset_layout -->

<!-- pause -->

**LLM-as-Judge**: When programmatic scoring isn't enough

<!-- speaker_note: "Use stronger model as judge than the one being evaluated." -->

<!-- end_slide -->

# The Dataset Challenge

> The hardest part of evals: creating a good dataset.

<!-- pause -->

**Seed Data Sources:**

<!-- incremental_lists: true -->

1. **Stakeholder input** — Talk to users, domain experts
2. **Real interactions** — Production logs, beta users
3. **Reasoning traces** — Chain-of-thought from o1, o3
4. **Agent conversations** — Simulate user behavior
5. **Synthetic generation** — LLM-generated + human review

<!-- speaker_note: "You need real-world diversity." -->

<!-- end_slide -->

# Dataset Augmentation

**Paraphrasing**

```
"Show me all orders" → "List every order" → "What orders do we have?"
```

<!-- pause -->

**Back-translation**

```
"Show top customers" → (Spanish) → "Display the best clients"
```

<!-- pause -->

**Noise injection**

```
"Show me the ordres from last mnth"  // typos
"Get me sales numbers for q4"         // informal
```

<!-- speaker_note: "Expand seed data to cover real-world messiness." -->

<!-- end_slide -->

# Coverage Strategy: Evol-Instruct

<!-- column_layout: [1, 1] -->

<!-- column: 0 -->

## Breadth

Cover different domains:

- Orders
- Customers
- Products
- Inventory
- Shipping
- Returns

<!-- column: 1 -->

## Depth

Increase complexity:

**Simple:**
"How many orders?"

**Medium:**
"Orders by month for 2024"

**Complex:**
"Month-over-month growth rate"

**Expert:**
"Rank customers by revenue percentile"

<!-- reset_layout -->

<!-- speaker_note: "Microsoft's Evol-Instruct paper. Breadth × Depth = coverage." -->

<!-- end_slide -->

# Pro Tip: Start Big, Then Shrink

> Build your agent with the **best model first**.

<!-- pause -->

<!-- incremental_lists: true -->

1. Develop with a strong model until evals score well
2. Run same evals on smaller models
3. Observe where they fall short
4. Tweak prompts to close the gap

<!-- pause -->

**Why?** You get a focused set of failures to fix.

<!-- speaker_note: "If you build on small model first, you lose this insight." -->

<!-- end_slide -->

# Key Takeaways

<!-- incremental_lists: true -->

- **Shift your mindset** — From binary testing to spectrum evaluation

- **Structure evals properly** — Suites → Tasks → Trials → Graders

- **Invest in your dataset** — Real-world diversity is everything

<!-- speaker_note: "Three things to remember when you leave this room." -->

<!-- end_slide -->

# Questions?

<!-- jump_to_middle -->

**ezzabuzaid**

<!-- newlines: 2 -->

_"The worst part? They can ask anything, not just what you expected."_

<!-- speaker_note: Call back to the inciting incident. Open for Q&A. -->

<!-- end_slide -->

# Resources

<!-- incremental_lists: true -->

- **Evalite** — evalite.dev
- **Autoevals** — github.com/braintrust-data/autoevals
- **Evol-Instruct Paper** — Microsoft Research
- **OpenAI Evals** — github.com/openai/evals

<!-- pause -->

**Thank you!**
