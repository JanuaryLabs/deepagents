# Presenterm Syntax Reference

Complete reference for all presenterm markdown syntax and features.

## Table of Contents

1. [Front Matter](#front-matter)
2. [All Comment Commands](#all-comment-commands)
3. [Code Block Attributes](#code-block-attributes)
4. [Theme Configuration](#theme-configuration)
5. [Custom Theme Definition](#custom-theme-definition)
6. [Text Styling](#text-styling)
7. [Slide Transitions](#slide-transitions)

---

## Front Matter

YAML front matter at the start of the presentation:

```yaml
---
title: "Presentation Title"
sub_title: "Optional Subtitle"
author: Single Author
# OR for multiple authors:
authors:
  - Author One
  - Author Two

theme:
  name: catppuccin-mocha  # Use built-in theme
  # OR
  path: /path/to/custom.yaml  # Use custom theme file

  # Optional overrides
  override:
    default:
      margin:
        percent: 5
      colors:
        foreground: "ffffff"
        background: "000000"
---
```

## All Comment Commands

### Slide Structure

| Command | Syntax | Description |
|---------|--------|-------------|
| End slide | `<!-- end_slide -->` | Marks slide boundary |
| Skip slide | `<!-- skip_slide -->` | Excludes slide from presentation |
| Include file | `<!-- include: path/to/file.md -->` | Embeds external markdown |

### Content Display

| Command | Syntax | Description |
|---------|--------|-------------|
| Pause | `<!-- pause -->` | Progressive content reveal |
| Jump to middle | `<!-- jump_to_middle -->` | Center content vertically |
| New line | `<!-- newline -->` | Add single blank line |
| New lines | `<!-- newlines: N -->` | Add N blank lines |
| Font size | `<!-- font_size: N -->` | Set font 1-7 (kitty 0.40.0+) |
| Alignment | `<!-- alignment: left/center/right -->` | Text alignment |
| No footer | `<!-- no_footer -->` | Hide footer on this slide |

### Lists

| Command | Syntax | Description |
|---------|--------|-------------|
| Incremental | `<!-- incremental_lists: true -->` | Reveal list items one at a time |
| List spacing | `<!-- list_item_newlines: 2 -->` | Add spacing between items |

### Layout

| Command | Syntax | Description |
|---------|--------|-------------|
| Column layout | `<!-- column_layout: [1, 2, 1] -->` | Define column proportions |
| Column | `<!-- column: 0 -->` | Switch to column (0-indexed) |
| Reset layout | `<!-- reset_layout -->` | Return to full width |

### Code Output

| Command | Syntax | Description |
|---------|--------|-------------|
| Snippet output | `<!-- snippet_output: id -->` | Display code output elsewhere |

### Speaker Notes

```markdown
<!-- speaker_note: Single line note -->

<!--
speaker_note: |
  Multi-line speaker note.
  Second line of note.
-->
```

## Code Block Attributes

### Basic Syntax

````markdown
```language +attribute1 +attribute2 {line_spec}
code here
```
````

### All Attributes

| Attribute | Description |
|-----------|-------------|
| `+line_numbers` | Display line numbers |
| `+no_background` | Remove code block background |
| `+exec` | Mark as executable (Ctrl+E to run) |
| `+exec_replace` | Auto-execute and replace with output |
| `+validate` | Validate without making executable |
| `+expect:failure` | Mark as expected to fail |
| `+image` | Render output as image |
| `+acquire_terminal` | Give raw terminal access |
| `+render` | Render code as image (mermaid/latex/typst/d2) |
| `+width:N%` | Set rendered image width |
| `+id:name` | Assign ID for snippet_output reference |

### Line Highlighting

```markdown
{1}           # Single line
{1,3,5}       # Multiple lines
{1-5}         # Range
{1,3-5,7}     # Mixed
{1-3|4-6}     # Progressive (first show 1-3, then 4-6)
```

### Hidden Lines

Language-specific prefixes hide lines from display but include in execution:

| Language | Prefix |
|----------|--------|
| Rust | `#` (single `#` at line start) |
| Python, Bash, Go, others | `///` |

### External File Inclusion

````markdown
```file
path: src/example.rs
language: rust
start_line: 10
end_line: 25
```
````

## Theme Configuration

### Built-in Themes

| Theme | Description |
|-------|-------------|
| `dark` | Dark background |
| `light` | Light background |
| `catppuccin-latte` | Catppuccin light variant |
| `catppuccin-frappe` | Catppuccin medium-light |
| `catppuccin-macchiato` | Catppuccin medium-dark |
| `catppuccin-mocha` | Catppuccin dark variant |
| `gruvbox-dark` | Gruvbox-inspired dark |
| `tokyonight-storm` | Tokyo Night-inspired |
| `terminal-dark` | Inherit terminal colors (dark) |
| `terminal-light` | Inherit terminal colors (light) |

### Apply via Front Matter

```yaml
theme:
  name: catppuccin-mocha
```

### Apply via CLI

```bash
presenterm --theme catppuccin-mocha presentation.md
```

### List Available Themes

```bash
presenterm --list-themes
```

## Custom Theme Definition

Create `.yaml` files in `~/.config/presenterm/themes/`:

```yaml
# Extend existing theme (optional)
extends: dark

# Default styles
default:
  margin:
    percent: 8
  colors:
    foreground: "e6e6e6"
    background: "040312"

# Headings
headings:
  h1:
    prefix: "# "
    colors:
      foreground: "rgb_(48,133,195)"
  h2:
    prefix: "## "
    colors:
      foreground: "89b4fa"

# Slide title styling
slide_title:
  padding_top: 2
  padding_bottom: 1
  separator: true

# Intro slide
intro_slide:
  title:
    alignment: center
    colors:
      foreground: "cdd6f4"
  author:
    alignment: center
    colors:
      foreground: "6c7086"

# Code blocks
code:
  theme_name: "base16-ocean.dark"
  padding:
    horizontal: 2
    vertical: 1

# Footer options
footer:
  style: template
  left: "{current_slide} / {total_slides}"
  center: ""
  right: "{author}"

# OR progress bar footer:
# footer:
#   style: progress_bar
#   character: "━"

# OR empty footer:
# footer:
#   style: empty

# Color palette (reusable)
palette:
  colors:
    primary: "89b4fa"
    accent: "f38ba8"
  classes:
    highlight:
      foreground: "f38ba8"
      background: "1e1e2e"

# Mermaid diagram styling
mermaid:
  background: "transparent"
  theme: dark
  scale: 2

# D2 diagram styling
d2:
  theme: 200
  scale: 1

# Typst/LaTeX styling
typst:
  ppi: 400
  colors:
    background: "040312"
    foreground: "e6e6e6"
```

## Text Styling

### Colored Text (span tags only)

```markdown
<span style="color: #ff0000">Red text</span>
<span style="color: red; background-color: yellow">Highlighted</span>

<!-- Using palette classes defined in theme -->
<span class="highlight">Themed highlight</span>
```

### Supported Styles

- `color` - Text color
- `background-color` - Background color

Colors: hex (`#rrggbb`), named (`red`), or `palette:name`

### Using Palette Colors

In theme:
```yaml
palette:
  colors:
    brand: "89b4fa"
```

In markdown:
```markdown
<span style="color: palette:brand">Brand colored text</span>
```

## Slide Transitions

Configure in settings or theme:

```yaml
transitions:
  style: fade        # fade | slide_horizontal | collapse_horizontal
  duration_ms: 300
```

Or apply per-presentation in front matter:

```yaml
---
transitions:
  style: slide_horizontal
---
```

## CLI Quick Reference

| Command | Description |
|---------|-------------|
| `presenterm file.md` | Run presentation |
| `presenterm -x file.md` | Enable code execution |
| `presenterm -X file.md` | Enable exec_replace |
| `presenterm --theme NAME file.md` | Use specific theme |
| `presenterm --export-pdf file.md` | Export to PDF |
| `presenterm --export-html file.md` | Export to HTML |
| `presenterm --list-themes` | Show available themes |
| `presenterm --list-comment-commands` | Show all commands |
| `presenterm --validate-snippets file.md` | Validate executable code |
| `presenterm --publish-speaker-notes file.md` | Main + publish notes |
| `presenterm --listen-speaker-notes file.md` | Listen for notes only |
