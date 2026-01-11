# Talk Structure Patterns

Detailed reference for structuring technical presentations.

## Pattern Selection Guide

```
// CHOOSE BASED ON GOAL
select_pattern(goal) = {
  "announce_feature":    problem_solution,
  "show_tool":           demo_sandwich,
  "share_experience":    story_arc,
  "teach_concept":       tutorial_flow,
  "compare_options":     comparison,
  "deep_dive":           layered_depth
}
```

---

## Problem → Solution → Demo

```
// STRUCTURE (20-30 min talk)
sections = {
  hook:         1 slide,    // 1 min
  problem:      3 slides,   // 3 min
  solution:     4 slides,   // 5 min
  demo:         5 slides,   // 8 min
  results:      2 slides,   // 3 min
  wrapup:       2 slides    // 2 min
}
```

### Hook

```
// GRAB ATTENTION IMMEDIATELY
hook_types = [
  surprising_stat:   "90% of deploys fail silently",
  pain_point:        "Ever spent 3 hours debugging...",
  bold_claim:        "You don't need Kubernetes",
  question:          "What if tests wrote themselves?"
]

// ANTI-PATTERN
bad_hook = "Today I'll talk about..."
// → boring, no tension
```

### Problem Section

```
// BUILD EMPATHY
problem_slides = [
  slide_1: "The common scenario",     // relatable situation
  slide_2: "Why current solutions fail",
  slide_3: "The real cost"            // time, money, frustration
]

// TIP: use real numbers, real stories
// "We wasted 2 weeks" > "It takes a long time"
```

### Solution Section

```
// REVEAL GRADUALLY
solution_slides = [
  slide_1: "High-level approach",     // one sentence
  <!-- pause -->
  slide_2: "Key insight",             // what makes it work
  slide_3: "Architecture",            // diagram
  slide_4: "How to use it"            // code snippet
]

// DON'T: dump all features at once
// DO: build understanding layer by layer
```

### Demo Section

```
// SHOW, DON'T TELL
demo_structure = {
  setup:     "Here's a real project...",
  action:    "Watch what happens when...",
  result:    "And now we have...",
  variation: "What if we change..."
}

// PRESENTERM: use +exec for live code
```python +exec
result = your_tool.run()
print(result)
```

---

## Demo Sandwich

```
// STRUCTURE
// Demo first, explain later

flow = [
  cold_open_demo,      // "watch this" (2 min)
  explanation,         // "here's what happened" (5 min)
  deep_demo,           // "let's build one" (10 min)
  concepts,            // "key ideas" (5 min)
  call_to_action       // "try it yourself" (2 min)
]
```

### Cold Open Demo

```
// START WITH IMPACT
cold_open = {
  setup:   minimal,           // no context needed
  demo:    impressive_result, // "wow" moment
  cliffhanger: "How did that work?"
}

// ANTI-PATTERN
bad_cold_open = explain(15_minutes) → demo
// → audience asleep before demo
```

### Explanation Section

```
// NOW THEY WANT TO KNOW
explain_after_demo = [
  "What you just saw",
  "The key components",
  "Why it works this way"
]

// ADVANTAGE: audience is curious, engaged
// They're asking "how?" not "why should I care?"
```

---

## Story Arc

```
// NARRATIVE STRUCTURE
story = {
  status_quo:    "Everything was fine...",
  inciting:      "Then this happened...",
  rising:        "We tried X, Y, Z...",
  climax:        "The breakthrough moment...",
  resolution:    "Here's where we landed...",
  lesson:        "What we learned..."
}
```

### Emotional Beats

```
// ENGAGE EMOTIONS
emotional_journey = [
  {point: "status_quo",  emotion: "comfortable"},
  {point: "inciting",    emotion: "anxious"},
  {point: "rising",      emotion: "frustrated"},
  {point: "climax",      emotion: "excited"},
  {point: "resolution",  emotion: "satisfied"},
  {point: "lesson",      emotion: "empowered"}
]

// TIP: be specific, be vulnerable
// "I felt stupid" > "It was challenging"
```

### War Story Format

```
// POSTMORTEM / INCIDENT TALK
war_story = [
  "2am. PagerDuty goes off.",
  "Dashboard shows 0 requests.",
  "We checked X. Nothing.",
  "We checked Y. Nothing.",
  <!-- pause -->
  "Then someone noticed...",
  "The fix took 5 minutes.",
  "Here's what we changed."
]
```

---

## Tutorial Flow

```
// TEACHING STRUCTURE
tutorial = {
  for_each(concept):
    explain:   "What is X?",
    show:      "Here's X in action",
    practice:  "Now you try X",
    reinforce: "Key points about X"
}
```

### Concept Layering

```
// BUILD UNDERSTANDING
layers = [
  layer_1: "Basic usage",           // everyone can follow
  layer_2: "Common patterns",       // intermediate
  layer_3: "Advanced techniques"    // power users
]

// RULE: each layer stands alone
// If someone leaves at layer_1, they still learned something
```

### Interactive Elements

```
// KEEP AUDIENCE ENGAGED
interactive = [
  poll:        "Who has used X before?",
  prediction:  "What do you think happens?",
  exercise:    "Try this in your terminal",
  question:    "Any questions before we continue?"
]

// TIMING: interactive moment every 5-7 minutes
```

---

## Comparison Pattern

```
// STRUCTURE: when comparing options
comparison = [
  slide: "The decision we face",
  slide: "Option A: approach + tradeoffs",
  slide: "Option B: approach + tradeoffs",
  slide: "Side-by-side comparison",
  slide: "When to use each",
  slide: "Our recommendation"
]
```

### Fair Comparison

```
// BE HONEST
comparison_rules = {
  show_tradeoffs:  true,    // nothing is perfect
  acknowledge_fit: true,    // "depends on your needs"
  avoid_strawman:  true     // strongest version of each
}

// ANTI-PATTERN
bad_comparison = {
  option_a: [all_positives],
  option_b: [all_negatives]
}
// → audience doesn't trust you
```

---

## Layered Depth

```
// STRUCTURE: for deep technical talks
layers = [
  surface:   "What it does (everyone)",       // 5 min
  mechanics: "How it works (most)",           // 10 min
  internals: "Why it works this way (some)",  // 10 min
  bleeding:  "Future directions (few)"        // 5 min
]

// BENEFIT: multiple audience levels served
// EACH LAYER: could be a standalone talk
```

### Signposting

```
// TELL THEM WHERE THEY ARE
signpost_phrases = [
  "Now we're going deeper into...",
  "If you only remember one thing...",
  "For those who want more detail...",
  "Coming back to the high level..."
]

// PRESENTERM: use different heading levels
# High Level (h1)
## Mid Level (h2)
### Deep Dive (h3)
```
