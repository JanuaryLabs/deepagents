# Visual Design Principles

Detailed reference for designing effective slides.

## Core Principle

```
// THE ONE RULE
slide.focus = exactly(1)

// ONE of these per slide:
focus_types = [
  one_idea,
  one_code_block,
  one_diagram,
  one_quote,
  one_image
]

// ANTI-PATTERN
bad_slide.focus = [code, diagram, bullets]
// → cognitive overload
```

---

## Text Density

### Maximum Limits

```
// HARD LIMITS
text_constraints = {
  lines_per_slide:   max(7),
  words_per_line:    max(12),
  bullets_per_list:  max(5),
  total_words:       max(40)
}

// WHY: audience reads faster than you speak
// If they're reading, they're not listening
```

### Word Economy

```
// BEFORE
verbose = "In order to effectively utilize this feature,
           you will need to first configure the settings"

// AFTER
concise = "Configure settings first"

// RULE: cut words until meaning breaks
```

### Bullet Point Rules

```
// STRUCTURE
bullet_rules = {
  parallel:      true,     // same grammatical structure
  action_verbs:  true,     // start with verbs
  consistent:    true      // same level of detail
}

// GOOD
- Configure the database
- Deploy the service
- Monitor the logs

// BAD
- Database configuration is needed
- Deploy
- You should probably check logs sometimes
```

---

## Code Slides

### Code Length

```
// MAXIMUM LINES
code_length = {
  simple_example:    5..8,    // one concept
  complex_example:   10..15,  // with context
  absolute_max:      20       // never more
}

// IF CODE > 15 LINES:
action = [
  extract_key_section,
  use_ellipsis,          // ... for omitted parts
  split_into_slides
]
```

### Code Highlighting

```
// GUIDE THE EYE
highlight_strategy = {
  single_line:    "← this line",
  key_section:    highlight({3, 7-9}),
  progressive:    reveal({1-3|4-6|7-9})
}

// PRESENTERM SYNTAX:
```python {3,7-9} +line_numbers
code_here()
```

### Code Context

```
// ALWAYS PROVIDE CONTEXT
code_slide = {
  title:    "What this does",     // 1 line
  code:     actual_code,
  callout:  "Key insight"         // optional, 1 line
}

// ANTI-PATTERN
naked_code_slide = {
  title:  "Code",
  code:   what_is_this()
}
// → audience is lost
```

### Syntax Choices

```
// PRESENTERM CODE ATTRIBUTES
+line_numbers     // when referring to specific lines
+exec             // live execution (careful!)
+no_background    // cleaner look sometimes

// HIGHLIGHTING
{1,3,5}           // specific lines
{1-5}             // range
{1-3|4-6}         // progressive reveal
```

---

## Diagrams

### When to Use Diagrams

```
// USE DIAGRAMS FOR:
diagram_use_cases = [
  system_architecture,
  data_flow,
  state_machines,
  relationships,
  comparisons,
  timelines
]

// DON'T USE DIAGRAMS FOR:
not_diagram = [
  simple_lists,        // bullets are fine
  single_relationship, // just say it
  decoration           // wastes attention
]
```

### Diagram Complexity

```
// LIMITS
diagram_constraints = {
  nodes:       max(7),
  connections: max(10),
  labels:      short_only
}

// IF COMPLEX:
complex_diagram → split_into_layers
// Show high-level first, zoom in later
```

### Diagram Sizing

```
// PRESENTERM: control width
```mermaid +render +width:70%
```

// SIZING GUIDE
diagram_width = {
  full_focus:      "80%",
  with_text:       "60%",
  side_by_side:    "45%"
}
```

---

## Layout Patterns

### Single Column (Default)

```
// USE FOR: most slides
<!-- single column is default -->

title
content
content
content
```

### Two Column: Code + Explanation

```
<!-- column_layout: [3, 2] -->

<!-- column: 0 -->
```code
actual_code()
```

<!-- column: 1 -->
## Explanation
- Point 1
- Point 2

// USE FOR: code walkthroughs
```

### Two Column: Comparison

```
<!-- column_layout: [1, 1] -->

<!-- column: 0 -->
### Before
old_approach()

<!-- column: 1 -->
### After
new_approach()

// USE FOR: before/after, option A/B
```

### Centered Content

```
<!-- column_layout: [1, 3, 1] -->
<!-- column: 1 -->
<!-- jump_to_middle -->

# Key Message

// USE FOR: emphasis slides, quotes, key takeaways
```

---

## Visual Hierarchy

### Heading Levels

```
// STRUCTURE
# Slide Title        // what is this about
## Section           // sub-topic
### Detail           // rarely needed

// RULE: max 2 heading levels per slide
```

### Emphasis

```
// MARKDOWN EMPHASIS
**bold**      // key terms, important words
_italic_      // definitions, new concepts
`code`        // inline code, commands

// DON'T: bold entire paragraphs
// DON'T: mix multiple emphasis types
```

### Whitespace

```
// BREATHING ROOM
whitespace_rules = {
  after_heading:     newline,
  between_sections:  newlines(2),
  around_code:       generous
}

// PRESENTERM
<!-- newlines: 2 -->

// ANTI-PATTERN: wall of content with no breaks
```

---

## Pacing Elements

### Pauses

```
// WHEN TO PAUSE
pause_moments = {
  after_problem:     "let it sink in",
  before_solution:   "build anticipation",
  after_key_point:   "moment of impact",
  between_sections:  "mental reset"
}

// PRESENTERM
<!-- pause -->
```

### Progressive Reveal

```
// FOR LISTS
<!-- incremental_lists: true -->
- Point 1
- Point 2
- Point 3

// FOR CODE
```python {1-2|3-4|5-6}

// USE WHEN: building up concepts
// AVOID WHEN: simple information (no drama needed)
```

### Spacer Slides

```
// BETWEEN MAJOR SECTIONS
<!-- jump_to_middle -->
<!-- alignment: center -->

# Part 2: Implementation

// BENEFIT: mental break, clear transition
```

---

## Color & Contrast

### Theme Selection

```
// CHOOSE BASED ON ENVIRONMENT
theme_selection = {
  dark_room:     "catppuccin-mocha",   // projector
  bright_room:   "light",               // screens
  consistency:   "terminal-dark"        // match terminal
}
```

### Color for Meaning

```
// USE SPARINGLY
color_meaning = {
  red:     error, danger, important,
  green:   success, good, go,
  yellow:  warning, attention,
  blue:    info, links, neutral
}

// PRESENTERM: span tags
<span style="color: #ff6b6b">error</span>
<span style="color: #69db7c">success</span>
```

---

## Anti-Patterns Gallery

```
// DON'T DO THESE

wall_of_text:
  "Long paragraphs that go on and on
   making it impossible to follow..."
  → break into bullets, reduce words

tiny_code:
  code_lines: 50
  → extract key section, add ellipsis

bullet_overload:
  bullets: 12
  → group into categories, split slides

competing_elements:
  [code, diagram, bullets, image]
  → one focus per slide

no_context_code:
  code without explanation
  → add title + one-line callout

decoration_diagrams:
  diagram that adds no information
  → remove or replace with text

monotone_pacing:
  slide, slide, slide, slide (same density)
  → vary: dense → spacer → dense → visual
```
