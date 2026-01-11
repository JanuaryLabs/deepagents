---
name: tech-talk
description: "Design professional technical presentations with effective narrative patterns and visual design. Use when: (1) Creating conference talks or meetup presentations, (2) Designing slide flow and pacing, (3) Balancing code, text, and diagrams, (4) Structuring technical narratives. Triggers on: tech talk, presentation design, slide design, talk structure, conference presentation."
---

# Tech Talk Design

Design professional technical presentations. This skill covers **storytelling** (the foundation), **narrative patterns** (how to structure your talk), and **visual design** (how to design your slides).

## The Foundation: Story First

```
// THE TRUTH ABOUT TECH TALKS
audience.remembers = {
  facts:    10%,    // specs, syntax, details
  stories:  65%,    // narratives, journeys
  feelings: 90%     // how you made them feel
}

// EVERY TALK IS A STORY
talk != information_transfer
talk == emotional_journey(struggle → insight → transformation)

// FIND YOUR STORY
story = {
  struggle:   "What problem did you face?",
  journey:    "What did you try? What failed?",
  turning:    "What was the breakthrough?",
  change:     "How are things different now?"
}

// EVEN "BORING" TOPICS HAVE STORIES
api_docs    → "The time we couldn't find what we needed"
refactoring → "The codebase that fought back"
performance → "The 3am wake-up call"
```

See [references/storytelling.md](references/storytelling.md) for narrative techniques in depth.

## Quick Start

```
// MINIMAL VIABLE TALK
talk = {
  hook:       grab_attention(30_seconds),
  problem:    why_should_they_care(),
  solution:   your_approach(),
  demo:       show_dont_tell(),
  takeaways:  what_they_learned()
}

// SLIDE COUNT RULE
slides_per_minute = 1..2
talk_20_min = slides(20..40)
```

## Talk Patterns

### Pattern 1: Problem → Solution → Demo

```
// MOST COMMON PATTERN
// Good for: feature announcements, library intros, case studies

flow = [
  slide("The Problem"),      // pain point everyone knows
  slide("Why It's Hard"),    // failed attempts, constraints
  <!-- pause -->
  slide("Our Approach"),     // high-level solution
  slide("How It Works"),     // architecture/design
  slides("Demo"),            // live or recorded
  slide("Results"),          // metrics, outcomes
  slide("Try It")            // call to action
]
```

### Pattern 2: Demo Sandwich

```
// DEMO-CENTRIC PATTERN
// Good for: tool demos, workflow presentations, tutorials

flow = [
  slide("Watch This"),       // immediate demo hook
  <!-- pause -->
  slide("What Just Happened"), // explain what they saw
  slide("Under The Hood"),   // how it works
  slide("Let's Build One"),  // deeper demo
  slide("Key Concepts"),     // reinforce learning
  slide("Your Turn")         // next steps
]
```

### Pattern 3: Story Arc

```
// NARRATIVE PATTERN
// Good for: war stories, postmortems, journey talks

flow = [
  hook:       "We were losing $10k/day..."
  tension:    "Every fix made it worse..."
  discovery:  "Then we found the real problem..."
  resolution: "Here's how we fixed it..."
  lesson:     "What we learned..."
]

// USE: personal stories, emotions, specific details
// AVOID: abstract, generic, sanitized narratives
```

### Pattern 4: Tutorial Flow

```
// TEACHING PATTERN
// Good for: workshops, educational talks, onboarding

for each concept in [basic, intermediate, advanced]:
  explain(concept)           // what is it?
  show(example)              // code or diagram
  <!-- pause -->
  practice(exercise)         // audience tries it
  reinforce(key_points)      // summarize

// RULE: one concept per section
// ANTI-PATTERN: concept1 + concept2 + concept3 → overwhelm
```

## Visual Design Rules

### Slide Density

```
// MAXIMUM CONTENT PER SLIDE
slide.constraints = {
  text_lines:     max(7),
  bullet_points:  max(5),
  code_lines:     max(15),
  words_total:    max(40)
}

if content > slide.constraints:
  action = split_into_slides()
  // NEVER: shrink_font()
  // NEVER: cram_more_text()
```

### Code-to-Text Ratio

```
// CODE SLIDES
code_slide = {
  code:        80%,    // the star of the show
  explanation: 20%     // one-line context
}

// CONCEPT SLIDES
concept_slide = {
  text:    60%,
  visual:  40%    // diagram, image, or whitespace
}

// ANTI-PATTERN
bad_slide = {
  code:    50%,
  text:    50%     // competing for attention
}
```

### Visual Hierarchy

```
// ATTENTION FLOW
slide.hierarchy = [
  title,              // what is this slide about?
  main_content,       // the ONE thing to focus on
  supporting_detail   // optional, secondary
]

// RULE: one focus per slide
if slide.has(code) && slide.has(diagram):
  split_into_two_slides()

// PRESENTERM TIP
<!-- column_layout: [2, 1] -->  // main content left, notes right
```

## Pacing & Reveal

### When to Pause

```
// USE <!-- pause --> FOR:
pause_moments = [
  after(problem_statement),     // let it sink in
  before(solution_reveal),      // build anticipation
  after(surprising_result),     // moment of impact
  between(major_sections)       // mental reset
]

// DON'T PAUSE:
no_pause = [
  between_every_bullet,         // too choppy
  mid_code_block,               // breaks context
  rapid_fire_facts              // kills momentum
]
```

### Progressive Code Reveal

```python {1-2|3-5|6-8} +line_numbers
// STAGE 1: Setup
config = load()

// STAGE 2: Core logic
result = process(config)
validate(result)

// STAGE 3: Output
save(result)
notify(user)
```

```
// WHEN TO USE PROGRESSIVE REVEAL:
use_progressive_reveal = [
  complex_algorithms,        // step by step
  before_after_comparisons,  // show transformation
  building_up_concepts       // layered learning
]

// PRESENTERM SYNTAX:
// ```python {1-2|3-5|6-8}  ← reveals in 3 stages
```

## Slide Archetypes

### Title Slide

```
<!-- jump_to_middle -->
<!-- alignment: center -->

# Talk Title
## Subtitle or Hook

Author Name
@handle
```

### Code Slide

```
// STRUCTURE
slide = [
  heading:     "What this code does",  // 1 line
  code_block:  actual_code,            // 10-15 lines max
  callout:     "← key line"            // optional highlight
]

// PRESENTERM: use {line_numbers} to highlight
```python {3,7} +line_numbers
```

### Diagram Slide

```
// STRUCTURE
slide = [
  heading:  "System Architecture",
  diagram:  mermaid_or_d2,            // centered, 60-80% width
  caption:  optional_one_liner
]

// PRESENTERM:
```mermaid +render +width:70%
```

### Summary Slide

```
<!-- incremental_lists: true -->

// STRUCTURE: 3-5 key takeaways
takeaways = [
  "Takeaway 1: most important",
  "Takeaway 2: second most",
  "Takeaway 3: actionable next step"
]

// PRESENTERM: use incremental_lists for reveal
```

## Anti-Patterns

```
// DON'T DO THIS

wall_of_text = slide(paragraphs: 5)
// → Split into multiple slides

tiny_font = slide(code_lines: 50)
// → Extract key lines only

bullet_hell = slide(bullets: 12)
// → Group into 2-3 categories

competing_focus = slide(code + diagram + text)
// → One focus per slide

no_breathing_room = slides(dense, dense, dense)
// → Add spacer slides, use <!-- newlines: 2 -->
```

## Templates

Ready-to-use templates in [assets/templates/](assets/templates/):

- `problem-solution.md` - Standard tech talk structure
- `demo-sandwich.md` - Demo-centric presentation
- `tutorial.md` - Teaching/workshop format

## Detailed References

- [references/storytelling.md](references/storytelling.md) - Narrative techniques, emotional arcs, hooks
- [references/patterns.md](references/patterns.md) - Talk structure patterns in depth
- [references/visual-design.md](references/visual-design.md) - Slide design principles
