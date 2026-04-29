---
name: reuse
description: Analyze a target piece of code and propose how to make it reusable across the rest of the codebase. Walks through phases — understand → survey → design → migration plan — and only edits code after the user approves the plan. Codebase-agnostic. Run only when the user explicitly invokes it (e.g. `/reuse`, "make this reusable", "extract this", "find duplicates of this").
---

# Reuse

Take a target chunk of code (a file, function, class, or directory) and figure out how to lift it into something the rest of the codebase can share. Codebase-agnostic — no project-specific assumptions.

## When to use

Only when the user explicitly invokes this skill. Do not auto-trigger on edits, refactors, or "this looks duplicated" observations during unrelated work.

## Inputs to confirm before starting

- **Target**: which file/function/module is the subject. If ambiguous, ask.
- **Search scope**: whole repo, a workspace, or a specific subtree. Default to the whole repo if unspecified.
- **Goal**: survey-only, extraction (move to a shared location), or generalization (rewrite to fit more callers). Default: survey + plan, no edits, until user approves.

## Phases

Run in order. Each phase informs the next — skipping ahead produces abstractions that break on real call sites. Track progress in a TodoList so the user can see where you are.

### Phase 1 — Understand the target

Read the target code closely. In your response, briefly capture:

- **Purpose**: one sentence on what it does.
- **Inputs / outputs**: signature, return shape, side effects.
- **Dependencies**: imports, framework coupling (ORM, HTTP client, DI container, file system, etc.).
- **Implicit assumptions**: things the code expects that aren't in the signature — env vars, ambient state, ordering, caller-managed lifecycle.

This is what makes the rest of the work non-superficial. The implicit assumptions are usually what kill a naive extraction.

### Phase 2 — Survey the codebase

Find places that look like the target. Search for, in roughly this order:

- **Verbatim duplication**: copy-pasted blocks. Grep distinctive identifiers, error strings, or constants from the target.
- **Near-duplicates**: same shape, different names. Search by signature fragments, distinctive control flow, or unusual literals.
- **Conceptual duplicates**: same problem solved differently. Search by domain terms (e.g. "retry", "format cursor", "parse range").
- **Existing shared utils**: check whether the codebase already solves this. Look in `lib/`, `utils/`, `shared/`, package roots, and any conventional "common" location for the language/framework.

Report findings as a list: location (`file:line`), kind (verbatim / near / conceptual / existing util), and a one-line snippet or description.

If a suitable existing util is found, **stop and propose using it** rather than building a new one. That is usually the better outcome and worth surfacing immediately.

### Phase 3 — Design the abstraction

Only run this phase if Phase 2 didn't already resolve the problem. Propose:

- **Where it lives**: which package / directory. Justify briefly via proximity to callers, dependency direction, and existing conventions.
- **Signature**: the new public API as a code block.
- **What stays caller-specific**: parts that don't generalize — pass them in as parameters, callbacks, or config rather than baking them in.
- **What it does _not_ do**: name the temptations you're rejecting (e.g. "not adding a plugin system; callers can wrap it themselves").

Aim for the smallest abstraction that absorbs the duplication. A shared helper beats a framework. If the right answer is "leave it duplicated for now because the three sites are diverging," say so — premature consolidation is worse than duplication.

### Phase 4 — Migration plan

For each call site found in Phase 2, list:

- The exact change (replace with import, adjust args, delete local copy).
- Any behavior difference the migration introduces (different log format, different error type, different default).
- Test coverage: existing tests that exercise this path, and whether new tests are needed for the shared util.

Surface risks explicitly: shared mutable state, ordering assumptions, public API changes, tests that import the old path.

### Phase 5 — Execute (only after the user approves the plan)

1. Create the shared module first, with tests.
2. Migrate one call site, run its tests, confirm green.
3. Migrate the rest.
4. Delete the original duplicates last.

Narrate as you go (one short line per call site migrated), not a wall of text up front. If anything goes sideways mid-migration, stop and re-plan rather than pushing through.

## Output format

For phases 1–4, respond with sections that match the phase headings. Keep each section tight — the user wants to skim and decide. Use code blocks for signatures and snippets, lists for survey results.

For phase 5, edit incrementally and report each step as it happens.

## Anti-patterns

- **Designing before surveying.** The shape of the abstraction comes from the _callers_. If you've drafted a signature before reading the call sites, you're guessing.
- **Framework when a helper would do.** A registry / plugin system / strategy class to absorb three call sites is over-shot. Ship the function, ship later.
- **Rename during extract.** Move first, rename in a separate step — keeps diffs reviewable.
- **Silent migration.** Each call-site change should be visible in the conversation so the user can stop you mid-way.
- **Ignoring the existing util.** Always check if the codebase already has it before drafting a new one.
