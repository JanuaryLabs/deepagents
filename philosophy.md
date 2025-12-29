# Limerence Website Design Philosophy

## Aesthetic Direction

**BRUTALIST TERMINAL EDITORIAL**

The website draws from three design traditions:

- **Editorial magazines** - Bold typography, dramatic white space, confident layouts
- **Terminal interfaces** - Monospace fonts, command-line aesthetic, scanlines
- **Brutalist architecture** - Raw materials, exposed structure, no decoration for decoration's sake

### Anti-patterns (What We Avoid)

- Generic SaaS landing pages with purple gradients
- Rounded corners everywhere
- Safe, boring font choices (Inter, Roboto, Arial)
- Cookie-cutter card layouts
- Excessive whitespace that feels empty rather than intentional

---

## Color System

```css
:root {
  --bg: #050505; /* Near-black background */
  --fg: #fafafa; /* Off-white text */
  --gray: #666666; /* Secondary text, descriptions */
  --gray-dark: #333333; /* Subtle borders, disabled states */
  --coral: #ff4d00; /* Hot coral - primary brand accent */
  --cyan: #00d9ff; /* Secondary accent (use sparingly) */
  --border: rgba(255, 255, 255, 0.15); /* Subtle borders */
}
```

### Color Usage

- **Coral** is the hero color - use for CTAs, highlights, active states, the diamond logo
- **Cyan** appears only as a subtle secondary accent
- High contrast: near-black backgrounds with off-white text
- Gray tones for hierarchy without competing with coral

---

## Typography

### Font Stack

1. **Fraunces** (serif) - Display headlines, massive section titles
   - Bold, dramatic, characterful
   - Used for hero text, section numbers, CTAs

2. **IBM Plex Sans** - Body text
   - Clean, professional, highly legible
   - Used for paragraphs, descriptions, feature lists

3. **IBM Plex Mono** - Technical elements
   - Terminal commands, code, labels, navigation
   - Reinforces the developer/terminal aesthetic

### Special Treatments

- **Outline text** using `-webkit-text-stroke` for massive section numbers
- **Tracking** (letter-spacing) on uppercase labels: `tracking-[0.2em]`
- **Typewriter effect** on hero headline for personality

---

## Visual Elements

### Grain Overlay

A subtle noise texture covers the entire page, adding atmosphere and depth:

```css
.grain {
  background-image: url('data:image/svg+xml,...');
  opacity: 0.03;
}
```

### Terminal Mockups

- Window chrome with red/yellow/green dots
- Optional scanlines for CRT effect
- Monospace content
- No rounded corners

### Scanlines

Applied to terminal mockups for retro-computing feel:

```css
.scanlines::after {
  background: repeating-linear-gradient(
    0deg,
    rgba(0, 0, 0, 0.1) 0px,
    rgba(0, 0, 0, 0.1) 1px,
    transparent 1px,
    transparent 2px
  );
}
```

### Hard Edges

- No `border-radius` on major elements
- Sharp, intentional corners
- Brutalist approach to containers

---

## Page Structure Patterns

### Hero Sections

- Massive headline (Fraunces, bold)
- Subhead in gray monospace
- Clear CTA below

### Feature Sections

- Section number (outline style) on right
- Diamond bullet (◇) with section title
- Description paragraph
- Bullet list of features
- Optional mockup/visualization

### Mockups

- Terminal aesthetic
- Real-looking content
- Bar charts using CSS (not images)
- Conversational flow demonstrations

---

## Implementation Notes

### CSS-in-JS Approach

Styles are embedded via `<style>` tags injected by `websiteStyles` constant:

```tsx
<style>{websiteStyles}</style>
```

This keeps styles colocated with website code without polluting global CSS.

### Responsive Design

- Mobile-first base styles
- `md:` breakpoint for tablet/desktop layouts
- Navigation hidden on mobile (CTA always visible)
- Grid layouts collapse to single column

### Performance

- No external CSS frameworks beyond Tailwind utilities
- SVG grain texture (not image file)
- Font loading via Google Fonts CDN
- Minimal JavaScript (React + scroll observers)

---

## Design Decisions Log

1. **Why Fraunces?** - Bold serif with personality. Stands out from every other SaaS using geometric sans-serifs.

2. **Why Hot Coral (#FF4D00)?** - Energetic, urgent, impossible to ignore. Not the safe blue/purple/green of typical tech.

3. **Why no rounded corners?** - Brutalist commitment. Every SaaS has rounded cards. We don't.

4. **Why grain texture?** - Adds depth and atmosphere without being distracting. Makes the page feel less "digital."

5. **Why terminal aesthetic?** - Our users are developers. The product is about databases and code. The design should feel native to them.
